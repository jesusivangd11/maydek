import { useState } from 'react';
import { api } from '@pos/lib/api';
import { formatDateTime, formatMoney, formatQty } from '@pos/lib/format';
import { Alert, Button, Card, EmptyState, PageHeader, Segmented, Select } from '@pos/ui';
import type { ScreenProps } from '../App';
import { daysAgo, downloadCsv, endOfDay, startOfDay, useLoad } from '../lib/util';
import { CutsTab, DepartmentsTab, Stats, SummaryTab } from './ReportsExtra';

/**
 * Reportes de mostrador.
 *
 *   · Resumen: el periodo de un vistazo (ventas, IVA, descuentos, devoluciones,
 *     ganancia neta, formas de pago, cajeros, horas y días).
 *   · Ventas: ticket por ticket en el periodo, con cajero y forma de pago.
 *   · Departamentos: ventas, costo y ganancia por categoría.
 *   · Por artículo: qué se vendió, a qué costo y cuánto dejó.
 *   · Cortes: los turnos de caja con su arqueo.
 *   · Mayoreo: solo las ventas hechas con F11.
 *   · Inventario: existencias, con los negativos (vendidos sin existencia),
 *     agotados y bajo mínimo a la vista.
 *
 * Todo se exporta a CSV para abrirlo en Excel.
 */

type Tab = 'resumen' | 'ventas' | 'departamentos' | 'articulos' | 'mayoreo' | 'cortes' | 'inventario';
type Period = 'hoy' | 'ayer' | '7' | '30' | 'mes';

function rangeOf(period: Period): { from: string; to: string } {
  const now = new Date();
  switch (period) {
    case 'hoy':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'ayer':
      return { from: startOfDay(daysAgo(1)), to: endOfDay(daysAgo(1)) };
    case '7':
      return { from: startOfDay(daysAgo(6)), to: endOfDay(now) };
    case '30':
      return { from: startOfDay(daysAgo(29)), to: endOfDay(now) };
    case 'mes':
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: endOfDay(now) };
  }
}

const PERIODS: { value: Period; label: string }[] = [
  { value: 'hoy', label: 'Hoy' },
  { value: 'ayer', label: 'Ayer' },
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: 'mes', label: 'Este mes' },
];

export function ReportsScreen({ user }: ScreenProps) {
  const canSales = user.permissions.includes('report.sales');
  const canInventory = user.permissions.includes('report.inventory');
  const tabs = [
    ...(canSales
      ? ([
          { value: 'resumen', label: 'Resumen' },
          { value: 'ventas', label: 'Ventas' },
          { value: 'departamentos', label: 'Departamentos' },
          { value: 'articulos', label: 'Por artículo' },
          { value: 'mayoreo', label: 'Mayoreo' },
          { value: 'cortes', label: 'Cortes' },
        ] as const)
      : []),
    ...(canInventory ? ([{ value: 'inventario', label: 'Inventario' }] as const) : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]?.value ?? 'resumen');
  const [period, setPeriod] = useState<Period>('hoy');

  return (
    <div className="page">
      <PageHeader title="Reportes" subtitle="Ventas, ganancia por departamento, cortes, mayoreo e inventario." />
      {tabs.length === 0 ? (
        <Alert tone="warning">Tu usuario no tiene permiso para ver reportes.</Alert>
      ) : (
        <>
          <div className="report-bar">
            <Segmented label="Reporte" options={[...tabs]} value={tab} onChange={setTab} />
            {tab !== 'inventario' && tab !== 'cortes' && (
              <Segmented label="Periodo" options={PERIODS} value={period} onChange={setPeriod} />
            )}
          </div>
          {tab === 'resumen' && <SummaryTab range={rangeOf(period)} />}
          {tab === 'ventas' && <SalesTab period={period} />}
          {tab === 'departamentos' && <DepartmentsTab range={rangeOf(period)} />}
          {tab === 'cortes' && <CutsTab />}
          {tab === 'articulos' && <ProductsTab period={period} />}
          {tab === 'mayoreo' && <WholesaleTab period={period} />}
          {tab === 'inventario' && <InventoryTab />}
        </>
      )}
    </div>
  );
}

