import { Prisma, SaleStatus } from '@prisma/client';
import { money, moneyToString, toMoney } from '@pv/domain-rules';

/**
 * Métricas derivadas del cliente: total comprado, número de compras, ticket
 * promedio y última compra.
 *
 * Se recalculan desde las ventas en vez de sumarse a mano: un incremento suelto
 * se descuadra con la primera cancelación o devolución, y un recálculo no.
 * Va dentro de la misma transacción que la venta, la cancelación o la
 * devolución que lo provoca.
 */
export async function refreshCustomerMetrics(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  const [aggregate, returned, last] = await Promise.all([
    tx.sale.aggregate({
      where: { customerId, status: { not: SaleStatus.CANCELLED } },
      _sum: { total: true },
      _count: { _all: true },
    }),
    tx.return.aggregate({
      where: { sale: { customerId }, status: 'COMPLETED' },
      _sum: { total: true },
    }),
    tx.sale.findFirst({
      where: { customerId, status: { not: SaleStatus.CANCELLED } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
  ]);

  const count = aggregate._count._all;
  const total = toMoney(
    money(aggregate._sum.total?.toString() ?? '0').minus(
      money(returned._sum.total?.toString() ?? '0'),
    ),
  );

  await tx.customer.update({
    where: { id: customerId },
    data: {
      totalPurchased: moneyToString(total),
      purchaseCount: count,
      averageTicket: moneyToString(count > 0 ? toMoney(total.dividedBy(count)) : total.times(0)),
      lastPurchaseAt: last?.occurredAt ?? null,
    },
  });
}
