import { Injectable } from '@nestjs/common';
import {
  CashMovementType,
  MovementDirection,
  MovementType,
  Prisma,
  ReferenceType,
  ReturnStatus,
  ReturnType,
  SaleStatus,
  StockCondition,
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
  CashSessionRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { OutboxService } from '../../core/outbox/outbox.service';
import { SequenceService } from '../../core/sequences/sequence.service';
import { AuthService } from '../auth/auth.service';
import { refreshCustomerMetrics } from '../customers/customer-metrics';
import { CUSTOMER_NAME_SELECT, customerDisplayName } from '../customers/customer-name';
import { StockPostingService } from '../inventory/stock-posting.service';
import { PosContextService } from '../pos-context/pos-context.service';
import type { CreateReturnDto, ListReturnsDto } from './dto/returns.dto';

/**
 * DEVOLUCIONES.
 *
 * Una devolución es el espejo de una venta y, como ella, es atómica: folio,
 * documento, entrada al kardex, reembolso y caja nacen o fallan juntos.
 *
 * Reglas de negocio:
 *   · Los importes salen de la venta ORIGINAL: la devolución no reprecia. Si
 *     el producto subió de precio, se devuelve lo que se pagó.
 *   · No se devuelve más de lo vendido menos lo ya devuelto. La venta se
 *     bloquea con FOR UPDATE: dos devoluciones simultáneas del mismo ticket se
 *     forman en fila y la segunda ve lo que hizo la primera.
 *   · La mercancía en buen estado regresa al almacén de la venta; la dañada
 *     va al almacén de mermas, para no volver a venderse.
 *   · Fuera de la ventana de días (ajuste `returns.window_days`, 30 por
 *     omisión) hace falta `return.override_window` o el PIN de quien lo tenga.
 *   · Reembolsar en efectivo exige `return.refund_cash` y caja abierta.
 *   · La alternativa al reembolso es una NOTA DE CRÉDITO: crédito a favor que
 *     el cliente gasta después con la forma de pago "Crédito a favor".
 */

const DEFAULT_WINDOW_DAYS = 30;
const CREDIT_NOTE_VALID_DAYS = 365;

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
    private readonly stock: StockPostingService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly auth: AuthService,
  ) {}

  async create(dto: CreateReturnDto, actor: AuthenticatedUser) {
    if (dto.type === ReturnType.EXCHANGE) {
      throw new ValidationError(
        'Para un cambio registra la devolución con nota de crédito y cobra la venta nueva con ella',
      );
    }

    const ctx = await this.posContext.resolve(actor);

    if (dto.idempotencyKey) {
      const existing = await this.prisma.client.return.findFirst({
        where: { branchId: ctx.branchId, idempotencyKey: dto.idempotencyKey },
        select: { id: true },
      });
      if (existing) return this.findOne(existing.id, actor);
    }

    const sale = await this.prisma.client.sale.findUnique({
      where: { id: dto.saleId },
      select: {
        id: true,
        folio: true,
        status: true,
        branchId: true,
        warehouseId: true,
        channelId: true,
        customerId: true,
        occurredAt: true,
        payments: {
          where: { status: 'CAPTURED', paymentMethod: { kind: 'CREDIT' } },
          select: { amount: true },
        },
      },
    });
    if (!sale) throw new NotFoundError('la venta', dto.saleId);

    // Venta a crédito: lo devuelto se abona a la deuda del cliente. Reembolsar
    // en efectivo algo que el cliente todavía no pagó sería regalarle dinero.
    const toAccount = Boolean(sale.customerId) && sale.payments.length > 0;
    if (sale.status === SaleStatus.CANCELLED) {
      throw new ConflictError(`La venta ${sale.folio} está cancelada; no hay nada que devolver`);
    }
    if (sale.status === SaleStatus.RETURNED) {
      throw new ConflictError(`La venta ${sale.folio} ya se devolvió completa`);
    }

    // ── Autorizaciones: ventana de días y reembolso en efectivo ──
    const refundMethod =
      dto.type === ReturnType.REFUND && !toAccount
        ? await this.prisma.client.paymentMethod.findFirst({
            where: { code: dto.refundMethodCode ?? 'CASH', isActive: true },
            select: { id: true, code: true, name: true, kind: true, affectsCash: true },
          })
        : null;
    if (dto.type === ReturnType.REFUND && !toAccount && !refundMethod) {
      throw new NotFoundError(`la forma de reembolso ${dto.refundMethodCode ?? 'CASH'}`);
    }
    if (refundMethod && (refundMethod.kind === 'CREDIT' || refundMethod.kind === 'STORE_CREDIT')) {
      throw new ValidationError('Para devolver como crédito a favor elige "Nota de crédito"');
    }

    const windowDays = await this.windowDays();
    const ageDays = (Date.now() - sale.occurredAt.getTime()) / 86_400_000;
    const needs: string[] = [];
    if (ageDays > windowDays && !actor.permissions.includes(PERMISSIONS.RETURN_OVERRIDE_WINDOW)) {
      needs.push(PERMISSIONS.RETURN_OVERRIDE_WINDOW);
    }
    if (
      refundMethod?.affectsCash &&
      !actor.permissions.includes(PERMISSIONS.RETURN_REFUND_CASH)
    ) {
      needs.push(PERMISSIONS.RETURN_REFUND_CASH);
    }

    let authorizedById: string | null = null;
    for (const permission of needs) {
      if (!dto.supervisorPin) {
        throw new ForbiddenError(
          permission === PERMISSIONS.RETURN_OVERRIDE_WINDOW
            ? `La venta tiene ${Math.floor(ageDays)} días y la política permite ${windowDays}. Pide autorización a un supervisor.`
            : 'Reembolsar en efectivo requiere autorización de un supervisor',
          { requiredPermission: permission },
        );
      }
      const supervisor = await this.auth.authorize(
        sale.branchId,
        dto.supervisorPin,
        permission as typeof PERMISSIONS.RETURN_REFUND_CASH,
        `Devolución de la venta ${sale.folio}`,
      );
      authorizedById = supervisor.userId;
    }

    // ── Caja para el reembolso en efectivo ──
    let cashSessionId: string | null = null;
    if (ctx.terminalId) {
      cashSessionId = (await this.posContext.findOpenCashSession(ctx.terminalId))?.id ?? null;
    }
    if (refundMethod?.affectsCash && !cashSessionId) throw new CashSessionRequiredError();

    const damagedWarehouse = await this.prisma.client.warehouse.findFirst({
      where: { branchId: sale.branchId, type: 'DAMAGED', isActive: true, deletedAt: null },
      select: { id: true },
    });

    return this.prisma.transaction(async (tx) => {
      // Cerrojo: la segunda devolución simultánea espera a que la primera termine.
      await tx.$queryRaw`SELECT id FROM sales WHERE id = ${sale.id}::uuid FOR UPDATE`;

      const saleItems = await tx.saleItem.findMany({
        where: { saleId: sale.id },
        select: {
          id: true,
          variantId: true,
          warehouseId: true,
          skuSnapshot: true,
          nameSnapshot: true,
          qty: true,
          returnedQty: true,
          unitPrice: true,
          unitCost: true,
          taxAmount: true,
          lineSubtotal: true,
          lineTotal: true,
          returnItems: { select: { lineTotal: true, taxAmount: true } },
          variant: { select: { product: { select: { trackStock: true } } } },
        },
      });
      const itemById = new Map(saleItems.map((i) => [i.id, i]));

      // ── 1. Calcular cada renglón con los importes de la venta original ──
      const requested = new Map<string, Decimal>();
      for (const line of dto.items) {
        requested.set(line.saleItemId, (requested.get(line.saleItemId) ?? new Decimal(0)).plus(toQty(line.qty)));
      }

      const lines = dto.items.map((line) => {
        const item = itemById.get(line.saleItemId);
        if (!item) throw new NotFoundError('el renglón de la venta', line.saleItemId);

        const qty = toQty(line.qty);
        if (qty.lte(0)) throw new ValidationError('La cantidad a devolver debe ser mayor que cero');

        const sold = money(item.qty.toString());
        const already = money(item.returnedQty.toString());
        const pending = sold.minus(already);
        if (requested.get(item.id)!.gt(pending)) {
          throw new ConflictError(
            `De "${item.nameSnapshot}" se vendieron ${sold.toString()} y ya se devolvieron ${already.toString()}: puedes devolver ${pending.toString()}`,
            { saleItemId: item.id, pending: pending.toString() },
          );
        }

        // Si con esto se devuelve el renglón completo, se toma el resto exacto
        // en vez de la proporción: así la suma de devoluciones cuadra al centavo.
        const closesLine = already.plus(qty).equals(sold);
        const ratio = qty.dividedBy(sold);
        const prevTotal = sum(item.returnItems.map((r) => money(r.lineTotal.toString())));
        const prevTax = sum(item.returnItems.map((r) => money(r.taxAmount.toString())));

        const lineTotal = closesLine
          ? toMoney(money(item.lineTotal.toString()).minus(prevTotal))
          : toMoney(money(item.lineTotal.toString()).times(ratio));
        const taxAmount = closesLine
          ? toMoney(money(item.taxAmount.toString()).minus(prevTax))
          : toMoney(money(item.taxAmount.toString()).times(ratio));

        return {
          item,
          qty,
          condition: line.condition ?? StockCondition.GOOD,
          lineTotal,
          taxAmount,
          subtotal: toMoney(lineTotal.minus(taxAmount)),
          unitCost: money(item.unitCost.toString()),
        };
      });

      const total = toMoney(sum(lines.map((l) => l.lineTotal)));
      const taxTotal = toMoney(sum(lines.map((l) => l.taxAmount)));
      const subtotal = toMoney(sum(lines.map((l) => l.subtotal)));
      const costTotal = toMoney(sum(lines.map((l) => l.unitCost.times(l.qty))));

      const folio = await this.sequences.next(DOC_TYPES.RETURN, sale.branchId);
      const returnId = newId();
      const occurredAt = new Date();

      // ── 2. La mercancía regresa: buena al piso de venta, dañada a mermas ──
      const stockLines = lines.filter((l) => l.item.variant.product.trackStock);
      if (stockLines.length > 0) {
        await this.stock.post({
          movementType: MovementType.RETURN_IN,
          direction: MovementDirection.IN,
          referenceType: ReferenceType.RETURN,
          referenceId: returnId,
          referenceFolio: folio,
          userId: actor.id,
          terminalId: ctx.terminalId,
          channelId: sale.channelId,
          reasonCode: dto.reasonCode,
          notes: dto.notes ?? null,
          occurredAt,
          lines: stockLines.map((l) => ({
            variantId: l.item.variantId,
            warehouseId:
              l.condition === StockCondition.GOOD
                ? l.item.warehouseId
                : (damagedWarehouse?.id ?? l.item.warehouseId),
            condition: l.condition,
            qty: l.qty,
            unitCost: l.unitCost,
          })),
        });
      }

      // ── 3. El documento ──
      await tx.return.create({
        data: {
          id: returnId,
          folio,
          saleId: sale.id,
          branchId: sale.branchId,
          warehouseId: sale.warehouseId,
          channelId: sale.channelId,
          userId: actor.id,
          cashSessionId,
          type: dto.type,
          status: ReturnStatus.COMPLETED,
          subtotal: moneyToString(subtotal),
          taxTotal: moneyToString(taxTotal),
          total: moneyToString(total),
          costTotal: moneyToString(costTotal),
          restock: lines.some((l) => l.condition === StockCondition.GOOD),
          reasonCode: dto.reasonCode,
          notes: dto.notes ?? null,
          authorizedByUserId: authorizedById,
          idempotencyKey: dto.idempotencyKey ?? null,
          occurredAt,
          items: {
            create: lines.map((l) => ({
              id: newId(),
              saleItemId: l.item.id,
              variantId: l.item.variantId,
              qty: qtyToString(l.qty),
              unitPrice: l.item.unitPrice.toString(),
              unitCost: moneyToString(l.unitCost),
              taxAmount: moneyToString(l.taxAmount),
              lineTotal: moneyToString(l.lineTotal),
              condition: l.condition,
              reasonCode: dto.reasonCode,
            })),
          },
        },
      });

      // ── 4. La venta lleva la cuenta de lo devuelto ──
      for (const l of lines) {
        await tx.saleItem.update({
          where: { id: l.item.id },
          data: { returnedQty: { increment: qtyToString(l.qty) } },
        });
      }
      const after = await tx.saleItem.findMany({
        where: { saleId: sale.id },
        select: { qty: true, returnedQty: true },
      });
      const fullyReturned = after.every((i) => i.returnedQty.gte(i.qty));
      await tx.sale.update({
        where: { id: sale.id },
        data: { status: fullyReturned ? SaleStatus.RETURNED : SaleStatus.PARTIALLY_RETURNED },
      });

      // ── 5. Reembolso o nota de crédito ──
      let creditNoteFolio: string | null = null;

      if (toAccount && sale.customerId) {
        await this.postAccountEntry(tx, sale.customerId, {
          type: 'REFUND',
          amount: total.negated(),
          referenceId: returnId,
          referenceFolio: folio,
          userId: actor.id,
          notes: `Devolución de la venta a crédito ${sale.folio}`,
        });
      } else if (dto.type === ReturnType.REFUND && refundMethod) {
        await tx.payment.create({
          data: {
            id: newId(),
            returnId,
            customerId: sale.customerId,
            paymentMethodId: refundMethod.id,
            amount: moneyToString(total.negated()),
            status: 'REFUNDED',
            cashSessionId,
            userId: actor.id,
            channelId: sale.channelId,
            occurredAt,
          },
        });

        if (refundMethod.affectsCash && cashSessionId) {
          await tx.cashMovement.create({
            data: {
              id: newId(),
              cashSessionId,
              type: CashMovementType.RETURN_REFUND,
              amount: moneyToString(total),
              paymentMethodId: refundMethod.id,
              referenceType: ReferenceType.RETURN,
              referenceId: returnId,
              referenceFolio: folio,
              reason: `Devolución de ${sale.folio}`,
              userId: actor.id,
              authorizedByUserId: authorizedById,
              occurredAt,
            },
          });
        }
      } else {
        creditNoteFolio = await this.sequences.next(DOC_TYPES.CREDIT_NOTE, sale.branchId);
        await tx.creditNote.create({
          data: {
            id: newId(),
            folio: creditNoteFolio,
            customerId: sale.customerId,
            returnId,
            amount: moneyToString(total),
            expiresAt: new Date(occurredAt.getTime() + CREDIT_NOTE_VALID_DAYS * 86_400_000),
            notes: `Devolución ${folio} de la venta ${sale.folio}`,
          },
        });
      }

      if (sale.customerId) await refreshCustomerMetrics(tx, sale.customerId);

      await this.audit.record({
        action: 'return.create',
        entityType: 'Return',
        entityId: returnId,
        entityLabel: folio,
        userId: actor.id,
        branchId: sale.branchId,
        reason: dto.reasonCode,
        authorizedByUserId: authorizedById ?? undefined,
        after: {
          sale: sale.folio,
          type: dto.type,
          total: moneyToString(total),
          creditNote: creditNoteFolio,
        },
      });

      await this.outbox.publish({
        eventType: 'return.completed',
        aggregateType: 'Return',
        aggregateId: returnId,
        payload: { returnId, folio, saleId: sale.id, total: moneyToString(total) },
      });

      return this.findOne(returnId, actor);
    });
  }

  async findOne(id: string, actor: AuthenticatedUser) {
    const row = await this.prisma.client.return.findUnique({
      where: { id },
      include: {
        sale: {
          select: {
            id: true,
            folio: true,
            customer: { select: { id: true, ...CUSTOMER_NAME_SELECT } },
          },
        },
        user: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, code: true } },
        items: {
          include: { saleItem: { select: { skuSnapshot: true, nameSnapshot: true } } },
        },
        payments: { include: { paymentMethod: { select: { code: true, name: true } } } },
        creditNotes: { select: { folio: true, amount: true, expiresAt: true } },
      },
    });
    if (!row) throw new NotFoundError('la devolución', id);
    if (actor.branchIds.length > 0 && !actor.branchIds.includes(row.branchId)) {
      throw new ForbiddenError('Esa devolución es de otra sucursal');
    }

    return {
      id: row.id,
      folio: row.folio,
      type: row.type,
      status: row.status,
      occurredAt: row.occurredAt,
      branch: row.branch,
      cashier: row.user,
      sale: { id: row.sale.id, folio: row.sale.folio },
      customer: row.sale.customer
        ? { id: row.sale.customer.id, name: customerDisplayName(row.sale.customer) }
        : null,
      reasonCode: row.reasonCode,
      notes: row.notes,
      subtotal: row.subtotal.toString(),
      taxTotal: row.taxTotal.toString(),
      total: row.total.toString(),
      items: row.items.map((item) => ({
        id: item.id,
        sku: item.saleItem.skuSnapshot,
        name: item.saleItem.nameSnapshot,
        qty: item.qty.toString(),
        unitPrice: item.unitPrice.toString(),
        lineTotal: item.lineTotal.toString(),
        condition: item.condition,
      })),
      refunds: row.payments.map((p) => ({
        methodCode: p.paymentMethod.code,
        methodName: p.paymentMethod.name,
        amount: p.amount.negated().toString(),
      })),
      creditNote: row.creditNotes[0]
        ? {
            folio: row.creditNotes[0].folio,
            amount: row.creditNotes[0].amount.toString(),
            expiresAt: row.creditNotes[0].expiresAt,
          }
        : null,
    };
  }

  async list(query: ListReturnsDto, actor: AuthenticatedUser) {
    const where: Prisma.ReturnWhereInput = {};
    if (query.saleId) where.saleId = query.saleId;
    if (actor.branchIds.length > 0) where.branchId = { in: actor.branchIds };
    if (query.from || query.to) {
      where.occurredAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const rows = await this.prisma.client.return.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: Math.min(query.limit ?? 50, 200),
      select: {
        id: true,
        folio: true,
        type: true,
        total: true,
        reasonCode: true,
        occurredAt: true,
        sale: { select: { id: true, folio: true } },
        user: { select: { name: true } },
        _count: { select: { items: true } },
      },
    });

    return {
      data: rows.map((r) => ({
        id: r.id,
        folio: r.folio,
        type: r.type,
        total: r.total.toString(),
        reasonCode: r.reasonCode,
        occurredAt: r.occurredAt,
        sale: r.sale,
        cashier: r.user?.name ?? null,
        itemCount: r._count.items,
      })),
    };
  }

  /** Nota de crédito por folio: el POS la consulta antes de cobrar con ella. */
  async findCreditNote(folio: string) {
    const note = await this.prisma.client.creditNote.findFirst({
      where: { folio: folio.trim().toUpperCase() },
      select: {
        folio: true,
        amount: true,
        usedAmount: true,
        status: true,
        expiresAt: true,
        customer: { select: { id: true, ...CUSTOMER_NAME_SELECT } },
      },
    });
    if (!note) throw new NotFoundError('la nota de crédito', folio);

    return {
      folio: note.folio,
      amount: note.amount.toString(),
      available: money(note.amount.toString()).minus(money(note.usedAmount.toString())).toFixed(4),
      status: note.status,
      expiresAt: note.expiresAt,
      customer: note.customer
        ? { id: note.customer.id, name: customerDisplayName(note.customer) }
        : null,
    };
  }

  private async windowDays(): Promise<number> {
    const setting = await this.prisma.client.setting.findFirst({
      where: { key: 'returns.window_days', branchId: null },
      select: { value: true },
    });
    const parsed = Number(setting?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_DAYS;
  }

  private async postAccountEntry(
    tx: Prisma.TransactionClient,
    customerId: string,
    entry: {
      type: 'REFUND';
      amount: Decimal;
      referenceId: string;
      referenceFolio: string;
      userId: string;
      notes: string;
    },
  ) {
    const last = await tx.customerAccountEntry.findFirst({
      where: { customerId },
      orderBy: { occurredAt: 'desc' },
      select: { balanceAfter: true },
    });
    const balance = money(last?.balanceAfter.toString() ?? '0');

    await tx.customerAccountEntry.create({
      data: {
        id: newId(),
        customerId,
        type: entry.type,
        amount: moneyToString(entry.amount),
        balanceAfter: moneyToString(balance.plus(entry.amount)),
        referenceType: ReferenceType.RETURN,
        referenceId: entry.referenceId,
        referenceFolio: entry.referenceFolio,
        notes: entry.notes,
        userId: entry.userId,
      },
    });
  }
}
