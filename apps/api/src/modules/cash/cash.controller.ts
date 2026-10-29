import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { CashService } from './cash.service';
import {
  CloseSessionDto,
  CreateMovementDto,
  CurrentSessionDto,
  ListSessionsDto,
  OpenSessionDto,
} from './dto/cash.dto';

@ApiTags('Caja')
@Controller('cash')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Get('current')
  @RequirePermission(PERMISSIONS.CASH_REPORT_X)
  @ApiOperation({ summary: 'Sesión de caja abierta en esta terminal' })
  current(@Query() query: CurrentSessionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cash.current(actor, query);
  }

  @Get('sessions')
  @RequirePermission(PERMISSIONS.CASH_REPORT_Z)
  @ApiOperation({ summary: 'Historial de cortes de caja' })
  list(@Query() query: ListSessionsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cash.list(query, actor);
  }

  @Get('sessions/:id')
  @RequirePermission(PERMISSIONS.CASH_REPORT_X)
  @ApiOperation({ summary: 'Corte X/Z de una sesión' })
  findOne(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.cash.findOne(id, actor);
  }

  @Post('open')
  @RequirePermission(PERMISSIONS.CASH_OPEN)
  @ApiOperation({ summary: 'Abrir caja con fondo inicial' })
  open(@Body() dto: OpenSessionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cash.open(dto, actor);
  }

  @Post('movements')
  @RequirePermission(PERMISSIONS.CASH_MOVEMENT_CREATE)
  @ApiOperation({ summary: 'Entrada o salida de efectivo' })
  createMovement(@Body() dto: CreateMovementDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cash.createMovement(dto, actor);
  }

  @Post('close')
  @RequirePermission(PERMISSIONS.CASH_CLOSE)
  @ApiOperation({ summary: 'Cerrar caja con arqueo' })
  close(@Body() dto: CloseSessionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cash.close(dto, actor);
  }
}
