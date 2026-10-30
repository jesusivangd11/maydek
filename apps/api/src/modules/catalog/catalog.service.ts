import { Injectable } from '@nestjs/common';
import {
  MovementDirection,
  MovementType,
  Prisma,
  ReferenceType,
  StockCondition,
} from '@prisma/client';
import { money, toMoney } from '@pv/domain-rules';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { PosContextService } from '../pos-context/pos-context.service';
import type {
  CreateProductDto,
  ListProductsDto,
  PosSearchDto,
  ProductVariantDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/catalog.dto';
import { StockPostingService } from '../inventory/stock-posting.service';
import { COMMON_ITEM_SKU, PricingService } from './pricing.service';

/**
 * Catálogo.
 *
 * MODELO DE DATOS, decisión que conviene tener presente: lo que se vende es el
 * VARIANTE, no el producto. "Faja postquirúrgica" es el producto; "Faja
 * postquirúrgica · Negro / M" es el variante, y es quien tiene SKU, precio,
 * código de barras y existencia.
 *
 * Un producto simple (sin tallas ni colores) se crea igual, con un único
 * variante implícito. Así el POS tiene un solo camino y no hay que duplicar la
 * lógica de venta para "productos simples" y "productos con variantes".
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly posContext: PosContextService,
    private readonly audit: AuditService,
    private readonly stock: StockPostingService,
  ) {}

  /**
   * El artículo de sistema detrás del «producto común»: la venta rápida de
   * algo que no está dado de alta. Cada renglón lleva su propia descripción y
   * precio; el artículo solo existe para que el ticket tenga a qué apuntar.
   * No lleva inventario. Se crea la primera vez que se pide.
   */
  async commonItem() {
    const select = {
      id: true,
      sku: true,
      product: { select: { taxRate: { select: { rate: true } } } },
    } as const;

    let variant = await this.prisma.client.productVariant.findFirst({
      where: { sku: COMMON_ITEM_SKU, deletedAt: null },
      select,
    });

    if (!variant) {
      const variantId = newId();
      await this.prisma.transaction(async (tx) => {
        await tx.product.create({
          data: {
            id: newId(),
            name: 'Producto común',
            description: 'Venta de artículos sin registrar. La descripción la escribe el cajero.',
            skuBase: COMMON_ITEM_SKU,
            trackStock: false,
            isActive: true,
            variants: {
              create: [{ id: variantId, sku: COMMON_ITEM_SKU, basePrice: '0', position: 0 }],
            },
          },
        });
      });
      variant = await this.prisma.client.productVariant.findFirstOrThrow({
        where: { id: variantId },
        select,
      });
    }

    const defaultTax = await this.prisma.client.taxRate.findFirst({
      where: { isDefault: true, isActive: true },
      select: { rate: true },
    });

    return {
      variantId: variant.id,
      sku: variant.sku,
      taxRate: (variant.product.taxRate?.rate ?? defaultTax?.rate)?.toString() ?? '0',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BÚSQUEDA DEL POS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Búsqueda para vender. Optimizada para lo que hace un cajero:
   *
   *   1. Pistola de códigos → coincidencia EXACTA de código de barras, y si la
   *      hay se devuelve sola: es inequívoca, el cajero no debe elegir nada.
   *   2. SKU tecleado → coincidencia por prefijo.
   *   3. Nombre → contiene.
   *
   * Devuelve precio y existencia ya resueltos: el POS no debe hacer tres
   * llamadas para pintar un renglón.
   */
  async posSearch(query: PosSearchDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor, { branchId: query.branchId });
    const warehouseId = query.warehouseId ?? ctx.warehouseId;
    const limit = Math.min(query.limit ?? 25, 50);
    const term = (query.q ?? '').trim();

    const baseWhere: Prisma.ProductVariantWhereInput = {
      deletedAt: null,
      isActive: true,
      // El producto común se vende con su propio botón (Ctrl+P), no buscándolo.
      NOT: { sku: COMMON_ITEM_SKU },
      product: {
        isActive: true,
        deletedAt: null,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      },
    };

    let variants: Awaited<ReturnType<typeof this.findVariants>> = [];
    let exactBarcode = false;

    if (term.length > 0) {
      // 1 · Código de barras exacto
      const byBarcode = await this.findVariants(
        // Sin distinguir mayúsculas: «f1» encuentra el código «F1».
        { ...baseWhere, barcodes: { some: { code: { equals: term, mode: 'insensitive' }, deletedAt: null } } },
        warehouseId,
        1,
      );

      if (byBarcode.length === 1) {
        variants = byBarcode;
        exactBarcode = true;
      } else {
        // 2 y 3 · SKU por prefijo o nombre que contenga
        variants = await this.findVariants(
          {
            ...baseWhere,
            OR: [
              { sku: { startsWith: term, mode: 'insensitive' } },
              { product: { name: { contains: term, mode: 'insensitive' } } },
              { nameSuffix: { contains: term, mode: 'insensitive' } },
            ],
          },
          warehouseId,
          limit,
        );
      }
    } else {
      // Sin término: los más recientes, para que la pantalla no esté vacía.
      variants = await this.findVariants(baseWhere, warehouseId, limit);
    }

    // Con cliente elegido, sus precios: el mayorista ve SU precio en la tarjeta.
    // Con mayoreo activado (F11), la lista de mayoreo manda sobre todo lo demás.
    const customer = query.customerId
      ? await this.prisma.client.customer.findFirst({
          where: { id: query.customerId, deletedAt: null },
          select: { priceListId: true },
        })
      : null;

    const prices = await this.pricing.resolveMany({
      variantIds: variants.map((v) => v.id),
      priceListId: query.wholesale
        ? await this.pricing.wholesalePriceListId()
        : (customer?.priceListId ?? ctx.priceListId),
    });

    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);

    return {
      exactBarcode,
      warehouseId,
      data: variants.map((variant) => {
        const balance = variant.stockBalances[0];
        const onHand = money(balance?.qtyOnHand.toString() ?? '0');
        const reserved = money(balance?.qtyReserved.toString() ?? '0');
        const available = onHand.minus(reserved);
        const price = prices.get(variant.id)!;

        return {
          variantId: variant.id,
          productId: variant.product.id,
          sku: variant.sku,
          name: variant.nameSuffix
            ? `${variant.product.name} ${variant.nameSuffix}`
            : variant.product.name,
          productName: variant.product.name,
          barcode: variant.barcodes[0]?.code ?? null,
          category: variant.product.category,
          unit: variant.product.unit?.code ?? 'PZA',
          imageUrl: variant.imageUrl,
          unitPrice: price.unitPrice.toFixed(4),
          priceIncludesTax: price.includesTax,
          taxRate: variant.product.taxRate?.rate.toString() ?? '0',
          trackStock: variant.product.trackStock,
          qtyAvailable: available.toFixed(3),
          // Un servicio no tiene existencia: nunca se marca como agotado.
          isOut: variant.product.trackStock ? available.lte(0) : false,
          // El mínimo por variante es lo que convierte "12 piezas" en un dato
          // accionable: sin él la pantalla tendría que inventarse un umbral.
          minStock: variant.minStock?.toFixed(3) ?? null,
          isLow:
            variant.product.trackStock && variant.minStock !== null
              ? available.gt(0) && available.lte(money(variant.minStock.toString()))
              : false,
          ...(showCost ? { cost: variant.cost.toString() } : {}),
        };
      }),
    };
  }

  private findVariants(
    where: Prisma.ProductVariantWhereInput,
    warehouseId: string,
    take: number,
  ) {
    return this.prisma.client.productVariant.findMany({
      where,
      take,
      orderBy: [{ position: 'asc' }, { sku: 'asc' }],
      select: {
        id: true,
        sku: true,
        nameSuffix: true,
        basePrice: true,
        cost: true,
        minStock: true,
        imageUrl: true,
        product: {
          select: {
            id: true,
            name: true,
            trackStock: true,
            category: { select: { id: true, name: true } },
            unit: { select: { code: true } },
            taxRate: { select: { rate: true } },
          },
        },
        barcodes: {
          where: { deletedAt: null },
          select: { code: true },
          orderBy: { isPrimary: 'desc' },
          take: 1,
        },
        stockBalances: {
          where: { warehouseId, condition: StockCondition.GOOD },
          select: { qtyOnHand: true, qtyReserved: true },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRODUCTOS
  // ═══════════════════════════════════════════════════════════════════════════

  async listProducts(query: ListProductsDto, actor: AuthenticatedUser) {
    const limit = Math.min(query.limit ?? 50, 200);

    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      // El producto común es de sistema: no se edita ni se cuenta.
      AND: [{ OR: [{ skuBase: null }, { skuBase: { not: COMMON_ITEM_SKU } }] }],
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { skuBase: { contains: query.search, mode: 'insensitive' } },
              { variants: { some: { sku: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const products = await this.prisma.client.product.findMany({
      where,
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        skuBase: true,
        isActive: true,
        trackStock: true,
        hasVariants: true,
        updatedAt: true,
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        unit: { select: { code: true, name: true } },
        taxRate: { select: { id: true, code: true, rate: true } },
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            sku: true,
            nameSuffix: true,
            basePrice: true,
            cost: true,
            minStock: true,
            isActive: true,
            barcodes: { where: { deletedAt: null }, select: { code: true }, take: 1 },
          },
          orderBy: { position: 'asc' },
        },
      },
    });

    const hasMore = products.length > limit;
    const page = hasMore ? products.slice(0, limit) : products;
    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);
    const wholesale = await this.pricing.wholesalePrices(
      page.flatMap((p) => p.variants.map((v) => v.id)),
    );

    return {
      data: page.map((product) => ({
        id: product.id,
        name: product.name,
        skuBase: product.skuBase,
        isActive: product.isActive,
        trackStock: product.trackStock,
        hasVariants: product.hasVariants,
        category: product.category,
        brand: product.brand,
        unit: product.unit,
        taxRate: product.taxRate ? product.taxRate.rate.toString() : null,
        updatedAt: product.updatedAt,
        variants: product.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          nameSuffix: v.nameSuffix,
          barcode: v.barcodes[0]?.code ?? null,
          basePrice: v.basePrice.toString(),
          wholesalePrice: wholesale.get(v.id) ?? null,
          minStock: v.minStock?.toString() ?? null,
          isActive: v.isActive,
          ...(showCost ? { cost: v.cost.toString() } : {}),
        })),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async findProduct(id: string, actor: AuthenticatedUser) {
    const product = await this.prisma.client.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        unit: { select: { id: true, code: true, name: true } },
        taxRate: { select: { id: true, code: true, name: true, rate: true } },
        variants: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          include: {
            barcodes: { where: { deletedAt: null }, select: { id: true, code: true, isPrimary: true } },
            stockBalances: {
              where: { condition: StockCondition.GOOD },
              select: { warehouseId: true, qtyOnHand: true, qtyReserved: true },
            },
          },
        },
      },
    });

    if (!product) throw new NotFoundError('el producto', id);

    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);
    const wholesale = await this.pricing.wholesalePrices(product.variants.map((v) => v.id));

    return {
      id: product.id,
      name: product.name,
      description: product.description,
      skuBase: product.skuBase,
      isActive: product.isActive,
      trackStock: product.trackStock,
      hasVariants: product.hasVariants,
      category: product.category,
      brand: product.brand,
      unit: product.unit,
      taxRate: product.taxRate,
      version: product.version,
      variants: product.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        nameSuffix: v.nameSuffix,
        basePrice: v.basePrice.toString(),
        wholesalePrice: wholesale.get(v.id) ?? null,
        minStock: v.minStock?.toString() ?? null,
        isActive: v.isActive,
        imageUrl: v.imageUrl,
        barcodes: v.barcodes,
        stock: v.stockBalances.map((b) => ({
          warehouseId: b.warehouseId,
          qtyOnHand: b.qtyOnHand.toString(),
          qtyAvailable: money(b.qtyOnHand.toString())
            .minus(money(b.qtyReserved.toString()))
            .toFixed(3),
        })),
        ...(showCost ? { cost: v.cost.toString() } : {}),
      })),
    };
  }

  /**
   * Alta de producto.
   *
   * Crea SIEMPRE al menos un variante. Si no se declaran variantes, se genera
   * el implícito con el SKU base: así todo lo que se vende tiene la misma forma.
   */
  async createProduct(dto: CreateProductDto, actor: AuthenticatedUser) {
    // Existencia inicial: entra al almacén de la sucursal de quien da de alta.
    const wantsStock =
      (dto.variants ?? []).some((v) => v.initialStock && Number(v.initialStock) > 0) ||
      (!!dto.initialStock && Number(dto.initialStock) > 0);
    const ctx = wantsStock ? await this.posContext.resolve(actor, {}) : null;

    return this.prisma.transaction(async (tx) => {
      const skus = (dto.variants ?? []).map((v) => v.sku);
      if (dto.sku) skus.push(dto.sku);

      const clash = await tx.productVariant.findFirst({
        where: { sku: { in: skus }, deletedAt: null },
        select: { sku: true },
      });
      if (clash) {
        throw new ConflictError(`Ya existe un artículo con el SKU ${clash.sku}`, {
          sku: clash.sku,
        });
      }

      const productId = newId();
      const hasVariants = (dto.variants?.length ?? 0) > 0;

      const variantsData = hasVariants
        ? dto.variants!.map((v, index) => ({
            id: newId(),
            sku: v.sku,
            nameSuffix: v.nameSuffix ?? null,
            basePrice: toMoney(v.basePrice ?? '0').toFixed(4),
            cost: toMoney(v.cost ?? '0').toFixed(4),
            minStock: v.minStock ?? null,
            position: index,
          }))
        : [
            {
              id: newId(),
              sku: dto.sku!,
              nameSuffix: null,
              basePrice: toMoney(dto.basePrice ?? '0').toFixed(4),
              cost: toMoney(dto.cost ?? '0').toFixed(4),
              minStock: dto.minStock ?? null,
              position: 0,
            },
          ];

      // Lo que se captura en la misma pantalla del alta, renglón por variante.
      const extras = hasVariants
        ? dto.variants!.map((v) => ({
            wholesalePrice: v.wholesalePrice,
            initialStock: v.initialStock,
            cost: v.cost,
          }))
        : [{ wholesalePrice: dto.wholesalePrice, initialStock: dto.initialStock, cost: dto.cost }];

      await tx.product.create({
        data: {
          id: productId,
          name: dto.name,
          description: dto.description ?? null,
          skuBase: dto.sku ?? null,
          categoryId: dto.categoryId ?? null,
          brandId: dto.brandId ?? null,
          unitId: dto.unitId ?? null,
          taxRateId: dto.taxRateId ?? null,
          trackStock: dto.trackStock ?? true,
          hasVariants,
          isActive: true,
          createdById: actor.id,
          variants: { create: variantsData },
        },
      });

      // Códigos de barras: uno por variante, el primero es el principal.
      const barcodePairs = hasVariants
        ? dto.variants!.map((v, i) => ({ code: v.barcode, variantId: variantsData[i]!.id }))
        : [{ code: dto.barcode, variantId: variantsData[0]!.id }];

      for (const pair of barcodePairs) {
        if (!pair.code) continue;
        const taken = await tx.barcode.findFirst({
          where: { code: pair.code, deletedAt: null },
          select: { id: true },
        });
        if (taken) {
          throw new ConflictError(`El código de barras ${pair.code} ya está en uso`, {
            barcode: pair.code,
          });
        }
        await tx.barcode.create({
          data: { id: newId(), variantId: pair.variantId, code: pair.code, isPrimary: true },
        });
      }

      // Precio de mayoreo y existencia inicial, en la misma transacción: el
      // producto nace completo o no nace.
      const stockLines = [];
      for (const [i, extra] of extras.entries()) {
        const variant = variantsData[i]!;
        if (extra.wholesalePrice) {
          await this.pricing.setWholesalePrice(variant.id, extra.wholesalePrice);
        }
        if (ctx && (dto.trackStock ?? true) && extra.initialStock && Number(extra.initialStock) > 0) {
          stockLines.push({
            variantId: variant.id,
            warehouseId: ctx.warehouseId,
            qty: extra.initialStock,
            unitCost: extra.cost ?? '0',
            sku: variant.sku,
            name: dto.name,
          });
        }
      }
      if (stockLines.length > 0) {
        await this.stock.post({
          movementType: MovementType.INITIAL_LOAD,
          direction: MovementDirection.IN,
          referenceType: ReferenceType.MANUAL,
          referenceId: productId,
          referenceFolio: 'ALTA',
          userId: actor.id,
          notes: 'Existencia inicial capturada en el alta del producto',
          lines: stockLines,
        });
      }

      await this.audit.record({
        action: 'product.create',
        entityType: 'Product',
        entityId: productId,
        entityLabel: dto.name,
        userId: actor.id,
        after: { name: dto.name, variants: variantsData.length },
      });

      return this.findProduct(productId, actor);
    });
  }

  /** Agrega una talla, color o presentación a un producto que ya existe. */
  async addVariant(productId: string, dto: ProductVariantDto, actor: AuthenticatedUser) {
    const product = await this.prisma.client.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true, _count: { select: { variants: true } } },
    });
    if (!product) throw new NotFoundError('el producto', productId);

    await this.prisma.transaction(async (tx) => {
      const clash = await tx.productVariant.findFirst({
        where: { sku: dto.sku, deletedAt: null },
        select: { sku: true },
      });
      if (clash) throw new ConflictError(`Ya existe un artículo con el SKU ${dto.sku}`);

      const variantId = newId();
      await tx.productVariant.create({
        data: {
          id: variantId,
          productId,
          sku: dto.sku,
          nameSuffix: dto.nameSuffix ?? null,
          basePrice: toMoney(dto.basePrice ?? '0').toFixed(4),
          minStock: dto.minStock ?? null,
          position: product._count.variants,
        },
      });
      await tx.product.update({ where: { id: productId }, data: { hasVariants: true } });
      if (dto.barcode) await this.replaceBarcode(tx, variantId, dto.barcode);

      await this.audit.record({
        action: 'product.variant.create',
        entityType: 'ProductVariant',
        entityId: variantId,
        entityLabel: dto.sku,
        userId: actor.id,
      });
    });

    return this.findProduct(productId, actor);
  }

  async updateVariant(variantId: string, dto: UpdateVariantDto, actor: AuthenticatedUser) {
    const variant = await this.prisma.client.productVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: { id: true, sku: true, productId: true, basePrice: true },
    });
    if (!variant) throw new NotFoundError('el artículo', variantId);

    if (
      (dto.basePrice !== undefined || dto.wholesalePrice !== undefined) &&
      !actor.permissions.includes(PERMISSIONS.PRODUCT_PRICE_UPDATE)
    ) {
      throw new ForbiddenError('No tienes permiso para cambiar precios', {
        requiredPermission: PERMISSIONS.PRODUCT_PRICE_UPDATE,
      });
    }

    await this.prisma.transaction(async (tx) => {
      if (dto.sku && dto.sku !== variant.sku) {
        const clash = await tx.productVariant.findFirst({
          where: { sku: dto.sku, deletedAt: null, NOT: { id: variantId } },
          select: { id: true },
        });
        if (clash) throw new ConflictError(`Ya existe un artículo con el SKU ${dto.sku}`);
      }

      await tx.productVariant.update({
        where: { id: variantId },
        data: {
          ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
          ...(dto.nameSuffix !== undefined ? { nameSuffix: dto.nameSuffix || null } : {}),
          ...(dto.basePrice !== undefined ? { basePrice: toMoney(dto.basePrice).toFixed(4) } : {}),
          ...(dto.minStock !== undefined ? { minStock: dto.minStock === '' ? null : dto.minStock } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });

      if (dto.barcode !== undefined) await this.replaceBarcode(tx, variantId, dto.barcode);
      if (dto.wholesalePrice !== undefined) {
        await this.pricing.setWholesalePrice(variantId, dto.wholesalePrice || null);
      }

      await this.audit.record({
        action: 'product.variant.update',
        entityType: 'ProductVariant',
        entityId: variantId,
        entityLabel: variant.sku,
        userId: actor.id,
        before: { basePrice: variant.basePrice.toString() },
        after: { basePrice: dto.basePrice ?? variant.basePrice.toString(), sku: dto.sku ?? variant.sku },
      });
    });

    return this.findProduct(variant.productId, actor);
  }

  /** El código principal se reemplaza; el anterior queda archivado, no borrado. */
  private async replaceBarcode(tx: Prisma.TransactionClient, variantId: string, code: string) {
    const clean = code.trim().toUpperCase();
    if (clean) {
      const taken = await tx.barcode.findFirst({
        where: { code: clean, deletedAt: null, NOT: { variantId } },
        select: { id: true },
      });
      if (taken) throw new ConflictError(`El código de barras ${clean} ya está en uso`);
    }

    await tx.barcode.updateMany({
      where: { variantId, deletedAt: null, ...(clean ? { NOT: { code: clean } } : {}) },
      data: { deletedAt: new Date(), isPrimary: false },
    });

    if (clean) {
      const existing = await tx.barcode.findFirst({
        where: { variantId, code: clean, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        await tx.barcode.create({ data: { id: newId(), variantId, code: clean, isPrimary: true } });
      }
    }
  }

  async updateProduct(id: string, dto: UpdateProductDto, actor: AuthenticatedUser) {
    if (
      (dto.basePrice !== undefined || dto.wholesalePrice !== undefined) &&
      !actor.permissions.includes(PERMISSIONS.PRODUCT_PRICE_UPDATE)
    ) {
      throw new ForbiddenError('No tienes permiso para cambiar precios', {
        requiredPermission: PERMISSIONS.PRODUCT_PRICE_UPDATE,
      });
    }

    const before = await this.prisma.client.product.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, isActive: true, categoryId: true, version: true },
    });
    if (!before) throw new NotFoundError('el producto', id);

    return this.prisma.transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
          ...(dto.unitId !== undefined ? { unitId: dto.unitId } : {}),
          ...(dto.taxRateId !== undefined ? { taxRateId: dto.taxRateId } : {}),
          ...(dto.trackStock !== undefined ? { trackStock: dto.trackStock } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          version: { increment: 1 },
        },
      });

      // El precio es un permiso aparte del de editar el producto.
      if (
        dto.basePrice !== undefined ||
        dto.minStock !== undefined ||
        dto.wholesalePrice !== undefined
      ) {
        const variant = await tx.productVariant.findFirst({
          where: { productId: id, deletedAt: null },
          orderBy: { position: 'asc' },
          select: { id: true },
        });
        if (variant && dto.wholesalePrice !== undefined) {
          await this.pricing.setWholesalePrice(variant.id, dto.wholesalePrice || null);
        }
        if (variant) {
          await tx.productVariant.update({
            where: { id: variant.id },
            data: {
              ...(dto.basePrice !== undefined
                ? { basePrice: toMoney(dto.basePrice).toFixed(4) }
                : {}),
              ...(dto.minStock !== undefined ? { minStock: dto.minStock } : {}),
            },
          });
        }
      }

      await this.audit.record({
        action: 'product.update',
        entityType: 'Product',
        entityId: id,
        entityLabel: dto.name ?? before.name,
        userId: actor.id,
        before: { name: before.name, isActive: before.isActive },
        after: { name: dto.name ?? before.name, isActive: dto.isActive ?? before.isActive },
      });

      return this.findProduct(id, actor);
    });
  }

  /** Catálogos pequeños que necesitan los formularios de producto. */
  async options() {
    const [units, taxRates, brands] = await Promise.all([
      this.prisma.client.unit.findMany({ orderBy: { name: 'asc' }, select: { id: true, code: true, name: true } }),
      this.prisma.client.taxRate.findMany({
        where: { isActive: true },
        orderBy: { rate: 'desc' },
        select: { id: true, code: true, name: true, rate: true, isDefault: true },
      }),
      this.prisma.client.brand.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);
    return {
      units,
      taxRates: taxRates.map((t) => ({ ...t, rate: t.rate.toString() })),
      brands,
    };
  }

  /**
   * Activar o desactivar. NUNCA se borra: un producto eliminado rompería los
   * tickets históricos que lo mencionan.
   */
  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const product = await this.prisma.client.product.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, isActive: true },
    });
    if (!product) throw new NotFoundError('el producto', id);

    await this.prisma.transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { isActive } });
      await tx.productVariant.updateMany({ where: { productId: id }, data: { isActive } });

      await this.audit.record({
        action: isActive ? 'product.activate' : 'product.archive',
        entityType: 'Product',
        entityId: id,
        entityLabel: product.name,
        userId: actor.id,
        before: { isActive: product.isActive },
        after: { isActive },
      });
    });

    return this.findProduct(id, actor);
  }
}
