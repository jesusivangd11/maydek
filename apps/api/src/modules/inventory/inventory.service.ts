import { Injectable } from '@nestjs/common';
import {
  MovementDirection,
  MovementType,
  Prisma,
  ReferenceType,
  StockCondition,
} from '@prisma/client';
import { DOC_TYPES, money, toQty } from '@pv/domain-rules';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { NotFoundError, ValidationError } from '../../core/errors/domain-errors';
import { SequenceService } from '../../core/sequences/sequence.service';
import { PosContextService } from '../pos-context/pos-context.service';
import type { AdjustStockDto, ListStockDto, KardexDto } from './dto/inventory.dto';
import { StockPostingService } from './stock-posting.service';

/**
 * Consulta de existencias y ajustes manuales.
 *
 * Los ajustes NO tocan `stock_balances` directamente: pasan por el mismo motor
 * que las ventas, de modo que todo ajuste deja su asiento en el kardex con
 * quién, cuándo y por qué. Un inventario que se puede "corregir" sin rastro no
 * es un inventario, es una hoja de cálculo.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockPostingService,
    private readonly posContext: PosContextService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
  ) {}

  /** Existencias por artículo, con su mínimo y su estado de reposición. */
  async listStock(query: ListStockDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor, { branchId: query.branchId });
    const warehouseId = query.warehouseId ?? ctx.warehouseId;
    const limit = Math.min(query.limit ?? 50, 200);

    const where: Prisma.ProductVariantWhereInput = {
      deletedAt: null,
      ...(query.onlyActive === false ? {} : { isActive: true, product: { isActive: true } }),
      ...(query.categoryId ? { product: { categoryId: query.categoryId } } : {}),
      ...(query.search
        ? {
            OR: [
              { sku: { contains: query.search, mode: 'insensitive' } },
              { product: { name: { contains: query.search, mode: 'insensitive' } } },
              { barcodes: { some: { code: query.search, deletedAt: null } } },
            ],
          }
        : {}),
    };

    const variants = await this.prisma.client.productVariant.findMany({
      where,
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        sku: true,
        nameSuffix: true,
        basePrice: true,
        cost: true,
        minStock: true,
        isActive: true,
        product: {
          select: {
            id: true,
            name: true,
            trackStock: true,
            category: { select: { id: true, name: true } },
            unit: { select: { code: true, name: true } },
          },
        },
        stockBalances: {
          where: { warehouseId, condition: StockCondition.GOOD },
          select: { qtyOnHand: true, qtyReserved: true, avgCost: true, lastMovementAt: true },
        },
      },
    });

    const hasMore = variants.length > limit;
    const page = hasMore ? variants.slice(0, limit) : variants;
    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);

    const data = page.map((variant) => {
      const balance = variant.stockBalances[0];
      const onHand = money(balance?.qtyOnHand.toString() ?? '0');
      const reserved = money(balance?.qtyReserved.toString() ?? '0');
      const minStock = variant.minStock ? money(variant.minStock.toString()) : null;
      const available = onHand.minus(reserved);

      return {
        variantId: variant.id,
        productId: variant.product.id,
        sku: variant.sku,
        name: variant.nameSuffix
          ? `${variant.product.name} ${variant.nameSuffix}`
          : variant.product.name,
        category: variant.product.category,
        unit: variant.product.unit,
        trackStock: variant.product.trackStock,
        isActive: variant.isActive,
        price: variant.basePrice.toString(),
        qtyOnHand: onHand.toFixed(3),
        qtyReserved: reserved.toFixed(3),
        qtyAvailable: available.toFixed(3),
        minStock: minStock?.toFixed(3) ?? null,
        // Lo que la pantalla pinta en ámbar o rojo.
        isLow: minStock ? available.lte(minStock) : false,
        isOut: available.lte(0),
        lastMovementAt: balance?.lastMovementAt ?? null,
        ...(showCost
          ? {
              cost: (balance?.avgCost ?? variant.cost).toString(),
              stockValue: money(balance?.avgCost.toString() ?? variant.cost.toString())
                .times(onHand)
                .toFixed(4),
            }
          : {}),
      };
    });

    const filtered = query.onlyLow ? data.filter((row) => row.isLow) : data;

    return {
      data: filtered,
      warehouseId,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Kardex de un artículo: el histórico completo, sin huecos. */
  async kardex(variantId: string, query: KardexDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor, { branchId: query.branchId });
    const warehouseId = query.warehouseId ?? ctx.warehouseId;
    const limit = Math.min(query.limit ?? 100, 500);

    const variant = await this.prisma.client.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, sku: true, nameSuffix: true, product: { select: { name: true } } },
    });
    if (!variant) throw new NotFoundError('el artículo', variantId);

    const movements = await this.prisma.client.stockLedger.findMany({
      where: {
        variantId,
        warehouseId,
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      select: {
        id: true,
        occurredAt: true,
        movementType: true,
        direction: true,
        qty: true,
        qtyBefore: true,
        qtyAfter: true,
        unitCost: true,
        referenceType: true,
        referenceId: true,
        referenceFolio: true,
        reasonCode: true,
        notes: true,
        user: { select: { id: true, name: true } },
      },
    });

    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);

    return {
      variant: {
        id: variant.id,
        sku: variant.sku,
        name: variant.nameSuffix
          ? `${variant.product.name} ${variant.nameSuffix}`
          : variant.product.name,
      },
      warehouseId,
      movements: movements.map((m) => ({
        id: m.id,
        occurredAt: m.occurredAt,
        movementType: m.movementType,
        direction: m.direction,
        qty: m.qty.toString(),
        qtyBefore: m.qtyBefore.toString(),
        qtyAfter: m.qtyAfter.toString(),
        reference: m.referenceFolio ?? m.referenceType,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        reasonCode: m.reasonCode,
        notes: m.notes,
        user: m.user,
        ...(showCost ? { unitCost: m.unitCost?.toString() ?? null } : {}),
      })),
    };
  }

  /**
   * Ajuste manual de existencia.
   *
   * Se captura la cantidad REAL contada, no la diferencia: es lo que la persona
   * tiene delante. El sistema calcula el delta y lo asienta en la dirección que
   * corresponda.
   */
  async adjust(dto: AdjustStockDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor, { branchId: dto.branchId });
    const warehouseId = dto.warehouseId ?? ctx.warehouseId;

    return this.prisma.transaction(async (tx) => {
      const folio = await this.sequences.next(DOC_TYPES.ADJUSTMENT, ctx.branchId);
      const results = [];

      for (const line of dto.lines) {
        const variant = await tx.productVariant.findFirst({
          where: { id: line.variantId, deletedAt: null },
          select: { id: true, sku: true, cost: true, product: { select: { name: true } } },
        });
        if (!variant) throw new NotFoundError('el artículo', line.variantId);

        const balance = await tx.stockBalance.findUnique({
          where: {
            variantId_warehouseId_condition: {
              variantId: line.variantId,
              warehouseId,
              condition: StockCondition.GOOD,
            },
          },
          select: { qtyOnHand: true, avgCost: true },
        });

        const current = money(balance?.qtyOnHand.toString() ?? '0');
        const counted = toQty(line.countedQty);
        const delta = counted.minus(current);

        if (delta.isZero()) continue;

        const isIncrease = delta.gt(0);

        const posted = await this.stock.post({
          movementType: isIncrease
            ? MovementType.ADJUSTMENT_IN
            : MovementType.ADJUSTMENT_OUT,
          direction: isIncrease ? MovementDirection.IN : MovementDirection.OUT,
          referenceType: ReferenceType.ADJUSTMENT,
          referenceFolio: folio,
          userId: actor.id,
          reasonCode: dto.reasonCode,
          notes: line.notes ?? dto.notes,
          // Permite dejar la existencia en negativo solo si así lo contaron.
          allowNegative: true,
          lines: [
            {
              variantId: line.variantId,
              warehouseId,
              qty: delta.abs(),
              sku: variant.sku,
              name: variant.product.name,
              // En una entrada por ajuste el costo es el promedio vigente: un
              // ajuste de conteo no es una compra y no debe mover la valuación.
              unitCost: isIncrease
                ? (balance?.avgCost.toString() ?? variant.cost.toString())
                : undefined,
            },
          ],
        });

        results.push({
          variantId: line.variantId,
          sku: variant.sku,
          name: variant.product.name,
          qtyBefore: posted[0]!.qtyBefore.toFixed(3),
          qtyAfter: posted[0]!.qtyAfter.toFixed(3),
          delta: delta.toFixed(3),
        });
      }

      if (results.length === 0) {
        throw new ValidationError(
          'Ninguna cantidad contada difiere de la existencia actual: no hay nada que ajustar',
        );
      }

      await this.audit.record({
        action: 'inventory.adjust',
        entityType: 'StockAdjustment',
        entityLabel: folio,
        userId: actor.id,
        branchId: ctx.branchId,
        reason: dto.reasonCode,
        after: { folio, lines: results },
      });

      return { folio, warehouseId, adjustments: results };
    });
  }
}
