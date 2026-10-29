import { Injectable, Logger } from '@nestjs/common';
import {
  CashMovementType,
  MovementDirection,
  MovementType,
  Prisma,
  ReferenceType,
  SaleStatus,
} from '@prisma/client';
import {
  DOC_TYPES,
  Decimal,
  calculateTax,
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
import { PricingService } from '../catalog/pricing.service';
import { refreshCustomerMetrics } from '../customers/customer-metrics';
import { CUSTOMER_NAME_SELECT, customerDisplayName } from '../customers/customer-name';
import { StockPostingService } from '../inventory/stock-posting.service';
import { PosContextService } from '../pos-context/pos-context.service';
import type { CreateSaleDto } from './dto/sales.dto';

/**
 * VENTAS.
 *
 * Una venta es una operación atómica que toca cinco cosas a la vez: el folio,
 * el documento, el kardex, los pagos y la caja. O pasan todas o no pasa
 * ninguna: por eso todo vive dentro de una sola transacción.
 *
 * El orden importa. El inventario se descuenta ANTES de insertar la venta, de
 * modo que si no hay existencia el error salta con el documento todavía sin
 * crear. No puede quedar una venta registrada sin su salida de almacén.
 */

interface ComputedLine {
  lineNumber: number;
  variantId: string;
  trackStock: boolean;
  skuSnapshot: string;
  nameSnapshot: string;
  barcodeSnapshot: string | null;
  qty: Decimal;
  unitPrice: Decimal;
  discountAmount: Decimal;
  discountPercent: Decimal;
  discountReason: string | null;
  taxRate: Decimal;
  taxAmount: Decimal;
  lineSubtotal: Decimal;
  lineTotal: Decimal;
  priceListId: string | null;
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
    private readonly pricing: PricingService,
    private readonly stock: StockPostingService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly auth: AuthService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  COBRAR
  // ═══════════════════════════════════════════════════════════════════════════

  async create(dto: CreateSaleDto, actor: AuthenticatedUser) {
    if (dto.items.length === 0) {
      throw new ValidationError('La venta necesita al menos un artículo');
    }

    const ctx = await this.posContext.resolve(actor, {
      branchId: dto.branchId,
      terminalId: dto.terminalId,
    });

    // Reintento del mismo ticket (la red falló, el cajero volvió a dar cobrar):
    // se devuelve la venta original en vez de duplicar el cargo.
    //
    // Esta comprobación atrapa el caso común —reintentos separados en el
    // tiempo— pero NO basta por sí sola: dos peticiones simultáneas pueden
    // leer "no existe" las dos. El cierre de verdad es el índice único parcial
    // sobre (branch_id, idempotency_key), y se recoge más abajo.
    const duplicate = await this.findByIdempotencyKey(ctx.branchId, dto.idempotencyKey);
    if (duplicate) return this.findOne(duplicate, actor);

    try {
      return await this.createSale(dto, actor, ctx);
    } catch (error) {
      // La carrera que la comprobación previa no puede cubrir: ganó la otra
      // petición y la base rechazó ésta. Se devuelve la venta que sí entró.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        dto.idempotencyKey
      ) {
        const winner = await this.findByIdempotencyKey(ctx.branchId, dto.idempotencyKey);
        if (winner) return this.findOne(winner, actor);
      }
      throw error;
    }
  }

  private async findByIdempotencyKey(
    branchId: string,
    idempotencyKey?: string,
  ): Promise<string | null> {
    if (!idempotencyKey) return null;

    const existing = await this.prisma.client.sale.findFirst({
      where: { branchId, idempotencyKey },
      select: { id: true },
    });

    return existing?.id ?? null;
  }

  private async createSale(
    dto: CreateSaleDto,
    actor: AuthenticatedUser,
    ctx: Awaited<ReturnType<PosContextService['resolve']>>,
  ) {
    return this.prisma.transaction(async (tx) => {
      // ── 1. Artículos: se leen del servidor, nunca del cliente ──
      const variantIds = [...new Set(dto.items.map((i) => i.variantId))];

      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, deletedAt: null },
        select: {
          id: true,
          sku: true,
          nameSuffix: true,
          basePrice: true,
          isActive: true,
          product: {
            select: {
              name: true,
              trackStock: true,
              isActive: true,
              taxRate: { select: { rate: true } },
            },
          },
          barcodes: {
            where: { isPrimary: true, deletedAt: null },
            select: { code: true },
            take: 1,
          },
        },
      });

      const variantById = new Map(variants.map((v) => [v.id, v]));

      for (const id of variantIds) {
        const variant = variantById.get(id);
        if (!variant) throw new NotFoundError('el artículo', id);
        if (!variant.isActive || !variant.product.isActive) {
          throw new ConflictError(
            `"${variant.product.name}" está desactivado y no puede venderse`,
            { variantId: id },
          );
        }
      }

      const defaultTax = await tx.taxRate.findFirst({
        where: { isDefault: true, isActive: true },
        select: { rate: true },
      });

      // ── Cliente: su lista de precios manda sobre la del canal ──
      const customer = dto.customerId
        ? await tx.customer.findFirst({
            where: { id: dto.customerId, deletedAt: null },
            select: { id: true, isActive: true, priceListId: true, creditLimit: true },
          })
        : null;
      if (dto.customerId && (!customer || !customer.isActive)) {
        throw new NotFoundError('el cliente', dto.customerId);
      }
      const priceListId = customer?.priceListId ?? ctx.priceListId;

      // ── 2. Precios ──
      const qtyByVariant = new Map<string, Decimal>();
      for (const item of dto.items) {
        qtyByVariant.set(
          item.variantId,
          (qtyByVariant.get(item.variantId) ?? new Decimal(0)).plus(toQty(item.qty)),
        );
      }

      const prices = await this.pricing.resolveMany({
        variantIds,
        priceListId,
        qtyByVariant,
      });

      // ── 3. Calcular cada renglón ──
      const canOverridePrice = actor.permissions.includes(PERMISSIONS.SALE_PRICE_OVERRIDE);
      const canDiscount = actor.permissions.includes(PERMISSIONS.SALE_DISCOUNT_APPLY);

      const lines: ComputedLine[] = [];
      let lineNumber = 0;

      for (const item of dto.items) {
        const variant = variantById.get(item.variantId)!;
        const resolved = prices.get(item.variantId)!;
        const quantity = toQty(item.qty);

        if (quantity.lte(0)) {
          throw new ValidationError('La cantidad debe ser mayor que cero', {
            variantId: item.variantId,
          });
        }

        // Precio manual: es un permiso aparte, y con razón — es la puerta
        // trasera clásica para regalar mercancía.
        let unitPrice = resolved.unitPrice;
        if (item.unitPrice !== undefined && item.unitPrice !== null) {
          if (!canOverridePrice) {
            throw new ForbiddenError('No tienes permiso para cambiar el precio', {
              requiredPermission: PERMISSIONS.SALE_PRICE_OVERRIDE,
            });
          }
          unitPrice = toMoney(item.unitPrice);
        }

        if (unitPrice.lt(0)) {
          throw new ValidationError('El precio no puede ser negativo');
        }

        const gross = toMoney(unitPrice.times(quantity));

        // ── Descuento: por importe o por porcentaje, nunca ambos ──
        let discountAmount = new Decimal(0);
        let discountPercent = new Decimal(0);

        if (item.discountPercent !== undefined && item.discountPercent !== null) {
          discountPercent = money(item.discountPercent);
          discountAmount = toMoney(gross.times(discountPercent));
        } else if (item.discountAmount !== undefined && item.discountAmount !== null) {
          discountAmount = toMoney(item.discountAmount);
          discountPercent = gross.isZero()
            ? new Decimal(0)
            : discountAmount.dividedBy(gross).toDecimalPlaces(6);
        }

        if (!discountAmount.isZero()) {
          if (!canDiscount) {
            throw new ForbiddenError('No tienes permiso para aplicar descuentos', {
              requiredPermission: PERMISSIONS.SALE_DISCOUNT_APPLY,
            });
          }
          if (discountAmount.gt(gross)) {
            throw new ValidationError('El descuento no puede superar el importe del renglón', {
              variantId: item.variantId,
            });
          }
          if (discountAmount.lt(0)) {
            throw new ValidationError('El descuento no puede ser negativo');
          }
        }

        const net = toMoney(gross.minus(discountAmount));

        // ── Impuesto ──
        const rate = variant.product.taxRate
          ? money(variant.product.taxRate.rate.toString())
          : money(defaultTax?.rate.toString() ?? '0');

        const tax = calculateTax({
          base: net,
          rate,
          priceIncludesTax: resolved.includesTax,
        });

        lines.push({
          lineNumber: ++lineNumber,
          variantId: item.variantId,
          trackStock: variant.product.trackStock,
          skuSnapshot: variant.sku,
          nameSnapshot: variant.nameSuffix
            ? `${variant.product.name} ${variant.nameSuffix}`
            : variant.product.name,
          barcodeSnapshot: variant.barcodes[0]?.code ?? null,
          qty: quantity,
          unitPrice,
          discountAmount,
          discountPercent,
          discountReason: item.discountReason ?? null,
          taxRate: rate,
          taxAmount: tax.tax,
          lineSubtotal: tax.taxable,
          lineTotal: tax.total,
          priceListId: resolved.priceListId,
        });
      }

      const subtotal = toMoney(sum(lines.map((l) => l.lineSubtotal)));
      const taxTotal = toMoney(sum(lines.map((l) => l.taxAmount)));
      const discountTotal = toMoney(sum(lines.map((l) => l.discountAmount)));
      const total = toMoney(sum(lines.map((l) => l.lineTotal)));

      // ── 4. Pagos ──
      const { payments, cashApplied, changeGiven } = await this.resolvePayments(
        tx,
        dto,
        total,
      );

      // Crédito del cliente: solo a un cliente identificado y dentro de su límite.
      const creditApplied = toMoney(
        sum(payments.filter((p) => p.kind === 'CREDIT').map((p) => p.amount)),
      );
      let creditBalance = new Decimal(0);
      if (creditApplied.gt(0)) {
        if (!customer) {
          throw new ValidationError('Para vender a crédito hay que elegir al cliente');
        }
        const last = await tx.customerAccountEntry.findFirst({
          where: { customerId: customer.id },
          orderBy: { occurredAt: 'desc' },
          select: { balanceAfter: true },
        });
        creditBalance = money(last?.balanceAfter.toString() ?? '0');
        const limit = money(customer.creditLimit.toString());
        if (creditBalance.plus(creditApplied).gt(limit)) {
          throw new ValidationError(
            `El cliente tiene un límite de crédito de ${limit.toFixed(2)} y ya debe ${creditBalance.toFixed(2)}`,
            { limit: limit.toFixed(2), balance: creditBalance.toFixed(2) },
          );
        }
      }

      // Crédito a favor: se consume de la nota de crédito cuyo folio viene como referencia.
      for (const payment of payments.filter((p) => p.kind === 'STORE_CREDIT')) {
        const note = await tx.creditNote.findFirst({
          where: { folio: (payment.reference ?? '').trim().toUpperCase() },
          select: { id: true, folio: true, amount: true, usedAmount: true, status: true, expiresAt: true, customerId: true },
        });
        if (!note || note.status === 'CANCELLED' || note.status === 'USED') {
          throw new ValidationError(`La nota de crédito ${payment.reference} no existe o ya se usó`);
        }
        if (note.expiresAt && note.expiresAt < new Date()) {
          throw new ValidationError(`La nota de crédito ${note.folio} venció`);
        }
        if (note.customerId && customer && note.customerId !== customer.id) {
          throw new ValidationError(`La nota de crédito ${note.folio} es de otro cliente`);
        }
        const left = money(note.amount.toString()).minus(money(note.usedAmount.toString()));
        if (payment.amount.gt(left)) {
          throw new ValidationError(
            `A la nota ${note.folio} le quedan ${left.toFixed(2)}`,
            { available: left.toFixed(2) },
          );
        }
        const used = money(note.usedAmount.toString()).plus(payment.amount);
        await tx.creditNote.update({
          where: { id: note.id },
          data: {
            usedAmount: moneyToString(used),
            status: used.gte(money(note.amount.toString())) ? 'USED' : 'PARTIALLY_USED',
          },
        });
      }

      // ── 5. Turno de caja ──
      //
      // La venta se ata al turno ABIERTO exista o no efectivo de por medio. Es
      // la diferencia entre "movimiento de caja" y "venta del turno": el cajón
      // solo lo mueve el efectivo, pero el CORTE tiene que poder responder
      // cuánto se cobró con tarjeta y con transferencia. Si solo se enlazaran
      // las ventas en efectivo, una venta con tarjeta no aparecería por ningún
      // lado en el arqueo.
      let cashSessionId: string | null = null;
      if (ctx.terminalId) {
        const session = await this.posContext.findOpenCashSession(ctx.terminalId);
        cashSessionId = session?.id ?? null;
      }

      // El efectivo SÍ exige turno abierto: sin caja no hay dónde meterlo.
      if (cashApplied.gt(0)) {
        if (!ctx.terminalId) {
          throw new ValidationError(
            'Para cobrar en efectivo hay que indicar en qué terminal estás',
          );
        }
        if (!cashSessionId) throw new CashSessionRequiredError();
      }

      // ── 6. Folio: dentro de la transacción, para que no queden huecos ──
      const folio = await this.sequences.next(DOC_TYPES.SALE, ctx.branchId);

      // ── 7. Inventario ANTES del documento ──
      //
      // Si no hay existencia, el error salta aquí y no queda rastro de una
      // venta a medias.
      const stockLines = lines.filter((l) => l.trackStock);
      const saleId = newId();
      const occurredAt = new Date();

      const posted =
        stockLines.length > 0
          ? await this.stock.post({
              movementType: MovementType.SALE,
              direction: MovementDirection.OUT,
              referenceType: ReferenceType.SALE,
              referenceId: saleId,
              referenceFolio: folio,
              userId: actor.id,
              terminalId: ctx.terminalId,
              channelId: ctx.channelId,
              occurredAt,
              allowNegative:
                dto.allowNegativeStock === true &&
                actor.permissions.includes(PERMISSIONS.INVENTORY_ALLOW_NEGATIVE),
              lines: stockLines.map((l) => ({
                variantId: l.variantId,
                warehouseId: ctx.warehouseId,
                qty: l.qty,
                sku: l.skuSnapshot,
                name: l.nameSnapshot,
              })),
            })
          : [];

      // COGS congelado por variante (req. 35).
      const costByVariant = new Map<string, Decimal>();
      for (const p of posted) {
        costByVariant.set(p.variantId, p.unitCost);
      }
      const costTotal = toMoney(
        sum(lines.map((l) => (costByVariant.get(l.variantId) ?? new Decimal(0)).times(l.qty))),
      );

      // ── 8. El documento ──
      await tx.sale.create({
        data: {
          id: saleId,
          folio,
          branchId: ctx.branchId,
          warehouseId: ctx.warehouseId,
          terminalId: ctx.terminalId,
          channelId: ctx.channelId,
          customerId: dto.customerId ?? null,
          userId: actor.id,
          cashSessionId,
          priceListId,
          status: SaleStatus.COMPLETED,
          subtotal: moneyToString(subtotal),
          discountTotal: moneyToString(discountTotal),
          taxTotal: moneyToString(taxTotal),
          total: moneyToString(total),
          costTotal: moneyToString(costTotal),
          paidTotal: moneyToString(total.minus(creditApplied)),
          changeGiven: moneyToString(changeGiven),
          balanceDue: moneyToString(creditApplied),
          idempotencyKey: dto.idempotencyKey ?? null,
          notes: dto.notes ?? null,
          occurredAt,
          items: {
            create: lines.map((l) => ({
              id: newId(),
              lineNumber: l.lineNumber,
              variantId: l.variantId,
              warehouseId: ctx.warehouseId,
              skuSnapshot: l.skuSnapshot,
              nameSnapshot: l.nameSnapshot,
              barcodeSnapshot: l.barcodeSnapshot,
              qty: qtyToString(l.qty),
              unitPrice: moneyToString(l.unitPrice),
              unitCost: moneyToString(costByVariant.get(l.variantId) ?? new Decimal(0)),
              discountAmount: moneyToString(l.discountAmount),
              discountPercent: l.discountPercent.toFixed(6),
              discountReason: l.discountReason,
              discountByUserId: l.discountAmount.isZero() ? null : actor.id,
              taxRate: l.taxRate.toFixed(6),
              taxAmount: moneyToString(l.taxAmount),
              lineSubtotal: moneyToString(l.lineSubtotal),
              lineTotal: moneyToString(l.lineTotal),
              priceListId: l.priceListId,
            })),
          },
          payments: {
            create: payments.map((p) => ({
              id: newId(),
              paymentMethodId: p.paymentMethodId,
              amount: moneyToString(p.amount),
              reference: p.reference,
              // TODOS los cobros del turno quedan enlazados, muevan o no el
              // cajón: es lo que permite desglosar el corte por forma de pago.
              cashSessionId,
              userId: actor.id,
              channelId: ctx.channelId,
              occurredAt,
            })),
          },
        },
      });

      // ── 9. Caja: el efectivo que realmente entra al cajón ──
      if (cashSessionId && cashApplied.gt(0)) {
        await tx.cashMovement.create({
          data: {
            id: newId(),
            cashSessionId,
            type: CashMovementType.SALE,
            amount: moneyToString(cashApplied),
            referenceType: ReferenceType.SALE,
            referenceId: saleId,
            referenceFolio: folio,
            userId: actor.id,
            occurredAt,
          },
        });
      }

      // ── Cuenta corriente: el cargo a crédito y las métricas del cliente ──
      if (customer) {
        if (creditApplied.gt(0)) {
          await tx.customerAccountEntry.create({
            data: {
              id: newId(),
              customerId: customer.id,
              type: 'CHARGE',
              amount: moneyToString(creditApplied),
              balanceAfter: moneyToString(creditBalance.plus(creditApplied)),
              referenceType: ReferenceType.SALE,
              referenceId: saleId,
              referenceFolio: folio,
              userId: actor.id,
              occurredAt,
            },
          });
        }
        await refreshCustomerMetrics(tx, customer.id);
      }

      // ── 10. Rastro ──
      await this.audit.record({
        action: 'sale.create',
        entityType: 'Sale',
        entityId: saleId,
        entityLabel: folio,
        userId: actor.id,
        branchId: ctx.branchId,
        after: { folio, total: moneyToString(total), items: lines.length },
      });

      await this.outbox.publish({
        eventType: 'sale.completed',
        aggregateType: 'Sale',
        aggregateId: saleId,
        payload: {
          saleId,
          folio,
          branchId: ctx.branchId,
          total: moneyToString(total),
          occurredAt: occurredAt.toISOString(),
        },
      });

      return this.findOne(saleId, actor);
    });
  }

  /**
   * Valida los pagos contra el total.
   *
   * Reglas:
   *   · La suma de lo aplicado debe cuadrar con el total, al centavo.
   *   · Solo el efectivo admite entregar de más: la diferencia es el cambio.
   *   · Un método que exige referencia (tarjeta, transferencia) no pasa sin ella.
   */
  private async resolvePayments(
    tx: Prisma.TransactionClient,
    dto: CreateSaleDto,
    total: Decimal,
  ) {
    if (dto.payments.length === 0) {
      throw new ValidationError('La venta necesita al menos una forma de pago');
    }

    const codes = dto.payments.map((p) => p.methodCode);
    const methods = await tx.paymentMethod.findMany({
      where: { code: { in: codes }, isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        affectsCash: true,
        requiresReference: true,
        allowsChange: true,
      },
    });

    const methodByCode = new Map(methods.map((m) => [m.code, m]));

    const payments = dto.payments.map((p) => {
      const method = methodByCode.get(p.methodCode);
      if (!method) throw new NotFoundError(`la forma de pago ${p.methodCode}`);

      const amount = toMoney(p.amount);
      if (amount.lte(0)) {
        throw new ValidationError('El importe de un pago debe ser mayor que cero', {
          methodCode: p.methodCode,
        });
      }
      if (method.requiresReference && !p.reference) {
        throw new ValidationError(`${method.name} necesita un número de referencia`, {
          methodCode: p.methodCode,
        });
      }

      return {
        paymentMethodId: method.id,
        methodCode: method.code,
        kind: method.kind,
        amount,
        reference: p.reference ?? null,
        affectsCash: method.affectsCash,
        allowsChange: method.allowsChange,
      };
    });

    const applied = toMoney(sum(payments.map((p) => p.amount)));

    if (!applied.equals(total)) {
      throw new ValidationError(
        `Los pagos suman ${applied.toFixed(2)} y la venta es de ${total.toFixed(2)}`,
        { applied: applied.toFixed(2), total: total.toFixed(2) },
      );
    }

    const cashApplied = toMoney(
      sum(payments.filter((p) => p.affectsCash).map((p) => p.amount)),
    );

    // El cambio sale de lo que el cliente entregó, no de lo aplicado.
    let changeGiven = new Decimal(0);
    if (dto.cashReceived !== undefined && dto.cashReceived !== null) {
      const received = toMoney(dto.cashReceived);
      if (received.lt(cashApplied)) {
        throw new ValidationError(
          `El efectivo recibido (${received.toFixed(2)}) es menor que la parte a pagar en efectivo (${cashApplied.toFixed(2)})`,
          { received: received.toFixed(2), required: cashApplied.toFixed(2) },
        );
      }
      changeGiven = toMoney(received.minus(cashApplied));
    }

    return { payments, cashApplied, changeGiven };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CANCELAR
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Cancelación de una venta completa.
   *
   * Reglas:
   *   · Solo dentro del MISMO turno de caja. Si ya se hizo el corte, el corte
   *     es un documento cerrado y no se reescribe: lo que procede es una
   *     devolución, que entra al turno actual.
   *   · Una venta con devoluciones no se cancela: ya se devolvió una parte y
   *     cancelarla devolvería dos veces la misma mercancía.
   *   · Exige `sale.cancel`. Un cajero sin él puede cancelar con el PIN de un
   *     supervisor, y queda registrado quién autorizó.
   *
   * La mercancía regresa al costo con el que salió (el del kardex de la venta),
   * no al promedio de hoy: así la cancelación deja el inventario valuado
   * exactamente como estaba.
   */
  async cancel(
    id: string,
    dto: { reason: string; supervisorPin?: string },
    actor: AuthenticatedUser,
  ) {
    const reason = dto.reason?.trim();
    if (!reason || reason.length < 3) {
      throw new ValidationError('Escribe el motivo de la cancelación');
    }

    const sale = await this.prisma.client.sale.findUnique({
      where: { id },
      select: {
        id: true,
        folio: true,
        status: true,
        branchId: true,
        userId: true,
        customerId: true,
        total: true,
        cashSessionId: true,
        cashSession: { select: { status: true } },
        items: { select: { returnedQty: true } },
      },
    });
    if (!sale) throw new NotFoundError('la venta', id);

    let authorizedById: string | null = null;
    if (!actor.permissions.includes(PERMISSIONS.SALE_CANCEL)) {
      if (!dto.supervisorPin) {
        throw new ForbiddenError('Cancelar una venta requiere autorización de un supervisor', {
          requiredPermission: PERMISSIONS.SALE_CANCEL,
        });
      }
      const supervisor = await this.auth.authorize(
        sale.branchId,
        dto.supervisorPin,
        PERMISSIONS.SALE_CANCEL,
        `Cancelar venta ${sale.folio}: ${reason}`,
      );
      authorizedById = supervisor.userId;
    }

    if (sale.status === SaleStatus.CANCELLED) {
      throw new ConflictError(`La venta ${sale.folio} ya estaba cancelada`);
    }
    if (sale.status !== SaleStatus.COMPLETED || sale.items.some((i) => !i.returnedQty.isZero())) {
      throw new ConflictError(
        `La venta ${sale.folio} tiene devoluciones registradas; ya no puede cancelarse completa`,
      );
    }
    if (sale.cashSession && sale.cashSession.status !== 'OPEN') {
      throw new ConflictError(
        `Ya se hizo el corte de la caja de la venta ${sale.folio}. Registra una devolución en su lugar.`,
      );
    }

    return this.prisma.transaction(async (tx) => {
      // Cerrojo sobre la venta: dos cancelaciones simultáneas no pasan las dos.
      const locked = await tx.$queryRaw<{ status: SaleStatus }[]>`
        SELECT status FROM sales WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked[0]?.status !== SaleStatus.COMPLETED) {
        throw new ConflictError(`La venta ${sale.folio} ya no está vigente`);
      }

      const occurredAt = new Date();

      // ── 1. La mercancía vuelve, al costo con el que salió ──
      const outbound = await tx.stockLedger.findMany({
        where: {
          referenceType: ReferenceType.SALE,
          referenceId: id,
          movementType: MovementType.SALE,
        },
        select: { variantId: true, warehouseId: true, condition: true, qty: true, unitCost: true },
      });

      if (outbound.length > 0) {
        await this.stock.post({
          movementType: MovementType.SALE_CANCEL,
          direction: MovementDirection.IN,
          referenceType: ReferenceType.SALE,
          referenceId: id,
          referenceFolio: sale.folio,
          userId: actor.id,
          reasonCode: 'CANCELACION',
          notes: reason,
          occurredAt,
          lines: outbound.map((row) => ({
            variantId: row.variantId,
            warehouseId: row.warehouseId,
            condition: row.condition,
            qty: row.qty.toString(),
            unitCost: row.unitCost?.toString() ?? '0',
          })),
        });
      }

      // ── 2. Los pagos quedan anulados ──
      const payments = await tx.payment.findMany({
        where: { saleId: id, status: 'CAPTURED' },
        select: { id: true, amount: true, paymentMethod: { select: { affectsCash: true } } },
      });

      await tx.payment.updateMany({
        where: { saleId: id, status: 'CAPTURED' },
        data: { status: 'VOIDED' },
      });

      // ── 3. El efectivo sale del cajón ──
      const cashToReturn = toMoney(
        sum(
          payments
            .filter((p) => p.paymentMethod.affectsCash)
            .map((p) => money(p.amount.toString())),
        ),
      );

      if (sale.cashSessionId && cashToReturn.gt(0)) {
        await tx.cashMovement.create({
          data: {
            id: newId(),
            cashSessionId: sale.cashSessionId,
            type: CashMovementType.RETURN_REFUND,
            amount: moneyToString(cashToReturn),
            referenceType: ReferenceType.SALE,
            referenceId: id,
            referenceFolio: sale.folio,
            reason: `Cancelación: ${reason}`,
            userId: actor.id,
            authorizedByUserId: authorizedById,
            occurredAt,
          },
        });
      }

      // ── 4. Si se vendió a crédito, el cargo se revierte en la cuenta ──
      if (sale.customerId) {
        await this.reverseCustomerCharge(tx, sale.customerId, id, sale.folio, actor.id);
      }

      // Las notas de crédito con que se pagó vuelven a tener saldo.
      await this.restoreCreditNotes(tx, id);

      // ── 5. El documento ──
      await tx.sale.update({
        where: { id },
        data: {
          status: SaleStatus.CANCELLED,
          cancelledAt: occurredAt,
          cancelledById: authorizedById ?? actor.id,
          cancelReason: reason,
        },
      });

      if (sale.customerId) await refreshCustomerMetrics(tx, sale.customerId);

      await this.audit.record({
        action: 'sale.cancel',
        entityType: 'Sale',
        entityId: id,
        entityLabel: sale.folio,
        userId: actor.id,
        branchId: sale.branchId,
        reason,
        authorizedByUserId: authorizedById ?? undefined,
        before: { status: SaleStatus.COMPLETED },
        after: { status: SaleStatus.CANCELLED, cashReturned: moneyToString(cashToReturn) },
      });

      await this.outbox.publish({
        eventType: 'sale.cancelled',
        aggregateType: 'Sale',
        aggregateId: id,
        payload: { saleId: id, folio: sale.folio, reason, occurredAt: occurredAt.toISOString() },
      });

      return this.findOne(id, actor);
    });
  }

  private async restoreCreditNotes(tx: Prisma.TransactionClient, saleId: string) {
    const used = await tx.payment.findMany({
      where: { saleId, paymentMethod: { kind: 'STORE_CREDIT' } },
      select: { amount: true, reference: true },
    });
    for (const payment of used) {
      const note = await tx.creditNote.findFirst({
        where: { folio: (payment.reference ?? '').trim().toUpperCase() },
        select: { id: true, usedAmount: true },
      });
      if (!note) continue;
      const remaining = Decimal.max(
        0,
        money(note.usedAmount.toString()).minus(money(payment.amount.toString())),
      );
      await tx.creditNote.update({
        where: { id: note.id },
        data: {
          usedAmount: moneyToString(remaining),
          status: remaining.isZero() ? 'ACTIVE' : 'PARTIALLY_USED',
        },
      });
    }
  }

  /** Revierte el cargo a crédito de una venta en la cuenta corriente del cliente. */
  private async reverseCustomerCharge(
    tx: Prisma.TransactionClient,
    customerId: string,
    saleId: string,
    folio: string,
    userId: string,
  ) {
    const charges = await tx.customerAccountEntry.findMany({
      where: { customerId, referenceType: ReferenceType.SALE, referenceId: saleId, type: 'CHARGE' },
      select: { amount: true },
    });
    const charged = toMoney(sum(charges.map((c) => money(c.amount.toString()))));
    if (charged.isZero()) return;

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
        type: 'ADJUSTMENT',
        amount: moneyToString(charged.negated()),
        balanceAfter: moneyToString(balance.minus(charged)),
        referenceType: ReferenceType.SALE,
        referenceId: saleId,
        referenceFolio: folio,
        notes: 'Cancelación de venta a crédito',
        userId,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONSULTAR
  // ═══════════════════════════════════════════════════════════════════════════

  async findOne(id: string, actor: AuthenticatedUser) {
    const sale = await this.prisma.client.sale.findUnique({
      where: { id },
      include: {
        items: { orderBy: { lineNumber: 'asc' } },
        payments: { include: { paymentMethod: { select: { code: true, name: true } } } },
        customer: { select: { id: true, ...CUSTOMER_NAME_SELECT, rfc: true, phone: true } },
        user: { select: { id: true, name: true } },
        branch: {
          select: {
            id: true,
            name: true,
            code: true,
            phone: true,
            address: true,
            company: {
              select: { name: true, legalName: true, rfc: true, phone: true, address: true },
            },
          },
        },
        terminal: { select: { id: true, name: true } },
      },
    });

    if (!sale) throw new NotFoundError('la venta', id);

    const addressLine = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') return null;
      const a = value as Record<string, unknown>;
      if (typeof a.line === 'string') return a.line;
      const parts = [a.street, a.number, a.neighborhood, a.city, a.state, a.postalCode]
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
      return parts.length > 0 ? parts.join(', ') : null;
    };

    // Quien no tiene `sale.view_all` solo ve lo suyo.
    if (
      !actor.permissions.includes(PERMISSIONS.SALE_VIEW_ALL) &&
      sale.userId !== actor.id
    ) {
      throw new ForbiddenError('Solo puedes consultar las ventas que tú registraste');
    }

    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);

    return {
      id: sale.id,
      folio: sale.folio,
      status: sale.status,
      occurredAt: sale.occurredAt,
      branch: { id: sale.branch.id, name: sale.branch.name, code: sale.branch.code },
      issuer: {
        name: sale.branch.company.name,
        legalName: sale.branch.company.legalName,
        rfc: sale.branch.company.rfc,
        phone: sale.branch.phone ?? sale.branch.company.phone,
        address: addressLine(sale.branch.address) ?? addressLine(sale.branch.company.address),
      },
      terminal: sale.terminal,
      cashier: sale.user,
      customer: sale.customer
        ? {
            id: sale.customer.id,
            name: customerDisplayName(sale.customer),
            rfc: sale.customer.rfc,
            phone: sale.customer.phone,
          }
        : null,
      subtotal: sale.subtotal.toString(),
      discountTotal: sale.discountTotal.toString(),
      taxTotal: sale.taxTotal.toString(),
      total: sale.total.toString(),
      paidTotal: sale.paidTotal.toString(),
      changeGiven: sale.changeGiven.toString(),
      ...(showCost
        ? {
            costTotal: sale.costTotal.toString(),
            profit: money(sale.subtotal.toString())
              .minus(money(sale.costTotal.toString()))
              .toFixed(4),
          }
        : {}),
      notes: sale.notes,
      cancelledAt: sale.cancelledAt,
      cancelReason: sale.cancelReason,
      balanceDue: sale.balanceDue.toString(),
      items: sale.items.map((item) => ({
        id: item.id,
        lineNumber: item.lineNumber,
        variantId: item.variantId,
        sku: item.skuSnapshot,
        name: item.nameSnapshot,
        qty: item.qty.toString(),
        unitPrice: item.unitPrice.toString(),
        discountAmount: item.discountAmount.toString(),
        taxAmount: item.taxAmount.toString(),
        lineSubtotal: item.lineSubtotal.toString(),
        lineTotal: item.lineTotal.toString(),
        returnedQty: item.returnedQty.toString(),
        ...(showCost ? { unitCost: item.unitCost.toString() } : {}),
      })),
      payments: sale.payments.map((payment) => ({
        methodCode: payment.paymentMethod.code,
        methodName: payment.paymentMethod.name,
        amount: payment.amount.toString(),
        reference: payment.reference,
        status: payment.status,
      })),
    };
  }

  /** Historial paginado por cursor: el POS carga más al llegar al final. */
  async list(
    query: {
      search?: string;
      branchId?: string;
      customerId?: string;
      userId?: string;
      status?: SaleStatus;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: number;
    },
    actor: AuthenticatedUser,
  ) {
    const limit = Math.min(query.limit ?? 50, 200);

    const where: Prisma.SaleWhereInput = {};

    if (!actor.permissions.includes(PERMISSIONS.SALE_VIEW_ALL)) {
      where.userId = actor.id;
    } else if (query.userId) {
      where.userId = query.userId;
    }

    if (query.branchId) where.branchId = query.branchId;
    else if (actor.branchIds.length > 0) where.branchId = { in: actor.branchIds };

    if (query.customerId) where.customerId = query.customerId;
    if (query.status) where.status = query.status;

    if (query.from || query.to) {
      where.occurredAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    if (query.search) {
      where.folio = { contains: query.search.trim(), mode: 'insensitive' };
    }

    const rows = await this.prisma.client.sale.findMany({
      where,
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: { occurredAt: 'desc' },
      select: {
        id: true,
        folio: true,
        status: true,
        occurredAt: true,
        total: true,
        user: { select: { id: true, name: true } },
        customer: { select: { id: true, ...CUSTOMER_NAME_SELECT } },
        payments: {
          select: { amount: true, paymentMethod: { select: { code: true, name: true } } },
        },
        _count: { select: { items: true } },
      },
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: data.map((sale) => ({
        id: sale.id,
        folio: sale.folio,
        status: sale.status,
        occurredAt: sale.occurredAt,
        total: sale.total.toString(),
        itemCount: sale._count.items,
        cashier: sale.user,
        customer: sale.customer
          ? { id: sale.customer.id, name: customerDisplayName(sale.customer) }
          : null,
        // El método dominante es el que más aportó: es lo que el cajero busca.
        paymentMethods: sale.payments.map((p) => p.paymentMethod.name),
      })),
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    };
  }
}
