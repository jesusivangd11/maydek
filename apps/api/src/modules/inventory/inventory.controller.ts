import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { AdjustStockDto, KardexDto, ListStockDto } from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('Inventario')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  @ApiOperation({ summary: 'Existencias por artículo' })
  listStock(@Query() query: ListStockDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.inventory.listStock(query, actor);
  }

  @Get('kardex/:variantId')
  @RequirePermission(PERMISSIONS.INVENTORY_KARDEX_VIEW)
  @ApiOperation({ summary: 'Movimientos de un artículo' })
  kardex(
    @Param('variantId') variantId: string,
    @Query() query: KardexDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.inventory.kardex(variantId, query, actor);
  }

  @Post('adjustments')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  @ApiOperation({ summary: 'Ajustar existencia contra un conteo físico' })
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.inventory.adjust(dto, actor);
  }
}
