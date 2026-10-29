import { Injectable } from '@nestjs/common';
import {
  MovementDirection,
  MovementType,
  Prisma,
  PurchaseOrderStatus,
  ReferenceType,
} from '@prisma/client';
import {
  DOC_TYPES,
  Decimal,
  money,
  moneyToString,
  qtyToString,
  sum,
  toMoney,
  toQty,
} from '@pv/domain-rules';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { SequenceService } from '../../core/sequences/sequence.service';
import { StockPostingService } from '../inventory/stock-posting.service';
import { PosContextService } from '../pos-context/pos-context.service';
import type {
  CreatePurchaseOrderDto,
  CreateReceiptDto,
  ListPurchaseOrdersDto,
  UpsertSupplierDto,
} from './dto/purchases.dto';

/**
 * COMPRAS.
 *
 * Una orden de compra NO mueve inventario: es una promesa del proveedor. Lo
 * único que mete mercancía al almacén es la RECEPCIÓN, y puede haber varias
 * por orden (pedí 100, llegaron 80 hoy y 20 la semana que entra).
 *
 * Costo: el flete se prorratea entre los renglones POR VALOR. El costo que
 * entra al promedio es el "puesto en bodega" (unitario + su parte de flete),
 * no el de la factura: es lo que de verdad costó tener la pieza en el anaquel.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
    private readonly stock: StockPostingService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  PROVEEDORES
  // ═══════════════════════════════════════════════════════════════════════════

  async listSuppliers(search?: string, includeInactive = false) {
    const term = search?.trim();
    const rows = await this.prisma.client.supplier.findMany({
      where: {
        deletedAt: null,
        ...(includeInactive ? {} : { isActive: true }),
        ...(term
          ? {
              OR: [
                { businessName: { contains: term, mode: 'insensitive' } },
                { tradeName: { contains: term, mode: 'insensitive' } },
                { rfc: { startsWith: term.toUpperCase() } },
                { code: { equals: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { businessName: 'asc' },
      take: 200,
      include: { _count: { select: { purchaseOrders: true } } },
    });

    return rows.map((s) => ({
      id: s.id,
      code: s.code,
      businessName: s.businessName,
      tradeName: s.tradeName,
      rfc: s.rfc,
      contactName: s.contactName,
      phone: s.phone,
      email: s.email,
      paymentTerms: s.paymentTerms,
      leadTimeDays: s.leadTimeDays,
      notes: s.notes,
      isActive: s.isActive,
      orderCount: s._count.purchaseOrders,
    }));
  }

  async upsertSupplier(id: string | null, dto: UpsertSupplierDto, actor: AuthenticatedUser) {
    const clean = (v?: string) => (v === undefined ? undefined : v.trim() || null);
    const data = {
      ...(dto.code !== undefined ? { code: clean(dto.code) } : {}),
      ...(dto.businessName !== undefined ? { businessName: dto.businessName.trim() } : {}),
      ...(dto.tradeName !== undefined ? { tradeName: clean(dto.tradeName) } : {}),
      ...(dto.rfc !== undefined ? { rfc: clean(dto.rfc)?.toUpperCase() ?? null } : {}),
      ...(dto.contactName !== undefined ? { contactName: clean(dto.contactName) } : {}),
      ...(dto.phone !== undefined ? { phone: clean(dto.phone) } : {}),
      ...(dto.email !== undefined ? { email: clean(dto.email) } : {}),
      ...(dto.paymentTerms !== undefined ? { paymentTerms: clean(dto.paymentTerms) } : {}),
      ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
      ...(dto.notes !== undefined ? { notes: clean(dto.notes) } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    let supplierId = id;
    try {
      if (id) {
        await this.prisma.client.supplier.update({ where: { id }, data });
      } else {
        if (!dto.businessName?.trim()) throw new ValidationError('El proveedor necesita un nombre');
        supplierId = newId();
        await this.prisma.client.supplier.create({
          data: { id: supplierId, ...data, businessName: dto.businessName.trim() },
        });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('Ya existe un proveedor con ese código');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundError('el proveedor', id ?? undefined);
      }
      throw error;
    }

    await this.audit.record({
      action: id ? 'supplier.update' : 'supplier.create',
      entityType: 'Supplier',
      entityId: supplierId!,
      entityLabel: dto.businessName,
      userId: actor.id,
    });

    return (await this.listSuppliers(undefined, true)).find((s) => s.id === supplierId);
  }

  /** Historial de costos de un artículo con cada proveedor. */
  async costHistory(variantId: string) {
    const rows = await this.prisma.client.supplierPrice.findMany({
      where: { variantId },
      orderBy: { validFrom: 'desc' },
      take: 50,
      include: { supplier: { select: { id: true, businessName: true } } },
    });
    return rows.map((r) => ({
      supplier: r.supplier,
      cost: r.cost.toString(),
      date: r.validFrom,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ÓRDENES DE COMPRA
  // ═══════════════════════════════════════════════════════════════════════════

  async createOrder(dto: CreatePurchaseOrderDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const supplier = await this.prisma.client.supplier.findFirst({
      where: { id: dto.supplierId, deletedAt: null, isActive: true },
      select: { id: true, businessName: true },
    });
    if (!supplier) throw new NotFoundError('el proveedor', dto.supplierId);

    const lines = await this.normalizeLines(dto.items);
    const subtotal = toMoney(sum(lines.map((l) => l.lineTotal)));
    const shipping = toMoney(dto.shippingCost ?? '0');
    const total = toMoney(subtotal.plus(shipping));

    return this.prisma.transaction(async (tx) => {
      const id = newId();
      const folio = await this.sequences.next(DOC_TYPES.PURCHASE_ORDER, ctx.branchId);

      await tx.purchaseOrder.create({
        data: {
          id,
          folio,
          supplierId: supplier.id,
          branchId: ctx.branchId,
          warehouseId: ctx.warehouseId,
          status: PurchaseOrderStatus.DRAFT,
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          subtotal: moneyToString(subtotal),
          shippingCost: moneyToString(shipping),
          total: moneyToString(total),
          notes: dto.notes ?? null,
          createdById: actor.id,
          items: {
            create: lines.map((l) => ({
              id: newId(),
              variantId: l.variantId,
              qtyOrdered: qtyToString(l.qty),
              unitCost: moneyToString(l.unitCost),
              lineTotal: moneyToString(l.lineTotal),
            })),
          },
        },
      });

      await this.audit.record({
        action: 'purchase.order.create',
        entityType: 'PurchaseOrder',
        entityId: id,
        entityLabel: folio,
        userId: actor.id,
        branchId: ctx.branchId,
        after: { supplier: supplier.businessName, total: moneyToString(total) },
      });

      return this.findOrder(id);
    });
  }

  /** Aprobar y enviar al proveedor. Exige `purchase.approve`. */
  async approveOrder(id: string, actor: AuthenticatedUser) {
    const order = await this.requireOrder(id);
    if (order.status !== PurchaseOrderStatus.DRAFT) {
      throw new ConflictError(`La orden ${order.folio} ya no está en borrador`);
    }
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.SENT, approvedById: actor.id, approvedAt: new Date() },
    });
    await this.audit.record({
      action: 'purchase.order.approve',
      entityType: 'PurchaseOrder',
      entityId: id,
      entityLabel: order.folio,
      userId: actor.id,
    });
    return this.findOrder(id);
  }

  async cancelOrder(id: string, actor: AuthenticatedUser) {
    const order = await this.requireOrder(id);
    if (order.status === PurchaseOrderStatus.RECEIVED || order.status === PurchaseOrderStatus.CLOSED) {
      throw new ConflictError(`La orden ${order.folio} ya se recibió`);
    }
    // Si ya llegó una parte, la orden se CIERRA con lo recibido: lo que
    // entró al almacén no se borra cancelando el papel.
    const partial = order.status === PurchaseOrderStatus.PARTIALLY_RECEIVED;
    await this.prisma.client.purchaseOrder.update({
      where: { id },
      data: { status: partial ? PurchaseOrderStatus.CLOSED : PurchaseOrderStatus.CANCELLED },
    });
    await this.audit.record({
      action: partial ? 'purchase.order.close' : 'purchase.order.cancel',
      entityType: 'PurchaseOrder',
      entityId: id,
      entityLabel: order.folio,
      userId: actor.id,
    });
    return this.findOrder(id);
  }

  async listOrders(query: ListPurchaseOrdersDto) {
    const rows = await this.prisma.client.purchaseOrder.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 50, 200),
      include: {
        supplier: { select: { id: true, businessName: true } },
        items: { select: { qtyOrdered: true, qtyReceived: true } },
      },
    });

    return rows.map((o) => {
      const ordered = sum(o.items.map((i) => money(i.qtyOrdered.toString())));
      const received = sum(o.items.map((i) => money(i.qtyReceived.toString())));
      return {
        id: o.id,
        folio: o.folio,
        status: o.status,
        supplier: o.supplier,
        total: o.total.toString(),
        expectedDate: o.expectedDate,
        createdAt: o.createdAt,
        qtyOrdered: ordered.toString(),
        qtyReceived: received.toString(),
      };
    });
  }

  async findOrder(id: string) {
    const order = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, businessName: true, phone: true, email: true } },
        items: {
          include: {
            variant: {
              select: { sku: true, nameSuffix: true, product: { select: { name: true } } },
            },
          },
        },
        receipts: {
          orderBy: { receivedAt: 'desc' },
          select: { id: true, folio: true, receivedAt: true, supplierInvoiceNumber: true },
        },
      },
    });
    if (!order) throw new NotFoundError('la orden de compra', id);

    return {
      id: order.id,
      folio: order.folio,
      status: order.status,
      supplier: order.supplier,
      expectedDate: order.expectedDate,
      subtotal: order.subtotal.toString(),
      shippingCost: order.shippingCost.toString(),
      total: order.total.toString(),
      notes: order.notes,
      createdAt: order.createdAt,
      approvedAt: order.approvedAt,
      items: order.items.map((i) => ({
        id: i.id,
        variantId: i.variantId,
        sku: i.variant.sku,
        name: i.variant.nameSuffix
          ? `${i.variant.product.name} ${i.variant.nameSuffix}`
          : i.variant.product.name,
        qtyOrdered: i.qtyOrdered.toString(),
        qtyReceived: i.qtyReceived.toString(),
        qtyPending: Decimal.max(0, i.qtyOrdered.minus(i.qtyReceived)).toString(),
        unitCost: i.unitCost.toString(),
        lineTotal: i.lineTotal.toString(),
      })),
      receipts: order.receipts,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECEPCIÓN
  // ═══════════════════════════════════════════════════════════════════════════

  async receive(dto: CreateReceiptDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);

    const order = dto.purchaseOrderId
      ? await this.prisma.client.purchaseOrder.findUnique({
          where: { id: dto.purchaseOrderId },
          include: { items: true },
        })
      : null;

    if (dto.purchaseOrderId && !order) {
      throw new NotFoundError('la orden de compra', dto.purchaseOrderId);
    }
    if (order) {
      const receivable: PurchaseOrderStatus[] = [
        PurchaseOrderStatus.SENT,
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
      ];
      if (!receivable.includes(order.status)) {
        throw new ConflictError(
          order.status === PurchaseOrderStatus.DRAFT
            ? `La orden ${order.folio} no está aprobada todavía`
            : `La orden ${order.folio} ya no admite recepciones`,
        );
      }
    }

    const supplierId = order?.supplierId ?? dto.supplierId;
    if (!supplierId) throw new ValidationError('Indica el proveedor de la mercancía');

    // Cambiar el costo pactado en la orden es un permiso aparte.
    const canChangeCost = actor.permissions.includes(PERMISSIONS.PURCHASE_COST_UPDATE);
    const orderItemByVariant = new Map(order?.items.map((i) => [i.variantId, i]) ?? []);

    const lines = dto.items.map((line) => {
      const qty = toQty(line.qty);
      if (qty.lte(0)) throw new ValidationError('La cantidad recibida debe ser mayor que cero');

      const orderItem = orderItemByVariant.get(line.variantId);
      if (order && !orderItem) {
        throw new ValidationError('Ese artículo no viene en la orden de compra', {
          variantId: line.variantId,
        });
      }

      let unitCost: Decimal;
      if (orderItem) {
        unitCost = money(orderItem.unitCost.toString());
        if (line.unitCost !== undefined && !toMoney(line.unitCost).equals(unitCost)) {
          if (!canChangeCost) {
            throw new ForbiddenError('No tienes permiso para cambiar el costo de la orden', {
              requiredPermission: PERMISSIONS.PURCHASE_COST_UPDATE,
            });
          }
          unitCost = toMoney(line.unitCost);
        }
      } else {
        if (line.unitCost === undefined) {
          throw new ValidationError('En una recepción directa cada artículo necesita su costo');
        }
        unitCost = toMoney(line.unitCost);
      }
      if (unitCost.lt(0)) throw new ValidationError('El costo no puede ser negativo');

      return { variantId: line.variantId, qty, unitCost, orderItem };
    });

    // ── Prorrateo del flete por valor ──
    const freight = toMoney(dto.freightCost ?? '0');
    const goodsValue = sum(lines.map((l) => l.unitCost.times(l.qty)));
    const withLanded = lines.map((l) => {
      const share =
        goodsValue.isZero() || freight.isZero()
          ? new Decimal(0)
          : freight.times(l.unitCost.times(l.qty)).dividedBy(goodsValue);
      return { ...l, landedUnitCost: toMoney(l.unitCost.plus(share.dividedBy(l.qty))) };
    });

    const variants = await this.prisma.client.productVariant.findMany({
      where: { id: { in: lines.map((l) => l.variantId) } },
      select: { id: true, sku: true, product: { select: { trackStock: true, name: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));
    for (const l of lines) {
      if (!variantById.has(l.variantId)) throw new NotFoundError('el artículo', l.variantId);
    }

    return this.prisma.transaction(async (tx) => {
      if (order) {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${order.id}::uuid FOR UPDATE`;
      }

      const receiptId = newId();
      const folio = await this.sequences.next(DOC_TYPES.PURCHASE_RECEIPT);
      const occurredAt = new Date();
      const warehouseId = order?.warehouseId ?? ctx.warehouseId;

      await tx.purchaseReceipt.create({
        data: {
          id: receiptId,
          folio,
          purchaseOrderId: order?.id ?? null,
          supplierId,
          warehouseId,
          status: 'COMPLETED',
          receivedAt: occurredAt,
          receivedById: actor.id,
          supplierInvoiceNumber: dto.supplierInvoiceNumber ?? null,
          notes: dto.notes ?? null,
          items: {
            create: withLanded.map((l) => ({
              id: newId(),
              purchaseOrderItemId: l.orderItem?.id ?? null,
              variantId: l.variantId,
              qtyReceived: qtyToString(l.qty),
              unitCost: moneyToString(l.unitCost),
              landedUnitCost: moneyToString(l.landedUnitCost),
            })),
          },
        },
      });

      // ── Entrada al kardex, al costo puesto en bodega ──
      const stockLines = withLanded.filter((l) => variantById.get(l.variantId)!.product.trackStock);
      await this.stock.post({
        movementType: MovementType.PURCHASE_RECEIPT,
        direction: MovementDirection.IN,
        referenceType: ReferenceType.PURCHASE_RECEIPT,
        referenceId: receiptId,
        referenceFolio: folio,
        userId: actor.id,
        occurredAt,
        lines: stockLines.map((l) => ({
          variantId: l.variantId,
          warehouseId,
          qty: l.qty,
          unitCost: l.landedUnitCost,
        })),
      });

      // ── Historial de costos por proveedor ──
      await tx.supplierPrice.createMany({
        data: withLanded.map((l) => ({
          id: newId(),
          supplierId,
          variantId: l.variantId,
          cost: moneyToString(l.unitCost),
          validFrom: occurredAt,
          receiptId,
        })),
      });

      // ── Lo recibido se acumula en la orden; el estado se deriva ──
      if (order) {
        for (const l of withLanded) {
          await tx.purchaseOrderItem.update({
            where: { id: l.orderItem!.id },
            data: { qtyReceived: { increment: qtyToString(l.qty) } },
          });
        }
        const items = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: order.id },
          select: { qtyOrdered: true, qtyReceived: true },
        });
        const complete = items.every((i) => i.qtyReceived.gte(i.qtyOrdered));
        await tx.purchaseOrder.update({
          where: { id: order.id },
          data: {
            status: complete
              ? PurchaseOrderStatus.RECEIVED
              : PurchaseOrderStatus.PARTIALLY_RECEIVED,
          },
        });
      }

      await this.audit.record({
        action: 'purchase.receive',
        entityType: 'PurchaseReceipt',
        entityId: receiptId,
        entityLabel: folio,
        userId: actor.id,
        branchId: ctx.branchId,
        after: {
          order: order?.folio ?? null,
          lines: withLanded.length,
          freight: moneyToString(freight),
        },
      });

      return {
        id: receiptId,
        folio,
        purchaseOrderId: order?.id ?? null,
        items: withLanded.map((l) => ({
          variantId: l.variantId,
          sku: variantById.get(l.variantId)!.sku,
          qty: l.qty.toString(),
          unitCost: l.unitCost.toFixed(4),
          landedUnitCost: l.landedUnitCost.toFixed(4),
        })),
      };
    });
  }

  async listReceipts(limit = 50) {
    const rows = await this.prisma.client.purchaseReceipt.findMany({
      orderBy: { receivedAt: 'desc' },
      take: Math.min(limit, 200),
      include: {
        supplier: { select: { id: true, businessName: true } },
        purchaseOrder: { select: { id: true, folio: true } },
        items: { select: { qtyReceived: true, landedUnitCost: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      folio: r.folio,
      receivedAt: r.receivedAt,
      supplier: r.supplier,
      purchaseOrder: r.purchaseOrder,
      supplierInvoiceNumber: r.supplierInvoiceNumber,
      total: toMoney(
        sum(r.items.map((i) => money(i.landedUnitCost.toString()).times(i.qtyReceived.toString()))),
      ).toFixed(4),
    }));
  }

  /**
   * Sugerencia de compra: lo que está en su mínimo o por debajo, con la
   * cantidad para volver a llegar al doble del mínimo y el último costo.
   */
  async suggestions(actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const rows = await this.prisma.client.$queryRaw<
      {
        variant_id: string;
        sku: string;
        name: string;
        min_stock: string;
        on_hand: string;
        last_cost: string;
      }[]
    >`
      SELECT v.id AS variant_id, v.sku,
             p.name || COALESCE(' ' || v.name_suffix, '') AS name,
             v.min_stock::text AS min_stock,
             COALESCE(b.qty_on_hand - b.qty_reserved, 0)::text AS on_hand,
             COALESCE(v.last_cost, v.cost, 0)::text AS last_cost
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN stock_balances b
        ON b.variant_id = v.id AND b.warehouse_id = ${ctx.warehouseId}::uuid AND b.condition = 'GOOD'
      WHERE v.deleted_at IS NULL AND v.is_active AND p.is_active AND p.track_stock
        AND v.min_stock IS NOT NULL
        AND COALESCE(b.qty_on_hand - b.qty_reserved, 0) <= v.min_stock
      ORDER BY COALESCE(b.qty_on_hand - b.qty_reserved, 0) / NULLIF(v.min_stock, 0) NULLS FIRST
      LIMIT 200`;

    return rows.map((r) => {
      const min = money(r.min_stock);
      const onHand = money(r.on_hand);
      return {
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        minStock: min.toString(),
        available: onHand.toString(),
        suggestedQty: Decimal.max(1, min.times(2).minus(onHand)).ceil().toString(),
        lastCost: r.last_cost,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════

  private async normalizeLines(items: { variantId: string; qty: string; unitCost: string }[]) {
    const seen = new Set<string>();
    const lines = items.map((item) => {
      if (seen.has(item.variantId)) {
        throw new ValidationError('Un artículo aparece dos veces en la orden; suma las cantidades');
      }
      seen.add(item.variantId);
      const qty = toQty(item.qty);
      const unitCost = toMoney(item.unitCost);
      if (qty.lte(0)) throw new ValidationError('La cantidad debe ser mayor que cero');
      if (unitCost.lt(0)) throw new ValidationError('El costo no puede ser negativo');
      return { variantId: item.variantId, qty, unitCost, lineTotal: toMoney(unitCost.times(qty)) };
    });

    const found = await this.prisma.client.productVariant.count({
      where: { id: { in: [...seen] }, deletedAt: null },
    });
    if (found !== seen.size) throw new NotFoundError('uno de los artículos de la orden');
    return lines;
  }

  private async requireOrder(id: string) {
    const order = await this.prisma.client.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, folio: true, status: true },
    });
    if (!order) throw new NotFoundError('la orden de compra', id);
    return order;
  }
}
