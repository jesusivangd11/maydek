import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PosContextModule } from '../pos-context/pos-context.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CategoriesService } from './categories.service';
import { PricingService } from './pricing.service';

@Module({
  imports: [AuthModule, PosContextModule, InventoryModule],
  controllers: [CatalogController],
  providers: [CatalogService, CategoriesService, PricingService],
  // Ventas necesita resolver precios con las mismas reglas que la búsqueda.
  exports: [PricingService, CatalogService],
})
export class CatalogModule {}
