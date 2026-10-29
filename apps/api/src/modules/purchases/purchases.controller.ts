import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import {
  CreatePurchaseOrderDto,
  CreateReceiptDto,
  ListPurchaseOrdersDto,
  UpsertSupplierDto,
} from './dto/purchases.dto';
import { PurchasesService } from './purchases.service';

@ApiTags('Compras')
@Controller()
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  // ── Proveedores ──
  @Get('suppliers')
  @RequirePermission(PERMISSIONS.SUPPLIER_VIEW)
  @ApiOperation({ summary: 'Proveedores' })
  suppliers(@Query('search') search?: string, @Query('includeInactive') inactive?: string) {
    return this.purchases.listSuppliers(search, inactive === 'true');
  }

  @Post('suppliers')
  @RequirePermission(PERMISSIONS.SUPPLIER_MANAGE)
  @ApiOperation({ summary: 'Alta de proveedor' })
  createSupplier(@Body() dto: UpsertSupplierDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.purchases.upsertSupplier(null, dto, actor);
  }

  @Patch('suppliers/:id')
  @RequirePermission(PERMISSIONS.SUPPLIER_MANAGE)
  @ApiOperation({ summary: 'Editar proveedor' })
  updateSupplier(
    @Param('id') id: string,
    @Body() dto: UpsertSupplierDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.purchases.upsertSupplier(id, dto, actor);
  }

  @Get('variants/:id/cost-history')
  @RequirePermission(PERMISSIONS.PRODUCT_COST_VIEW)
  @ApiOperation({ summary: 'Historial de costos por proveedor' })
  costHistory(@Param('id') id: string) {
    return this.purchases.costHistory(id);
  }

  // ── Órdenes de compra ──
  @Get('purchase-orders')
  @RequirePermission(PERMISSIONS.PURCHASE_VIEW)
  @ApiOperation({ summary: 'Órdenes de compra' })
  listOrders(@Query() query: ListPurchaseOrdersDto) {
    return this.purchases.listOrders(query);
  }

  @Get('purchase-orders/suggestions')
  @RequirePermission(PERMISSIONS.PURCHASE_VIEW)
  @ApiOperation({ summary: 'Sugerencia de compra por punto de reorden' })
  suggestions(@CurrentUser() actor: AuthenticatedUser) {
    return this.purchases.suggestions(actor);
  }

  @Get('purchase-orders/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_VIEW)
  @ApiOperation({ summary: 'Detalle de la orden' })
  findOrder(@Param('id') id: string) {
    return this.purchases.findOrder(id);
  }

  @Post('purchase-orders')
  @RequirePermission(PERMISSIONS.PURCHASE_CREATE)
  @ApiOperation({ summary: 'Crear orden de compra (borrador)' })
  createOrder(@Body() dto: CreatePurchaseOrderDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.purchases.createOrder(dto, actor);
  }

  @Post('purchase-orders/:id/approve')
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiOperation({ summary: 'Aprobar y enviar al proveedor' })
  approve(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.purchases.approveOrder(id, actor);
  }

  @Post('purchase-orders/:id/cancel')
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiOperation({ summary: 'Cancelar la orden (o cerrarla si ya llegó una parte)' })
  cancel(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.purchases.cancelOrder(id, actor);
  }

  // ── Recepciones ──
  @Get('purchase-receipts')
  @RequirePermission(PERMISSIONS.PURCHASE_VIEW)
  @ApiOperation({ summary: 'Recepciones de mercancía' })
  receipts() {
    return this.purchases.listReceipts();
  }

  @Post('purchase-receipts')
  @RequirePermission(PERMISSIONS.PURCHASE_RECEIVE)
  @ApiOperation({ summary: 'Recibir mercancía (contra orden o directa)' })
  receive(@Body() dto: CreateReceiptDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.purchases.receive(dto, actor);
  }
}
