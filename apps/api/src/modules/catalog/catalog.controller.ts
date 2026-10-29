import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/permissions.decorator';
import { CatalogService } from './catalog.service';
import { CategoriesService } from './categories.service';
import {
  CreateCategoryDto,
  CreateProductDto,
  ListProductsDto,
  PosSearchDto,
  ProductVariantDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/catalog.dto';

@ApiTags('Catálogo')
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly categories: CategoriesService,
  ) {}

  // ── Búsqueda del POS ──
  @Get('pos/search')
  @RequirePermission(PERMISSIONS.PRODUCT_VIEW)
  @ApiOperation({ summary: 'Buscar artículos para vender, con precio y existencia' })
  posSearch(@Query() query: PosSearchDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.posSearch(query, actor);
  }

  @Get('pos/common-item')
  @RequirePermission(PERMISSIONS.SALE_CREATE)
  @ApiOperation({ summary: 'Artículo de sistema para vender un «producto común»' })
  commonItem() {
    return this.catalog.commonItem();
  }

  // ── Productos ──
  @Get('products')
  @RequirePermission(PERMISSIONS.PRODUCT_VIEW)
  @ApiOperation({ summary: 'Listar productos' })
  listProducts(@Query() query: ListProductsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.listProducts(query, actor);
  }

  @Get('products/:id')
  @RequirePermission(PERMISSIONS.PRODUCT_VIEW)
  @ApiOperation({ summary: 'Detalle de un producto' })
  findProduct(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.findProduct(id, actor);
  }

  @Post('products')
  @RequirePermission(PERMISSIONS.PRODUCT_CREATE)
  @ApiOperation({ summary: 'Crear producto' })
  createProduct(@Body() dto: CreateProductDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.createProduct(dto, actor);
  }

  @Patch('products/:id')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Actualizar producto' })
  updateProduct(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateProduct(id, dto, actor);
  }

  @Post('products/:id/variants')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Agregar una variante (talla, color…) a un producto' })
  addVariant(
    @Param('id') id: string,
    @Body() dto: ProductVariantDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.addVariant(id, dto, actor);
  }

  @Patch('variants/:id')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Editar una variante: SKU, precio, mínimo, código de barras' })
  updateVariant(
    @Param('id') id: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.updateVariant(id, dto, actor);
  }

  @Get('catalog/options')
  @RequirePermission(PERMISSIONS.PRODUCT_VIEW)
  @ApiOperation({ summary: 'Unidades, impuestos y marcas para los formularios' })
  options() {
    return this.catalog.options();
  }

  @Post('products/:id/activate')
  @RequirePermission(PERMISSIONS.PRODUCT_UPDATE)
  @ApiOperation({ summary: 'Reactivar producto' })
  activate(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.setActive(id, true, actor);
  }

  @Post('products/:id/archive')
  @RequirePermission(PERMISSIONS.PRODUCT_ARCHIVE)
  @ApiOperation({ summary: 'Desactivar producto (nunca se elimina)' })
  archive(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.setActive(id, false, actor);
  }

  // ── Categorías ──
  @Get('categories')
  @RequirePermission(PERMISSIONS.PRODUCT_VIEW)
  @ApiOperation({ summary: 'Listar categorías' })
  listCategories(@Query('includeInactive') includeInactive?: string) {
    return this.categories.list(includeInactive === 'true');
  }

  @Post('categories')
  @RequirePermission(PERMISSIONS.CATEGORY_MANAGE)
  @ApiOperation({ summary: 'Crear categoría' })
  createCategory(@Body() dto: CreateCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.categories.create(dto, actor);
  }

  @Patch('categories/:id')
  @RequirePermission(PERMISSIONS.CATEGORY_MANAGE)
  @ApiOperation({ summary: 'Actualizar categoría' })
  updateCategory(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.categories.update(id, dto, actor);
  }
}
