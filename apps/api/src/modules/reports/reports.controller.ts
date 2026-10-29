import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { ValidationError } from '../../core/errors/domain-errors';
import { ReportsService } from './reports.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('Reportes')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  @RequirePermission(PERMISSIONS.REPORT_SALES)
  @ApiOperation({ summary: 'Tablero: ventas, utilidad, inventario y cobranza del periodo' })
  dashboard(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reports.dashboard({ from, to }, actor);
  }

  @Get('product-sales')
  @RequirePermission(PERMISSIONS.REPORT_SALES)
  @ApiOperation({ summary: 'Ventas por artículo' })
  productSales(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reports.productSales({ from, to }, actor);
  }

  @Get('sales')
  @RequirePermission(PERMISSIONS.REPORT_SALES)
  @ApiOperation({ summary: 'Ventas del periodo, ticket por ticket' })
  sales(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('userId') userId: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (userId && !UUID.test(userId)) throw new ValidationError('El cajero no es válido');
    return this.reports.salesDetail({ from, to, userId }, actor);
  }

  @Get('wholesale-sales')
  @RequirePermission(PERMISSIONS.REPORT_SALES)
  @ApiOperation({ summary: 'Ventas de mayoreo' })
  wholesaleSales(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reports.wholesaleSales({ from, to }, actor);
  }

  @Get('inventory')
  @RequirePermission(PERMISSIONS.REPORT_INVENTORY)
  @ApiOperation({ summary: 'Inventario con negativos, agotados y bajo mínimo' })
  inventory(
    @Query('filter') filter: 'all' | 'negative' | 'out' | 'low' | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const allowed = ['all', 'negative', 'out', 'low'];
    return this.reports.inventoryStatus(
      { filter: filter && allowed.includes(filter) ? filter : 'all' },
      actor,
    );
  }

  @Get('inventory-valuation')
  @RequirePermission(PERMISSIONS.REPORT_INVENTORY, PERMISSIONS.PRODUCT_COST_VIEW)
  @ApiOperation({ summary: 'Valuación del inventario al costo promedio' })
  inventoryValuation(@CurrentUser() actor: AuthenticatedUser) {
    return this.reports.inventoryValuation(actor);
  }
}
