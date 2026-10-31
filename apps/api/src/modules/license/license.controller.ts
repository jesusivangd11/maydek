import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { LicenseService } from './license.service';

export class ActivateLicenseDto {
  @ApiProperty({ example: 'MAYDEK1.eyJ2IjoxLC4uLn0.firma' })
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  token!: string;
}

@ApiTags('Licencia')
@Controller('license')
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  /** Cualquier sesión la lee: la caja y el panel muestran avisos de prueba o vencimiento. */
  @Get()
  @ApiOperation({ summary: 'Estado de la licencia' })
  status() {
    return this.license.status();
  }

  @Put()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Activar una licencia' })
  activate(@Body() dto: ActivateLicenseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.license.activate(dto.token, actor);
  }
}
