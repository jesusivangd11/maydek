import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PosContextModule } from '../pos-context/pos-context.module';
import { HeldSalesService } from './held-sales.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule, PosContextModule, CatalogModule, InventoryModule],
  controllers: [SalesController],
  providers: [SalesService, HeldSalesService],
  exports: [SalesService],
})
export class SalesModule {}
