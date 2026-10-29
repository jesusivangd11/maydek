import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PosContextModule } from '../pos-context/pos-context.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { StockPostingService } from './stock-posting.service';

/**
 * `StockPostingService` se exporta porque ventas, compras y devoluciones lo
 * necesitan: es el único camino por el que puede moverse la existencia.
 */
@Module({
  imports: [AuthModule, PosContextModule],
  controllers: [InventoryController],
  providers: [InventoryService, StockPostingService],
  exports: [StockPostingService, InventoryService],
})
export class InventoryModule {}
