import { Body, Controller, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public, RequirePermission } from '../auth/decorators/permissions.decorator';
import { SupportService } from './support.service';

export class CreateTicketDto {
  @ApiProperty({ enum: ['SUPPORT', 'SALES', 'CONTACT'] })
  @IsIn(['SUPPORT', 'SALES', 'CONTACT'])
  kind!: 'SUPPORT' | 'SALES' | 'CONTACT';

  @ApiProperty() @IsString() @Length(2, 120) name!: string;
  @ApiProperty() @IsEmail() @MaxLength(200) email!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) company?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) plan?: string;
  @ApiProperty() @IsString() @Length(3, 160) subject!: string;
  @ApiProperty() @IsString() @Length(10, 5000) message!: string;

  /** Trampa para bots: un humano nunca ve ni llena este campo. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class UpdateTicketDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'IN_PROGRESS', 'ANSWERED', 'CLOSED'] })
  @IsOptional() @IsIn(['OPEN', 'IN_PROGRESS', 'ANSWERED', 'CLOSED'])
  status?: string;

  @ApiPropertyOptional({ enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] })
  @IsOptional() @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(5000) answer?: string;
}

@ApiTags('Soporte')
@Controller()
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Public()
  @Post('public/support-tickets')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Página web: abrir un ticket de soporte, ventas o contacto' })
  create(@Body() dto: CreateTicketDto, @Ip() ip: string) {
    return this.support.create(dto, ip);
  }

  @Public()
  @Get('public/support-tickets/:folio')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Página web: consultar el estado de un ticket (folio + correo)' })
  track(@Param('folio') folio: string, @Query('email') email: string) {
    return this.support.track(folio, email ?? '');
  }

  @Get('support-tickets')
  @RequirePermission(PERMISSIONS.SUPPORT_MANAGE)
  @ApiOperation({ summary: 'Bandeja de tickets' })
  list(@Query('status') status?: string) {
    return this.support.list(status);
  }

  @Patch('support-tickets/:id')
  @RequirePermission(PERMISSIONS.SUPPORT_MANAGE)
  @ApiOperation({ summary: 'Atender un ticket' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.update(id, dto, actor);
  }
}
