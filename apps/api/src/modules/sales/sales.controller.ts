import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { CancelSaleDto, CreateSaleDto, HoldSaleDto, ListSalesDto } from './dto/sales.dto';
import { HeldSalesService } from './held-sales.service';
import { SalesService } from './sales.service';

@ApiTags('Ventas')
@Controller('sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly held: HeldSalesService,
  ) {}

  @Post()
  @RequirePermission(PERMISSIONS.SALE_CREATE)
  @ApiOperation({ summary: 'Registrar una venta y cobrarla' })
  create(@Body() dto: CreateSaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.sales.create(dto, actor);
  }

  @Get()
  @RequirePermission(PERMISSIONS.SALE_VIEW)
  @ApiOperation({ summary: 'Historial de ventas' })
  list(@Query() query: ListSalesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.sales.list(query, actor);
  }

  // ── Ventas en espera ── (antes de ':id' para que no las capture esa ruta)
  @Get('held')
  @RequirePermission(PERMISSIONS.SALE_CREATE)
  @ApiOperation({ summary: 'Tickets en espera de la sucursal' })
  listHeld(@CurrentUser() actor: AuthenticatedUser) {
    return this.held.list(actor);
  }

  @Post('held')
  @RequirePermission(PERMISSIONS.SALE_HOLD)
  @ApiOperation({ summary: 'Poner un ticket en espera' })
  hold(@Body() dto: HoldSaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.held.hold(dto, actor);
  }

  @Post('held/:id/resume')
  @RequirePermission(PERMISSIONS.SALE_CREATE)
  @ApiOperation({ summary: 'Recuperar un ticket en espera (lo retira de la lista)' })
  resume(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.held.resume(id, actor);
  }

  @Delete('held/:id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.SALE_CREATE)
  @ApiOperation({ summary: 'Descartar un ticket en espera' })
  discard(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.held.discard(id, actor);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.SALE_VIEW)
  @ApiOperation({ summary: 'Detalle de una venta' })
  findOne(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.sales.findOne(id, actor);
  }

  /**
   * Sin `@RequirePermission`: quien no tiene `sale.cancel` todavía puede
   * cancelar con el PIN de un supervisor. El servicio decide.
   */
  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.SALE_VIEW)
  @ApiOperation({ summary: 'Cancelar una venta del turno en curso' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelSaleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sales.cancel(id, dto, actor);
  }
}
