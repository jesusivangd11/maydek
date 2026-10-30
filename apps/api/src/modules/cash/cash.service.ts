import { Injectable } from '@nestjs/common';
import { CashMovementType, CashSessionStatus, Prisma } from '@prisma/client';
import { DOC_TYPES, Decimal, money, moneyToString, sum, toMoney } from '@pv/domain-rules';
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
import { PosContextService } from '../pos-context/pos-context.service';
import type { CloseSessionDto, CreateMovementDto, OpenSessionDto } from './dto/cash.dto';

/**
 * CAJA.
 *
 * Regla que gobierna todo el módulo: el efectivo esperado NUNCA se captura, se
 * CALCULA. Es el fondo inicial más la suma de los movimientos. Si se pudiera
 * teclear, el arqueo dejaría de servir para detectar faltantes, que es lo único
 * para lo que existe.
 *
 * La diferencia entre lo esperado y lo contado se guarda siempre, incluso
 * cuando es cero. Cerrar con diferencia exige un permiso aparte
 * (`cash.close_with_difference`) para que un faltante tenga que pasar por
 * alguien con autoridad.
 */

/** Movimientos que SUMAN efectivo al cajón. El resto lo restan. */
const INFLOW_TYPES: CashMovementType[] = [
  CashMovementType.OPENING,
  CashMovementType.SALE,
  CashMovementType.CASH_IN,
];

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  APERTURA
  // ═══════════════════════════════════════════════════════════════════════════

  async open(dto: OpenSessionDto, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor, {
      branchId: dto.branchId,
      terminalId: dto.terminalId,
    });

    if (!ctx.terminalId) {
      throw new ValidationError(
        'Indica en qué terminal vas a operar: la sucursal tiene más de una',
      );
    }

    const already = await this.posContext.findOpenCashSession(ctx.terminalId);
    if (already) {
      throw new ConflictError(
        `Esta caja ya está abierta desde ${already.openedAt.toISOString()} por ${already.openedBy.name}`,
        { cashSessionId: already.id, folio: already.folio },
      );
    }

    const openingFloat = toMoney(dto.openingFloat ?? '0');
    if (openingFloat.lt(0)) {
      throw new ValidationError('El fondo inicial no puede ser negativo');
    }

    return this.prisma.transaction(async (tx) => {
      const folio = await this.sequences.next(DOC_TYPES.CASH_SESSION, ctx.branchId);
      const sessionId = newId();
      const openedAt = new Date();

      await tx.cashSession.create({
        data: {
          id: sessionId,
          folio,
          terminalId: ctx.terminalId!,
          branchId: ctx.branchId,
          status: CashSessionStatus.OPEN,
          openedById: actor.id,
          openedAt,
          openingFloat: moneyToString(openingFloat),
          notes: dto.notes ?? null,
        },
      });

      // El fondo entra como movimiento: así el esperado es siempre la suma de
      // los movimientos, sin casos especiales.
      if (openingFloat.gt(0)) {
        await tx.cashMovement.create({
          data: {
            id: newId(),
            cashSessionId: sessionId,
            type: CashMovementType.OPENING,
            amount: moneyToString(openingFloat),
            reason: 'Fondo inicial',
            userId: actor.id,
            occurredAt: openedAt,
          },
        });
      }

      await this.audit.record({
        action: 'cash.open',
        entityType: 'CashSession',
        entityId: sessionId,
        entityLabel: folio,
        userId: actor.id,
        branchId: ctx.branchId,
        after: { folio, openingFloat: moneyToString(openingFloat) },
      });

      return this.findOne(sessionId, actor);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DURANTE EL TURNO
  // ═══════════════════════════════════════════════════════════════════════════

  /** Sesión abierta de la terminal del usuario, o null si no hay. */
  async current(actor: AuthenticatedUser, hints: { branchId?: string; terminalId?: string }) {
    const ctx = await this.posContext.resolve(actor, hints);
    if (!ctx.terminalId) return null;

    const session = await this.posContext.findOpenCashSession(ctx.terminalId);
    if (!session) return null;

    return this.findOne(session.id, actor);
  }

  /**
   * Entrada o salida manual de efectivo.
   *
   * Un retiro (sacar dinero para el banco) exige `cash.withdrawal`: es el
   * movimiento por el que se puede vaciar un cajón, y tiene que estar acotado.
   */
  async createMovement(dto: CreateMovementDto, actor: AuthenticatedUser) {
    const session = await this.requireOpenSession(dto.cashSessionId, actor);
    const amount = toMoney(dto.amount);

    if (amount.lte(0)) {
      throw new ValidationError('El importe del movimiento debe ser mayor que cero');
    }

    if (
      dto.type === CashMovementType.WITHDRAWAL &&
      !actor.permissions.includes(PERMISSIONS.CASH_WITHDRAWAL)
    ) {
      throw new ForbiddenError('No tienes permiso para retirar efectivo', {
        requiredPermission: PERMISSIONS.CASH_WITHDRAWAL,
      });
    }

    // No se puede sacar más de lo que hay en el cajón.
    if (!INFLOW_TYPES.includes(dto.type)) {
      const expected = await this.expectedCash(session.id);
      if (amount.gt(expected)) {
        throw new ValidationError(
          `En la caja hay ${expected.toFixed(2)} y quieres sacar ${amount.toFixed(2)}`,
          { available: expected.toFixed(2), requested: amount.toFixed(2) },
        );
      }
    }

    const movementId = newId();

    await this.prisma.transaction(async (tx) => {
      await tx.cashMovement.create({
        data: {
          id: movementId,
          cashSessionId: session.id,
          type: dto.type,
          amount: moneyToString(amount),
          reason: dto.reason,
          userId: actor.id,
          occurredAt: new Date(),
        },
      });

      await this.audit.record({
        action: 'cash.movement.create',
        entityType: 'CashMovement',
        entityId: movementId,
        entityLabel: `${dto.type} ${amount.toFixed(2)}`,
        userId: actor.id,
        branchId: session.branchId,
        reason: dto.reason,
        after: { type: dto.type, amount: moneyToString(amount) },
      });
    });

    return this.findOne(session.id, actor);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CIERRE
  // ═══════════════════════════════════════════════════════════════════════════

  async close(dto: CloseSessionDto, actor: AuthenticatedUser) {
    const session = await this.requireOpenSession(dto.cashSessionId, actor);

    const expected = await this.expectedCash(session.id);
    const counted = toMoney(dto.countedCash);
    const difference = toMoney(counted.minus(expected));

    if (
      !difference.isZero() &&
      !actor.permissions.includes(PERMISSIONS.CASH_CLOSE_WITH_DIFFERENCE)
    ) {
      throw new ForbiddenError(
        `El arqueo tiene una diferencia de ${difference.toFixed(2)}. Necesitas autorización para cerrar así.`,
        { requiredPermission: PERMISSIONS.CASH_CLOSE_WITH_DIFFERENCE },
      );
    }

    if (!difference.isZero() && !dto.differenceReason) {
      throw new ValidationError('Explica a qué se debe la diferencia antes de cerrar', {
        difference: difference.toFixed(2),
      });
    }

    const byMethod = await this.totalsByMethod(session.id);

    return this.prisma.transaction(async (tx) => {
      const closedAt = new Date();

      await tx.cashMovement.create({
        data: {
          id: newId(),
          cashSessionId: session.id,
          type: CashMovementType.CLOSING,
          amount: moneyToString(counted),
          reason: 'Arqueo de cierre',
          userId: actor.id,
          occurredAt: closedAt,
        },
      });

      await tx.cashSession.update({
        where: { id: session.id },
        data: {
          status: CashSessionStatus.CLOSED,
          closedById: actor.id,
          closedAt,
          expectedCash: moneyToString(expected),
          countedCash: moneyToString(counted),
          difference: moneyToString(difference),
          expectedByMethod: byMethod as unknown as Prisma.InputJsonValue,
          denominations: (dto.denominations ?? null) as Prisma.InputJsonValue,
          differenceReason: dto.differenceReason ?? null,
          notes: dto.notes ?? null,
        },
      });

      await this.audit.record({
        action: 'cash.close',
        entityType: 'CashSession',
        entityId: session.id,
        entityLabel: session.folio,
        userId: actor.id,
        branchId: session.branchId,
        reason: dto.differenceReason,
        after: {
          expected: moneyToString(expected),
          counted: moneyToString(counted),
          difference: moneyToString(difference),
        },
      });

      return this.findOne(session.id, actor);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CONSULTA
  // ═══════════════════════════════════════════════════════════════════════════

  /** Corte X (sin cerrar) o Z (ya cerrado): los mismos números. */
  async findOne(id: string, actor: AuthenticatedUser) {
    const session = await this.prisma.client.cashSession.findUnique({
      where: { id },
      include: {
        terminal: { select: { id: true, name: true, code: true } },
        branch: { select: { id: true, name: true } },
        openedBy: { select: { id: true, name: true } },
        closedBy: { select: { id: true, name: true } },
        movements: {
          orderBy: { occurredAt: 'asc' },
          select: {
            id: true,
            type: true,
            amount: true,
            reason: true,
            referenceFolio: true,
            occurredAt: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!session) throw new NotFoundError('la sesión de caja', id);

    if (
      actor.branchIds.length > 0 &&
      !actor.branchIds.includes(session.branchId) &&
      !actor.permissions.includes(PERMISSIONS.CASH_REPORT_Z)
    ) {
      throw new ForbiddenError('No tienes acceso a la caja de esta sucursal');
    }

    const expected = await this.expectedCash(session.id);
    const byMethod = await this.totalsByMethod(session.id);
    const salesSummary = await this.salesSummary(session.id);
    // La utilidad es información del dueño: sin `report.profit` no viaja.
    const profit = actor.permissions.includes(PERMISSIONS.REPORT_PROFIT)
      ? await this.profitSummary(session.id)
      : undefined;

    return {
      id: session.id,
      folio: session.folio,
      status: session.status,
      branch: session.branch,
      terminal: session.terminal,
      openedBy: session.openedBy,
      closedBy: session.closedBy,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      openingFloat: session.openingFloat.toString(),
      expectedCash: expected.toFixed(4),
      countedCash: session.countedCash?.toString() ?? null,
      difference: session.difference?.toString() ?? null,
      differenceReason: session.differenceReason,
      totalsByMethod: byMethod,
      sales: salesSummary,
      ...(profit ? { profit } : {}),
      movements: session.movements.map((m) => ({
        id: m.id,
        type: m.type,
        // Signo explícito: la interfaz no debería tener que saber qué suma.
        amount: (INFLOW_TYPES.includes(m.type) ? m.amount : m.amount.negated()).toString(),
        reason: m.reason,
        reference: m.referenceFolio,
        occurredAt: m.occurredAt,
        user: m.user,
      })),
    };
  }

  async list(
    query: { branchId?: string; status?: CashSessionStatus; limit?: number },
    actor: AuthenticatedUser,
  ) {
    const limit = Math.min(query.limit ?? 30, 100);

    const sessions = await this.prisma.client.cashSession.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.branchId
          ? { branchId: query.branchId }
          : actor.branchIds.length > 0
            ? { branchId: { in: actor.branchIds } }
            : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        folio: true,
        status: true,
        openedAt: true,
        closedAt: true,
        openingFloat: true,
        countedCash: true,
        difference: true,
        terminal: { select: { name: true } },
        openedBy: { select: { id: true, name: true } },
        closedBy: { select: { id: true, name: true } },
        _count: { select: { sales: true } },
      },
    });

    return {
      data: sessions.map((s) => ({
        id: s.id,
        folio: s.folio,
        status: s.status,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        terminal: s.terminal.name,
        openedBy: s.openedBy,
        closedBy: s.closedBy,
        openingFloat: s.openingFloat.toString(),
        countedCash: s.countedCash?.toString() ?? null,
        difference: s.difference?.toString() ?? null,
        saleCount: s._count.sales,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CÁLCULO
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Efectivo que DEBERÍA haber: fondo + entradas − salidas.
   *
   * Se calcula sobre `cash_movements`, no sobre las ventas: así un retiro o una
   * entrada manual cuentan igual que un cobro.
   */
  private async expectedCash(cashSessionId: string): Promise<Decimal> {
    const movements = await this.prisma.client.cashMovement.findMany({
      where: { cashSessionId, type: { not: CashMovementType.CLOSING } },
      select: { type: true, amount: true },
    });

    return toMoney(
      sum(
        movements.map((m) =>
          INFLOW_TYPES.includes(m.type)
            ? money(m.amount.toString())
            : money(m.amount.toString()).negated(),
        ),
      ),
    );
  }

  /** Lo cobrado por forma de pago: es lo que se compara contra el datáfono. */
  private async totalsByMethod(cashSessionId: string) {
    // Los pagos de una venta cancelada quedan VOIDED y ya no cuentan; los
    // reembolsos de devoluciones son pagos negativos y sí restan.
    const payments = await this.prisma.client.payment.findMany({
      where: { cashSessionId, status: { not: 'VOIDED' } },
      select: {
        amount: true,
        paymentMethod: { select: { code: true, name: true, affectsCash: true } },
      },
    });

    const totals = new Map<string, { name: string; affectsCash: boolean; total: Decimal }>();

    for (const payment of payments) {
      const key = payment.paymentMethod.code;
      const current = totals.get(key) ?? {
        name: payment.paymentMethod.name,
        affectsCash: payment.paymentMethod.affectsCash,
        total: new Decimal(0),
      };
      current.total = current.total.plus(money(payment.amount.toString()));
      totals.set(key, current);
    }

    return [...totals.entries()].map(([code, value]) => ({
      code,
      name: value.name,
      affectsCash: value.affectsCash,
      total: value.total.toFixed(4),
    }));
  }

  private async salesSummary(cashSessionId: string) {
    const result = await this.prisma.client.sale.aggregate({
      where: { cashSessionId, status: { not: 'CANCELLED' } },
      _count: { _all: true },
      _sum: { total: true },
    });

    const count = result._count._all;
    const total = money(result._sum.total?.toString() ?? '0');

    return {
      count,
      total: total.toFixed(4),
      average: count > 0 ? total.dividedBy(count).toFixed(4) : '0.0000',
    };
  }

  /**
   * Ganancia del turno, total y por departamento (categoría).
   *
   * Ganancia neta = ventas SIN IVA, ya descontadas las devoluciones, menos el
   * costo congelado de lo vendido (`sale_items.unit_cost`, el de ese día). Las
   * ventas canceladas no cuentan. Lo vendido como «artículo común» no tiene
   * costo registrado, así que su ganancia sale al 100 %.
   */
  private async profitSummary(cashSessionId: string) {
    const rows = await this.prisma.client.$queryRaw<
      { category: string | null; qty: string; total: string; subtotal: string; cost: string }[]
    >`
      SELECT c.name AS category,
             SUM(si.qty - si.returned_qty)::text AS qty,
             SUM(si.line_total * (1 - si.returned_qty / NULLIF(si.qty, 0)))::text AS total,
             SUM(si.line_subtotal * (1 - si.returned_qty / NULLIF(si.qty, 0)))::text AS subtotal,
             SUM(si.unit_cost * (si.qty - si.returned_qty))::text AS cost
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN product_variants v ON v.id = si.variant_id
      JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.cash_session_id = ${cashSessionId}::uuid AND s.status <> 'CANCELLED'
      GROUP BY c.name
      ORDER BY SUM(si.line_subtotal * (1 - si.returned_qty / NULLIF(si.qty, 0))) DESC NULLS LAST`;

    const margin = (profit: Decimal, net: Decimal) =>
      net.isZero() ? '0.0' : profit.dividedBy(net).times(100).toFixed(1);

    const byCategory = rows.map((r) => {
      const net = money(r.subtotal ?? '0');
      const cost = money(r.cost ?? '0');
      const profit = net.minus(cost);
      return {
        category: r.category ?? 'Sin categoría',
        qty: money(r.qty ?? '0').toString(),
        total: money(r.total ?? '0').toFixed(2),
        netSales: net.toFixed(2),
        cost: cost.toFixed(2),
        profit: profit.toFixed(2),
        margin: margin(profit, net),
      };
    });

    const netSales = sum(byCategory.map((c) => money(c.netSales)));
    const cost = sum(byCategory.map((c) => money(c.cost)));
    const profit = netSales.minus(cost);

    return {
      netSales: netSales.toFixed(2),
      cost: cost.toFixed(2),
      netProfit: profit.toFixed(2),
      margin: margin(profit, netSales),
      byCategory,
    };
  }

  private async requireOpenSession(id: string, actor: AuthenticatedUser) {
    const session = await this.prisma.client.cashSession.findUnique({
      where: { id },
      select: { id: true, folio: true, status: true, branchId: true, openedById: true },
    });

    if (!session) throw new NotFoundError('la sesión de caja', id);
    if (session.status !== CashSessionStatus.OPEN) {
      throw new ConflictError('Esta sesión de caja ya está cerrada', { folio: session.folio });
    }
    if (actor.branchIds.length > 0 && !actor.branchIds.includes(session.branchId)) {
      throw new ForbiddenError('No tienes acceso a la caja de esta sucursal');
    }

    return session;
  }
}
