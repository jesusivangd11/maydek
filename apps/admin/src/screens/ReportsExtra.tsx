import { api } from '@pos/lib/api';
import { formatDateTime, formatMoney, formatQty } from '@pos/lib/format';
import { Alert, Badge, Button, Card, EmptyState } from '@pos/ui';
import { downloadCsv, useLoad } from '../lib/util';

/**
 * Pestañas de Reportes que salen del tablero: Resumen, Departamentos y Cortes.
 *
 * La ganancia (costo, utilidad, margen) solo llega del servidor a quien tiene
 * el permiso de ver utilidad; sin él esas columnas simplemente no aparecen.
 */

export interface PeriodRange {
  from: string;
  to: string;
}

export function Stats({ items }: { items: { label: string; value: string; key?: boolean }[] }) {
  return (
    <div className="stats">
      {items.map((s) => (
        <div key={s.label} className={`stat ${s.key ? 'stat--key' : ''}`}>
          <span className="stat__label">{s.label}</span>
          <span className={`stat__value ${s.key ? '' : 'stat__value--sm'}`}>{s.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Porcentaje de `part` sobre `whole`, sin dividir entre cero. */
function pct(part: string, whole: string) {
  const w = Number(whole);
  return w > 0 ? `${((Number(part) / w) * 100).toFixed(1)} %` : '—';
}

type CategoryRows = NonNullable<Awaited<ReturnType<typeof api.dashboard>>>['byCategory'];

function CategoryTable({ rows, total }: { rows: CategoryRows; total: string }) {
  if (rows.length === 0) return <EmptyState icon="box" title="Sin ventas en el periodo" />;
  const withProfit = rows[0]?.profit !== undefined;
  return (
    <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Departamento</th>
            <th className="table__num">Piezas</th>
            <th className="table__money">Vendido</th>
            <th className="table__num">% del total</th>
            {withProfit && <th className="table__money">Costo</th>}
            {withProfit && <th className="table__money">Ganancia</th>}
            {withProfit && <th className="table__num">Margen</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.category}>
              <td>{c.category}</td>
              <td className="table__num">{formatQty(c.qty)}</td>
              <td className="table__money">{formatMoney(c.total)}</td>
              <td className="table__num subtle">{pct(c.total, total)}</td>
              {withProfit && <td className="table__money">{formatMoney(c.cost ?? '0')}</td>}
              {withProfit && (
                <td
                  className="table__money"
                  style={Number(c.profit) < 0 ? { color: 'var(--danger)' } : undefined}
                >
                  {formatMoney(c.profit ?? '0')}
                </td>
              )}
              {withProfit && <td className="table__num">{Number(c.margin ?? 0).toFixed(1)} %</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniTable({ children }: { children: React.ReactNode }) {
  return (
    <table className="table">
      <tbody>{children}</tbody>
    </table>
  );
}

export function SummaryTab({ range }: { range: PeriodRange }) {
  const report = useLoad(() => api.dashboard(range), [range.from, range.to]);
  const d = report.data;
  return (
    <>
      <div className="report-bar">
        <Button
          variant="subtle"
          icon="download"
          disabled={!d}
          onClick={() =>
            d &&
            downloadCsv(
              'resumen-por-dia.csv',
              d.byDay.map((x) => ({
                Día: x.day,
                Ventas: x.count,
                Total: x.total,
                ...(x.profit !== undefined ? { Ganancia: x.profit } : {}),
              })),
            )
          }
        >
          Exportar por día
        </Button>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {d && (
        <>
          <Stats
            items={[
              { label: 'Total vendido', value: formatMoney(d.sales.total), key: true },
              { label: 'Ventas', value: String(d.sales.count) },
              { label: 'Ticket promedio', value: formatMoney(d.sales.averageTicket) },
              { label: 'IVA', value: formatMoney(d.sales.tax) },
              { label: 'Descuentos', value: formatMoney(d.sales.discount) },
              { label: 'Devoluciones', value: `${d.returns.count} (${formatMoney(d.returns.total)})` },
              { label: 'Canceladas', value: `${d.cancelled.count} (${formatMoney(d.cancelled.total)})` },
              { label: 'Neto del periodo', value: formatMoney(d.netTotal) },
              ...(d.profit
                ? [
                    { label: 'Costo', value: formatMoney(d.profit.cost) },
                    { label: 'Ganancia neta', value: formatMoney(d.profit.grossProfit) },
                    { label: 'Margen', value: `${Number(d.profit.margin).toFixed(1)} %` },
                  ]
                : []),
            ]}
          />
          <div className="grid-2">
            <Card title="Formas de pago" flush>
              <MiniTable>
                {d.byMethod.map((m) => (
                  <tr key={m.code}>
                    <td>{m.name}</td>
                    <td className="table__num">{m.count}</td>
                    <td className="table__num subtle">{pct(m.total, d.sales.total)}</td>
                    <td className="table__money">{formatMoney(m.total)}</td>
                  </tr>
                ))}
                {d.byMethod.length === 0 && (
                  <tr>
                    <td className="subtle">Sin cobros en el periodo</td>
                  </tr>
                )}
              </MiniTable>
            </Card>
            <Card title="Por cajero" flush>
              <MiniTable>
                {d.byCashier.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="table__num">{c.count} ventas</td>
                    <td className="table__money">{formatMoney(c.total)}</td>
                  </tr>
                ))}
                {d.byCashier.length === 0 && (
                  <tr>
                    <td className="subtle">Sin ventas en el periodo</td>
                  </tr>
                )}
              </MiniTable>
            </Card>
            <Card title="Por día" flush>
              <MiniTable>
                {d.byDay.map((x) => (
                  <tr key={x.day}>
                    <td>{x.day}</td>
                    <td className="table__num">{x.count}</td>
                    <td className="table__money">{formatMoney(x.total)}</td>
                    {x.profit !== undefined && (
                      <td className="table__money subtle">{formatMoney(x.profit)}</td>
                    )}
                  </tr>
                ))}
              </MiniTable>
            </Card>
            <Card title="Por hora" flush>
              <MiniTable>
                {d.byHour
                  .filter((h) => h.count > 0)
                  .map((h) => (
                    <tr key={h.hour}>
                      <td className="tnum">{String(h.hour).padStart(2, '0')}:00</td>
                      <td className="table__num">{h.count}</td>
                      <td className="table__money">{formatMoney(h.total)}</td>
                    </tr>
                  ))}
              </MiniTable>
            </Card>
          </div>
          <Card title="Departamentos" flush>
            <CategoryTable rows={d.byCategory} total={d.sales.total} />
          </Card>
          <Card title="Los más vendidos" flush>
            <MiniTable>
              {d.topProducts.slice(0, 10).map((p) => (
                <tr key={p.variantId}>
                  <td>
                    {p.name}
                    <div className="subtle text-sm mono">{p.sku}</div>
                  </td>
                  <td className="table__num">{formatQty(p.qty)}</td>
                  <td className="table__money">{formatMoney(p.total)}</td>
                  {p.profit !== undefined && (
                    <td className="table__money subtle">{formatMoney(p.profit)}</td>
                  )}
                </tr>
              ))}
            </MiniTable>
          </Card>
        </>
      )}
    </>
  );
}

export function DepartmentsTab({ range }: { range: PeriodRange }) {
  const report = useLoad(() => api.dashboard(range), [range.from, range.to]);
  const d = report.data;
  const hasProfit = d?.byCategory[0]?.profit !== undefined;
  const profit = d?.byCategory.reduce((sum, c) => sum + Number(c.profit ?? 0), 0) ?? 0;
  return (
    <>
      <div className="report-bar">
        <Button
          variant="subtle"
          icon="download"
          disabled={!d || d.byCategory.length === 0}
          onClick={() =>
            d &&
            downloadCsv(
              'ventas-por-departamento.csv',
              d.byCategory.map((c) => ({
                Departamento: c.category,
                Piezas: c.qty,
                Vendido: c.total,
                ...(c.profit !== undefined
                  ? {
                      'Ventas sin IVA': c.netSales ?? '',
                      Costo: c.cost ?? '',
                      Ganancia: c.profit,
                      'Margen %': c.margin ?? '',
                    }
                  : {}),
              })),
            )
          }
        >
          Exportar
        </Button>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {d && (
        <>
          <Stats
            items={[
              { label: 'Total vendido', value: formatMoney(d.sales.total), key: true },
              { label: 'Departamentos con venta', value: String(d.byCategory.length) },
              ...(hasProfit ? [{ label: 'Ganancia neta', value: formatMoney(profit.toFixed(2)) }] : []),
            ]}
          />
          <Card flush>
            <CategoryTable rows={d.byCategory} total={d.sales.total} />
          </Card>
        </>
      )}
    </>
  );
}

export function CutsTab() {
  const list = useLoad(() => api.listCashSessions(), []);
  const rows = list.data?.data ?? [];
  return (
    <>
      {list.error && <Alert>{list.error}</Alert>}
      {list.data && rows.length === 0 && (
        <Card>
          <EmptyState icon="cash" title="Todavía no hay cortes" />
        </Card>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Caja</th>
                <th>Abierta</th>
                <th>Cajero</th>
                <th className="table__num">Ventas</th>
                <th className="table__money">Contado</th>
                <th className="table__money">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="folio">{s.folio}</span>{' '}
                    {s.status === 'OPEN' && <Badge tone="positive">Abierta</Badge>}
                  </td>
                  <td>{s.terminal}</td>
                  <td className="text-sm tnum">{formatDateTime(s.openedAt)}</td>
                  <td>{s.openedBy.name}</td>
                  <td className="table__num">{s.saleCount}</td>
                  <td className="table__money">{s.countedCash ? formatMoney(s.countedCash) : '—'}</td>
                  <td
                    className="table__money"
                    style={
                      s.difference && Math.abs(Number(s.difference)) >= 0.005
                        ? { color: 'var(--danger)' }
                        : undefined
                    }
                  >
                    {s.difference ? formatMoney(s.difference) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field__hint" style={{ padding: 'var(--s-4)' }}>
            El detalle de cada corte, con su ganancia por departamento, está en «Cortes de caja».
          </p>
        </div>
      )}
    </>
  );
}
