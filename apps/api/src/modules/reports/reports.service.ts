import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { money } from '@pv/domain-rules';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { PrismaService } from '../../core/database/prisma.service';
import { ValidationError } from '../../core/errors/domain-errors';
import { PricingService } from '../catalog/pricing.service';
import { PosContextService } from '../pos-context/pos-context.service';

/**
 * REPORTES.
 *
 * Reglas que no se negocian:
 *   · La utilidad usa el costo CONGELADO de cada venta (`sale_items.unit_cost`),
 *     no el costo de hoy: si el proveedor subió el precio, la utilidad de la
 *     semana pasada no cambia.
 *   · Las ventas canceladas no cuentan; las devoluciones se restan aparte, en
 *     su propio renglón, para que se vean.
 *   · Los días se agrupan en la zona horaria de la sucursal, no en UTC: una
 *     venta de las 7 de la noche no puede caer en el día siguiente.
 *   · Sin `report.profit`, el costo y la utilidad no viajan en la respuesta.
 */

interface Range {
  from: Date;
  to: Date;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
    private readonly pricing: PricingService,
  ) {}

  async dashboard(query: { from?: string; to?: string }, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const range = this.range(query);
    const tz = ctx.timezone;
    const showProfit = actor.permissions.includes(PERMISSIONS.REPORT_PROFIT);
    const branchFilter = Prisma.sql`AND s.branch_id = ${ctx.branchId}::uuid`;

    const [totals] = await this.prisma.client.$queryRaw<
      { count: bigint; total: string; subtotal: string; cost: string; discount: string; tax: string }[]
    >`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(s.total), 0)::text AS total,
             COALESCE(SUM(s.subtotal), 0)::text AS subtotal,
             COALESCE(SUM(s.cost_total), 0)::text AS cost,
             COALESCE(SUM(s.discount_total), 0)::text AS discount,
             COALESCE(SUM(s.tax_total), 0)::text AS tax
      FROM sales s
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
      ${branchFilter}`;

    const [returns] = await this.prisma.client.$queryRaw<
      { count: bigint; total: string; subtotal: string; cost: string }[]
    >`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(r.total), 0)::text AS total,
             COALESCE(SUM(r.subtotal), 0)::text AS subtotal,
             COALESCE(SUM(r.cost_total), 0)::text AS cost
      FROM returns r
      WHERE r.status = 'COMPLETED' AND r.occurred_at BETWEEN ${range.from} AND ${range.to}
        AND r.branch_id = ${ctx.branchId}::uuid`;

    const [cancelled] = await this.prisma.client.$queryRaw<{ count: bigint; total: string }[]>`
      SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0)::text AS total
      FROM sales s
      WHERE s.status = 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
      ${branchFilter}`;

    const byDay = await this.prisma.client.$queryRaw<
      { day: string; count: bigint; total: string; cost: string; subtotal: string }[]
    >`
      SELECT to_char(s.occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
             COUNT(*) AS count,
             SUM(s.total)::text AS total,
             SUM(s.subtotal)::text AS subtotal,
             SUM(s.cost_total)::text AS cost
      FROM sales s
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
      ${branchFilter}
      GROUP BY 1 ORDER BY 1`;

    const byHour = await this.prisma.client.$queryRaw<{ hour: number; count: bigint; total: string }[]>`
      SELECT EXTRACT(HOUR FROM s.occurred_at AT TIME ZONE ${tz})::int AS hour,
             COUNT(*) AS count, SUM(s.total)::text AS total
      FROM sales s
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
      ${branchFilter}
      GROUP BY 1 ORDER BY 1`;

    const byMethod = await this.prisma.client.$queryRaw<{ code: string; name: string; total: string; count: bigint }[]>`
      SELECT pm.code, pm.name, SUM(p.amount)::text AS total, COUNT(*) AS count
      FROM payments p
      JOIN payment_methods pm ON pm.id = p.payment_method_id
      JOIN sales s ON s.id = p.sale_id
      WHERE p.status = 'CAPTURED' AND s.status <> 'CANCELLED'
        AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
      ${branchFilter}
      GROUP BY pm.code, pm.name ORDER BY SUM(p.amount) DESC`;

    const byCashier = await this.prisma.client.$queryRaw<{ id: string; name: string; count: bigint; total: string }[]>`
      SELECT u.id, u.name, COUNT(*) AS count, SUM(s.total)::text AS total
      FROM sales s JOIN users u ON u.id = s.user_id
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
      ${branchFilter}
      GROUP BY u.id, u.name ORDER BY SUM(s.total) DESC`;

    const topProducts = await this.topProducts(range, ctx.branchId, 10);
    const byCategory = await this.byCategory(range, ctx.branchId);

    const [inventory] = await this.prisma.client.$queryRaw<
      { value: string; units: string; low: bigint; out: bigint }[]
    >`
      SELECT COALESCE(SUM(b.qty_on_hand * b.avg_cost), 0)::text AS value,
             COALESCE(SUM(b.qty_on_hand), 0)::text AS units,
             COUNT(*) FILTER (WHERE v.min_stock IS NOT NULL AND b.qty_on_hand > 0 AND b.qty_on_hand <= v.min_stock) AS low,
             COUNT(*) FILTER (WHERE b.qty_on_hand <= 0) AS out
      FROM stock_balances b
      JOIN product_variants v ON v.id = b.variant_id
      JOIN products p ON p.id = v.product_id
      JOIN warehouses w ON w.id = b.warehouse_id
      WHERE b.condition = 'GOOD' AND w.branch_id = ${ctx.branchId}::uuid
        AND v.deleted_at IS NULL AND v.is_active AND p.track_stock`;

    const [receivables] = await this.prisma.client.$queryRaw<{ total: string; customers: bigint }[]>`
      SELECT COALESCE(SUM(balance), 0)::text AS total, COUNT(*) FILTER (WHERE balance > 0) AS customers
      FROM (
        SELECT DISTINCT ON (customer_id) balance_after AS balance
        FROM customer_account_entries
        ORDER BY customer_id, occurred_at DESC
      ) last_entries`;

    const count = Number(totals?.count ?? 0);
    const total = money(totals?.total ?? '0');
    const netSales = money(totals?.subtotal ?? '0').minus(money(returns?.subtotal ?? '0'));
    const netCost = money(totals?.cost ?? '0').minus(money(returns?.cost ?? '0'));

    return {
      range: { from: range.from, to: range.to, timezone: tz },
      sales: {
        count,
        total: total.toFixed(2),
        averageTicket: count > 0 ? total.dividedBy(count).toFixed(2) : '0.00',
        discount: money(totals?.discount ?? '0').toFixed(2),
        tax: money(totals?.tax ?? '0').toFixed(2),
      },
      returns: { count: Number(returns?.count ?? 0), total: money(returns?.total ?? '0').toFixed(2) },
      cancelled: { count: Number(cancelled?.count ?? 0), total: money(cancelled?.total ?? '0').toFixed(2) },
      netTotal: total.minus(money(returns?.total ?? '0')).toFixed(2),
      ...(showProfit
        ? {
            profit: {
              netSales: netSales.toFixed(2),
              cost: netCost.toFixed(2),
              grossProfit: netSales.minus(netCost).toFixed(2),
              margin: netSales.isZero()
                ? '0'
                : netSales.minus(netCost).dividedBy(netSales).times(100).toFixed(1),
            },
          }
        : {}),
      byDay: byDay.map((d) => ({
        day: d.day,
        count: Number(d.count),
        total: money(d.total).toFixed(2),
        ...(showProfit ? { profit: money(d.subtotal).minus(money(d.cost)).toFixed(2) } : {}),
      })),
      byHour: byHour.map((h) => ({ hour: h.hour, count: Number(h.count), total: money(h.total).toFixed(2) })),
      byMethod: byMethod.map((m) => ({
        code: m.code,
        name: m.name,
        count: Number(m.count),
        total: money(m.total).toFixed(2),
      })),
      byCashier: byCashier.map((c) => ({
        id: c.id,
        name: c.name,
        count: Number(c.count),
        total: money(c.total).toFixed(2),
      })),
      byCategory: byCategory.map((c) => ({
        ...c,
        ...(showProfit ? {} : { profit: undefined }),
      })),
      topProducts: topProducts.map((p) => ({
        ...p,
        ...(showProfit ? {} : { profit: undefined }),
      })),
      inventory: actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW)
        ? {
            value: money(inventory?.value ?? '0').toFixed(2),
            units: money(inventory?.units ?? '0').toString(),
            lowStock: Number(inventory?.low ?? 0),
            outOfStock: Number(inventory?.out ?? 0),
          }
        : {
            units: money(inventory?.units ?? '0').toString(),
            lowStock: Number(inventory?.low ?? 0),
            outOfStock: Number(inventory?.out ?? 0),
          },
      receivables: {
        total: money(receivables?.total ?? '0').toFixed(2),
        customers: Number(receivables?.customers ?? 0),
      },
    };
  }

  /** Detalle de ventas por artículo, para exportar. */
  async productSales(query: { from?: string; to?: string; limit?: number }, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const rows = await this.topProducts(this.range(query), ctx.branchId, Math.min(query.limit ?? 500, 2000));
    const showProfit = actor.permissions.includes(PERMISSIONS.REPORT_PROFIT);
    return rows.map((r) => (showProfit ? r : { ...r, profit: undefined, cost: undefined }));
  }

  /** Valuación de inventario por artículo (exige ver costos). */
  async inventoryValuation(actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const rows = await this.prisma.client.$queryRaw<
      { sku: string; name: string; category: string | null; qty: string; avg_cost: string; value: string; price: string }[]
    >`
      SELECT v.sku, p.name || COALESCE(' ' || v.name_suffix, '') AS name, c.name AS category,
             b.qty_on_hand::text AS qty, b.avg_cost::text AS avg_cost,
             (b.qty_on_hand * b.avg_cost)::text AS value, v.base_price::text AS price
      FROM stock_balances b
      JOIN product_variants v ON v.id = b.variant_id
      JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      JOIN warehouses w ON w.id = b.warehouse_id
      WHERE b.condition = 'GOOD' AND w.branch_id = ${ctx.branchId}::uuid AND v.deleted_at IS NULL
      ORDER BY (b.qty_on_hand * b.avg_cost) DESC`;

    return rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      category: r.category,
      qty: money(r.qty).toString(),
      avgCost: money(r.avg_cost).toFixed(2),
      value: money(r.value).toFixed(2),
      price: money(r.price).toFixed(2),
    }));
  }

  /**
   * Ventas del periodo, ticket por ticket: el «reporte de ventas» de
   * mostrador. Incluye las canceladas marcadas, para que el corte cuadre a la
   * vista. `wholesale` filtra solo las ventas de mayoreo.
   */
  async salesDetail(
    query: { from?: string; to?: string; userId?: string; wholesale?: boolean },
    actor: AuthenticatedUser,
  ) {
    const ctx = await this.posContext.resolve(actor);
    const range = this.range(query);
    const wholesaleListId = await this.pricing.wholesalePriceListId();
    const userFilter = query.userId ? Prisma.sql`AND s.user_id = ${query.userId}::uuid` : Prisma.empty;
    const wholesaleFilter = query.wholesale
      ? Prisma.sql`AND s.price_list_id = ${wholesaleListId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.client.$queryRaw<
      {
        id: string;
        folio: string;
        occurred_at: Date;
        status: string;
        cashier: string;
        customer: string | null;
        items: string;
        total: string;
        subtotal: string;
        cost: string;
        methods: string | null;
        wholesale: boolean;
      }[]
    >`
      SELECT s.id, s.folio, s.occurred_at, s.status::text AS status, u.name AS cashier,
             COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), c.business_name) AS customer,
             (SELECT COALESCE(SUM(si.qty), 0) FROM sale_items si WHERE si.sale_id = s.id)::text AS items,
             s.total::text AS total, s.subtotal::text AS subtotal, s.cost_total::text AS cost,
             (SELECT string_agg(DISTINCT pm.name, ', ')
                FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id
               WHERE p.sale_id = s.id) AS methods,
             (s.price_list_id IS NOT DISTINCT FROM ${wholesaleListId}::uuid) AS wholesale
      FROM sales s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.occurred_at BETWEEN ${range.from} AND ${range.to}
        AND s.branch_id = ${ctx.branchId}::uuid
        ${userFilter} ${wholesaleFilter}
      ORDER BY s.occurred_at DESC
      LIMIT 2000`;

    const showProfit = actor.permissions.includes(PERMISSIONS.REPORT_PROFIT);
    const valid = rows.filter((r) => r.status !== 'CANCELLED');
    const total = valid.reduce((acc, r) => acc.plus(money(r.total)), money('0'));
    const profit = valid.reduce(
      (acc, r) => acc.plus(money(r.subtotal)).minus(money(r.cost)),
      money('0'),
    );

    return {
      range: { from: range.from, to: range.to, timezone: ctx.timezone },
      summary: {
        count: valid.length,
        cancelled: rows.length - valid.length,
        total: total.toFixed(2),
        averageTicket: valid.length > 0 ? total.dividedBy(valid.length).toFixed(2) : '0.00',
        ...(showProfit ? { profit: profit.toFixed(2) } : {}),
      },
      data: rows.map((r) => ({
        id: r.id,
        folio: r.folio,
        occurredAt: r.occurred_at,
        status: r.status,
        cashier: r.cashier,
        customer: r.customer,
        items: money(r.items).toString(),
        total: money(r.total).toFixed(2),
        methods: r.methods ?? '',
        wholesale: r.wholesale,
        ...(showProfit ? { profit: money(r.subtotal).minus(money(r.cost)).toFixed(2) } : {}),
      })),
    };
  }

  /** Ventas de mayoreo: resumen, ticket por ticket y por artículo. */
  async wholesaleSales(query: { from?: string; to?: string }, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const range = this.range(query);
    const wholesaleListId = await this.pricing.wholesalePriceListId();
    const detail = await this.salesDetail({ ...query, wholesale: true }, actor);

    const products = await this.prisma.client.$queryRaw<
      { sku: string; name: string; qty: string; total: string }[]
    >`
      SELECT si.sku_snapshot AS sku, MAX(si.name_snapshot) AS name,
             SUM(si.qty - si.returned_qty)::text AS qty,
             SUM(si.line_total * (1 - si.returned_qty / NULLIF(si.qty, 0)))::text AS total
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
        AND s.branch_id = ${ctx.branchId}::uuid
        AND s.price_list_id = ${wholesaleListId}::uuid
      GROUP BY si.sku_snapshot
      ORDER BY 4 DESC NULLS LAST
      LIMIT 500`;

    return {
      ...detail,
      products: products.map((p) => ({
        sku: p.sku,
        name: p.name,
        qty: money(p.qty ?? '0').toString(),
        total: money(p.total ?? '0').toFixed(2),
      })),
    };
  }

  /**
   * Inventario de la sucursal, artículo por artículo, con su estado: en
   * negativo (se vendió sin existencia y falta capturar la entrada), agotado,
   * bajo el mínimo u ok. Los artículos sin movimientos salen en cero.
   */
  async inventoryStatus(
    query: { filter?: 'all' | 'negative' | 'out' | 'low' },
    actor: AuthenticatedUser,
  ) {
    const ctx = await this.posContext.resolve(actor);
    const rows = await this.prisma.client.$queryRaw<
      {
        variant_id: string;
        sku: string;
        name: string;
        category: string | null;
        qty: string;
        min_stock: string | null;
        avg_cost: string;
        price: string;
      }[]
    >`
      SELECT v.id AS variant_id, v.sku, p.name || COALESCE(' ' || v.name_suffix, '') AS name,
             c.name AS category,
             COALESCE(b.qty_on_hand, 0)::text AS qty,
             v.min_stock::text AS min_stock,
             COALESCE(b.avg_cost, v.cost)::text AS avg_cost,
             v.base_price::text AS price
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN stock_balances b
        ON b.variant_id = v.id AND b.condition = 'GOOD' AND b.warehouse_id = ${ctx.warehouseId}::uuid
      WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL AND v.is_active AND p.is_active
        AND p.track_stock
      ORDER BY p.name, v.sku`;

    const showCost = actor.permissions.includes(PERMISSIONS.PRODUCT_COST_VIEW);

    const items = rows.map((r) => {
      const qty = money(r.qty);
      const min = r.min_stock !== null ? money(r.min_stock) : null;
      const status: 'NEGATIVE' | 'OUT' | 'LOW' | 'OK' = qty.lt(0)
        ? 'NEGATIVE'
        : qty.isZero()
          ? 'OUT'
          : min !== null && qty.lte(min)
            ? 'LOW'
            : 'OK';
      return {
        variantId: r.variant_id,
        sku: r.sku,
        name: r.name,
        category: r.category,
        qty: qty.toString(),
        minStock: min?.toString() ?? null,
        price: money(r.price).toFixed(2),
        status,
        ...(showCost
          ? { cost: money(r.avg_cost).toFixed(2), value: qty.times(money(r.avg_cost)).toFixed(2) }
          : {}),
      };
    });

    const filter = query.filter ?? 'all';
    const filtered = items.filter((i) =>
      filter === 'negative'
        ? i.status === 'NEGATIVE'
        : filter === 'out'
          ? i.status === 'OUT' || i.status === 'NEGATIVE'
          : filter === 'low'
            ? i.status === 'LOW'
            : true,
    );

    return {
      summary: {
        products: items.length,
        negative: items.filter((i) => i.status === 'NEGATIVE').length,
        out: items.filter((i) => i.status === 'OUT').length,
        low: items.filter((i) => i.status === 'LOW').length,
        ...(showCost
          ? {
              value: items
                .filter((i) => money(i.qty).gt(0))
                .reduce((acc, i) => acc.plus(money(i.value ?? '0')), money('0'))
                .toFixed(2),
            }
          : {}),
      },
      data: filtered,
    };
  }

  private async topProducts(range: Range, branchId: string, limit: number) {
    const rows = await this.prisma.client.$queryRaw<
      { variant_id: string; sku: string; name: string; qty: string; total: string; subtotal: string; cost: string }[]
    >`
      SELECT si.variant_id, si.sku_snapshot AS sku, MAX(si.name_snapshot) AS name,
             SUM(si.qty - si.returned_qty)::text AS qty,
             SUM(si.line_total * (1 - si.returned_qty / NULLIF(si.qty, 0)))::text AS total,
             SUM(si.line_subtotal * (1 - si.returned_qty / NULLIF(si.qty, 0)))::text AS subtotal,
             SUM(si.unit_cost * (si.qty - si.returned_qty))::text AS cost
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
        AND s.branch_id = ${branchId}::uuid
      GROUP BY si.variant_id, si.sku_snapshot
      HAVING SUM(si.qty - si.returned_qty) > 0
      ORDER BY SUM(si.line_total * (1 - si.returned_qty / NULLIF(si.qty, 0))) DESC
      LIMIT ${limit}`;

    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      name: r.name,
      qty: money(r.qty).toString(),
      total: money(r.total ?? '0').toFixed(2),
      cost: money(r.cost ?? '0').toFixed(2) as string | undefined,
      profit: money(r.subtotal ?? '0').minus(money(r.cost ?? '0')).toFixed(2) as string | undefined,
    }));
  }

  private async byCategory(range: Range, branchId: string) {
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
      WHERE s.status <> 'CANCELLED' AND s.occurred_at BETWEEN ${range.from} AND ${range.to}
        AND s.branch_id = ${branchId}::uuid
      GROUP BY c.name
      ORDER BY 3 DESC NULLS LAST`;

    return rows.map((r) => ({
      category: r.category ?? 'Sin categoría',
      qty: money(r.qty ?? '0').toString(),
      total: money(r.total ?? '0').toFixed(2),
      profit: money(r.subtotal ?? '0').minus(money(r.cost ?? '0')).toFixed(2) as string | undefined,
    }));
  }

  private range(query: { from?: string; to?: string }): Range {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ValidationError('Las fechas del reporte no son válidas');
    }
    if (from > to) throw new ValidationError('La fecha inicial es posterior a la final');
    if (to.getTime() - from.getTime() > 366 * 86_400_000) {
      throw new ValidationError('El periodo máximo de un reporte es de un año');
    }
    return { from, to };
  }
}
