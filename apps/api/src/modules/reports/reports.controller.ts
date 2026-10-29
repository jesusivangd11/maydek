import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { ReportsService } from './reports.service';

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

  @Get('inventory-valuation')
  @RequirePermission(PERMISSIONS.REPORT_INVENTORY, PERMISSIONS.PRODUCT_COST_VIEW)
  @ApiOperation({ summary: 'Valuación del inventario al costo promedio' })
  inventoryValuation(@CurrentUser() actor: AuthenticatedUser) {
    return this.reports.inventoryValuation(actor);
  }
}