function SalesTab({ period }: { period: Period }) {
  const users = useLoad(() => api.listUsers().catch(() => ({ data: [] })), []);
  const [userId, setUserId] = useState('');
  const report = useLoad(() => api.salesReport({ ...rangeOf(period), userId: userId || undefined }), [period, userId]);
  const r = report.data;

  return (
    <>
      <div className="report-bar">
        <Select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Cajero">
          <option value="">Todos los cajeros</option>
          {(users.data?.data ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Button
          variant="subtle"
          icon="download"
          disabled={!r || r.data.length === 0}
          onClick={() =>
            r &&
            downloadCsv(
              'reporte-ventas.csv',
              r.data.map((s) => ({
                Folio: s.folio,
                Fecha: new Date(s.occurredAt).toLocaleString('es-MX'),
                Estado: s.status === 'CANCELLED' ? 'Cancelada' : 'Vigente',
                Cajero: s.cashier,
                Cliente: s.customer ?? '',
                Artículos: s.items,
                'Forma de pago': s.methods,
                Mayoreo: s.wholesale ? 'Sí' : '',
                Descuento: s.discount,
                Total: s.total,
                ...(s.profit !== undefined ? { Utilidad: s.profit } : {}),
              })),
            )
          }
        >
          Exportar
        </Button>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {r && (
        <>
          <Stats
            items={[
              { label: 'Total vendido', value: formatMoney(r.summary.total), key: true },
              { label: 'Ventas', value: String(r.summary.count) },
              { label: 'Ticket promedio', value: formatMoney(r.summary.averageTicket) },
              { label: 'Ventas sin IVA', value: formatMoney(r.summary.netSales) },
              { label: 'IVA', value: formatMoney(r.summary.tax) },
              { label: 'Descuentos', value: formatMoney(r.summary.discount) },
              ...(r.summary.cost !== undefined ? [{ label: 'Costo', value: formatMoney(r.summary.cost) }] : []),
              ...(r.summary.profit !== undefined
                ? [
                    { label: 'Ganancia neta', value: formatMoney(r.summary.profit) },
                    { label: 'Margen', value: `${Number(r.summary.margin ?? 0).toFixed(1)} %` },
                  ]
                : []),
              { label: 'Canceladas', value: `${r.summary.cancelled} (${formatMoney(r.summary.cancelledTotal)})` },
            ]}
          />
          <SalesTable rows={r.data} />
        </>
      )}
    </>
  );
}

function SalesTable({ rows }: { rows: NonNullable<Awaited<ReturnType<typeof api.salesReport>>>['data'] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState icon="chart" title="Sin ventas en el periodo" />
      </Card>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Folio</th>
            <th>Fecha</th>
            <th>Cajero</th>
            <th>Cliente</th>
            <th>Pago</th>
            <th className="table__num">Arts.</th>
            <th className="table__money">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} style={s.status === 'CANCELLED' ? { opacity: 0.55 } : undefined}>
              <td>
                <span className="folio">{s.folio}</span>{' '}
                {s.status === 'CANCELLED' && <span className="flag flag--danger">Cancelada</span>}
                {s.wholesale && <span className="flag flag--accent">Mayoreo</span>}
              </td>
              <td className="text-sm tnum">{formatDateTime(s.occurredAt)}</td>
              <td>{s.cashier}</td>
              <td>{s.customer ?? <span className="subtle">Público en general</span>}</td>
              <td className="text-sm">{s.methods}</td>
              <td className="table__num">{formatQty(s.items)}</td>
              <td className="table__money">{formatMoney(s.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductsTab({ period }: { period: Period }) {
  const report = useLoad(() => api.productSales(rangeOf(period)), [period]);
  const rows = report.data ?? [];
  return (
    <>
      <div className="report-bar">
        <Button
          variant="subtle"
          icon="download"
          disabled={rows.length === 0}
          onClick={() =>
            downloadCsv(
              'ventas-por-articulo.csv',
              rows.map((p) => ({ SKU: p.sku, Artículo: p.name, Cantidad: p.qty, Total: p.total, ...(p.profit !== undefined ? { Costo: p.cost ?? '', Utilidad: p.profit } : {}) })),
            )
          }
        >
          Exportar
        </Button>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {report.data && rows.length === 0 && (
        <Card>
          <EmptyState icon="box" title="Sin ventas en el periodo" />
        </Card>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Artículo</th>
                <th className="table__num">Cantidad</th>
                <th className="table__money">Total</th>
                {rows[0]?.profit !== undefined && <th className="table__money">Costo</th>}
                {rows[0]?.profit !== undefined && <th className="table__money">Utilidad</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={`${p.variantId}-${p.sku}`}>
                  <td className="mono text-sm">{p.sku}</td>
                  <td>{p.name}</td>
                  <td className="table__num">{formatQty(p.qty)}</td>
                  <td className="table__money">{formatMoney(p.total)}</td>
                  {p.profit !== undefined && <td className="table__money">{formatMoney(p.cost ?? '0')}</td>}
                  {p.profit !== undefined && <td className="table__money">{formatMoney(p.profit)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function WholesaleTab({ period }: { period: Period }) {
  const report = useLoad(() => api.wholesaleReport(rangeOf(period)), [period]);
  const r = report.data;
  return (
    <>
      {report.error && <Alert>{report.error}</Alert>}
      {r && (
        <>
          <Stats
            items={[
              { label: 'Vendido a mayoreo', value: formatMoney(r.summary.total), key: true },
              { label: 'Ventas', value: String(r.summary.count) },
              { label: 'Ticket promedio', value: formatMoney(r.summary.averageTicket) },
              ...(r.summary.profit !== undefined ? [{ label: 'Utilidad', value: formatMoney(r.summary.profit) }] : []),
            ]}
          />
          <div className="grid-2">
            <Card title="Artículos más vendidos a mayoreo" flush>
              {r.products.length === 0 ? (
                <EmptyState icon="box" title="Sin ventas de mayoreo" />
              ) : (
                <table className="table">
                  <tbody>
                    {r.products.map((p) => (
                      <tr key={p.sku}>
                        <td>
                          {p.name}
                          <div className="subtle text-sm mono">{p.sku}</div>
                        </td>
                        <td className="table__num">{formatQty(p.qty)}</td>
                        <td className="table__money">{formatMoney(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <div>
              <SalesTable rows={r.data} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  NEGATIVE: { text: 'Negativo', tone: 'danger' },
  OUT: { text: 'Agotado', tone: 'danger' },
  LOW: { text: 'Bajo mínimo', tone: 'accent' },
  OK: { text: 'OK', tone: 'positive' },
};

function InventoryTab() {
  const [filter, setFilter] = useState<'all' | 'negative' | 'out' | 'low'>('all');
  const report = useLoad(() => api.inventoryReport(filter), [filter]);
  const r = report.data;

  return (
    <>
      <div className="report-bar">
        <Segmented
          label="Filtro"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Todo' },
            { value: 'negative', label: 'En negativo' },
            { value: 'out', label: 'Agotados' },
            { value: 'low', label: 'Bajo mínimo' },
          ]}
        />
        <Button
          variant="subtle"
          icon="download"
          disabled={!r || r.data.length === 0}
          onClick={() =>
            r &&
            downloadCsv(
              'reporte-inventario.csv',
              r.data.map((i) => ({
                SKU: i.sku,
                Artículo: i.name,
                Categoría: i.category ?? '',
                Existencia: i.qty,
                Mínimo: i.minStock ?? '',
                Estado: STATUS_LABEL[i.status]?.text ?? i.status,
                Precio: i.price,
                ...(i.cost !== undefined ? { Costo: i.cost, Valor: i.value } : {}),
              })),
            )
          }
        >
          Exportar
        </Button>
      </div>
      {report.error && <Alert>{report.error}</Alert>}
      {r && (
        <>
          <Stats
            items={[
              ...(r.summary.value !== undefined ? [{ label: 'Valor al costo', value: formatMoney(r.summary.value), key: true }] : []),
              { label: 'Artículos', value: String(r.summary.products) },
              { label: 'En negativo', value: String(r.summary.negative) },
              { label: 'Agotados', value: String(r.summary.out) },
              { label: 'Bajo mínimo', value: String(r.summary.low) },
            ]}
          />
          {r.summary.negative > 0 && filter === 'all' && (
            <Alert tone="warning">
              {r.summary.negative} artículo(s) se vendieron sin existencia y quedaron en negativo. Captura su
              entrada en Inventario o con una compra para cuadrarlos.
            </Alert>
          )}
          {r.data.length === 0 ? (
            <Card>
              <EmptyState icon="box" title="Nada que mostrar con este filtro" />
            </Card>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Artículo</th>
                    <th>Estado</th>
                    <th className="table__num">Existencia</th>
                    <th className="table__num">Mínimo</th>
                    <th className="table__money">Precio</th>
                    {r.data[0]?.value !== undefined && <th className="table__money">Valor</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.data.map((i) => (
                    <tr key={i.variantId}>
                      <td className="mono text-sm">{i.sku}</td>
                      <td>
                        {i.name}
                        {i.category && <div className="subtle text-sm">{i.category}</div>}
                      </td>
                      <td>
                        <span className={`flag flag--${STATUS_LABEL[i.status]?.tone ?? 'info'}`}>
                          {STATUS_LABEL[i.status]?.text ?? i.status}
                        </span>
                      </td>
                      <td className="table__num" style={i.status === 'NEGATIVE' ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                        {formatQty(i.qty)}
                      </td>
                      <td className="table__num">{i.minStock ? formatQty(i.minStock) : '—'}</td>
                      <td className="table__money">{formatMoney(i.price)}</td>
                      {i.value !== undefined && <td className="table__money">{formatMoney(i.value)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
