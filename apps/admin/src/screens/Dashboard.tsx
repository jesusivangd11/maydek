import { useState } from 'react';
import { api } from '@pos/lib/api';
import { formatMoney, formatQty, toNumber } from '@pos/lib/format';
import { Alert, Button, Card, EmptyState, PageHeader, Segmented, StatCard } from '@pos/ui';
import type { ScreenProps } from '../App';
import { daysAgo, downloadCsv, endOfDay, startOfDay, useLoad } from '../lib/util';

/**
 * Tablero.
 *
 * Responde, en este orden, lo que pregunta el dueño al abrir el sistema:
 * ¿cuánto vendí?, ¿cuánto gané?, ¿qué se vende?, ¿qué me falta?, ¿quién me
 * debe? La utilidad usa el costo congelado de cada venta: no cambia porque
 * hoy el proveedor haya subido el precio.
 */

type Period = 'today' | '7' | '30' | '90';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '90', label: '90 días' },
];

function rangeOf(period: Period) {
  const to = endOfDay(new Date());
  const from = period === 'today' ? startOfDay(new Date()) : startOfDay(daysAgo(Number(period) - 1));
  return { from, to };
}

export function DashboardScreen({ user }: ScreenProps) {
  const [period, setPeriod] = useState<Period>('30');
  const { data, error, loading } = useLoad(() => api.dashboard(rangeOf(period)), [period]);
  const canExport = user.permissions.includes('report.export');

  const maxDay = Math.max(1, ...(data?.byDay.map((d) => toNumber(d.total)) ?? [1]));
  const methodsTotal = data?.byMethod.reduce((acc, m) => acc + toNumber(m.total), 0) ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Tablero"
        subtitle="Ventas, utilidad, inventario y cobranza de la sucursal."
        actions={<Segmented options={PERIODS} value={period} onChange={setPeriod} label="Periodo" />}
      />

      {error && <Alert>{error}</Alert>}
      {loading && !data && <p className="subtle">Cargando…</p>}

      {data && (
        <>
          <div className="stats">
            <StatCard
              emphasis
              label="Ventas netas"
              value={formatMoney(data.netTotal)}
              foot={`${data.sales.count} ventas · ${formatMoney(data.returns.total)} devuelto`}
            />
            <StatCard label="Ticket promedio" value={formatMoney(data.sales.averageTicket)} />
            {data.profit && (
              <StatCard
                label="Utilidad bruta"
                value={formatMoney(data.profit.grossProfit)}
                foot={`Margen ${data.profit.margin} %`}
              />
            )}
            <StatCard
              label="Por cobrar"
              value={formatMoney(data.receivables.total)}
              foot={`${data.receivables.customers} clientes con saldo`}
            />
            <StatCard
              label="Inventario"
              value={data.inventory.value ? formatMoney(data.inventory.value) : `${formatQty(data.inventory.units)} pzas`}
              foot={`${data.inventory.lowStock} bajos · ${data.inventory.outOfStock} agotados`}
            />
            <StatCard
              label="Canceladas"
              value={String(data.cancelled.count)}
              foot={formatMoney(data.cancelled.total)}
              small
            />
          </div>

          <div className="grid-2">
            <Card title="Ventas por día">
              {data.byDay.length === 0 ? (
                <EmptyState icon="chart" title="Sin ventas en el periodo" />
              ) : (
                <div className="bars" role="img" aria-label="Gráfica de ventas por día">
                  {data.byDay.map((day) => (
                    <div
                      key={day.day}
                      className="bars__col"
                      title={`${day.day}: ${formatMoney(day.total)} en ${day.count} ventas`}
                    >
                      <div
                        className="bars__bar"
                        style={{ height: `${(toNumber(day.total) / maxDay) * 100}%` }}
                      />
                      <span className="bars__label">{day.day.slice(8)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="Formas de pago" flush>
              <div className="methods">
                {data.byMethod.map((m) => (
                  <div key={m.code} className="method-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="method-row__name">{m.name}</span>
                      <span className="method-row__amount">{formatMoney(m.total)}</span>
                    </div>
                    <div className="meter">
                      <div
                        className="meter__fill"
                        style={{ width: `${methodsTotal ? (toNumber(m.total) / methodsTotal) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
                {data.byMethod.length === 0 && <p className="subtle center">Sin cobros.</p>}
              </div>
            </Card>
          </div>

          <div className="grid-2" style={{ marginTop: 'var(--s-5)' }}>
            <Card
              title="Productos más vendidos"
              flush
              actions={
                canExport && (
                  <Button
                    size="sm"
                    variant="subtle"
                    icon="download"
                    onClick={async () => {
                      const rows = await api.productSales(rangeOf(period));
                      downloadCsv(`ventas-por-articulo-${period}.csv`, rows.map((r) => ({
                        SKU: r.sku,
                        Artículo: r.name,
                        Cantidad: r.qty,
                        Importe: r.total,
                        ...(r.profit !== undefined ? { Utilidad: r.profit } : {}),
                      })));
                    }}
                  >
                    Exportar
                  </Button>
                )
              }
            >
              <table className="table">
                <thead>
                  <tr>
                    <th>Artículo</th>
                    <th className="table__num">Cant.</th>
                    <th className="table__money">Importe</th>
                    {data.profit && <th className="table__money">Utilidad</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.topProducts.map((p) => (
                    <tr key={p.variantId}>
                      <td>
                        {p.name}
                        <div className="mono subtle text-sm">{p.sku}</div>
                      </td>
                      <td className="table__num">{formatQty(p.qty)}</td>
                      <td className="table__money">{formatMoney(p.total)}</td>
                      {data.profit && <td className="table__money">{formatMoney(p.profit)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <div className="stack">
              <Card title="Por categoría" flush>
                <table className="table">
                  <tbody>
                    {data.byCategory.map((c) => (
                      <tr key={c.category}>
                        <td>{c.category}</td>
                        <td className="table__num">{formatQty(c.qty)}</td>
                        <td className="table__money">{formatMoney(c.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Card title="Por cajero" flush>
                <table className="table">
                  <tbody>
                    {data.byCashier.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="table__num">{c.count} ventas</td>
                        <td className="table__money">{formatMoney(c.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
