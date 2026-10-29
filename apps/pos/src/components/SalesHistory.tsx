import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, type ReturnDetail, type SaleDetail, type SaleSummary } from '../lib/api';
import { formatDateTime, formatMoney, formatQty } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  type Tone,
} from '../ui';
import { PrintTicket, printTicket } from './PrintTicket';
import { CancelSaleDialog, ReturnDialog } from './SaleActions';

/**
 * Historial de ventas.
 *
 * Lo que se busca de verdad en un mostrador es un folio concreto, casi siempre
 * porque el cliente volvió con su ticket. Por eso la búsqueda es por folio y la
 * lista arranca por la venta más reciente.
 *
 * Los filtros de fecha y cajero se resuelven EN EL SERVIDOR (`from`, `userId`
 * de `GET /sales`), no recortando en memoria una página ya traída: filtrar
 * sobre las últimas 40 filas daría un resultado que parece correcto y miente
 * en cuanto haya más ventas que eso.
 */

type Range = 'today' | 'week' | 'month' | 'all';

const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Esta semana' },
  { value: 'month', label: 'Este mes' },
  { value: 'all', label: 'Todas' },
];

/** Inicio del rango en hora local, en ISO-8601. `undefined` = sin límite. */
function rangeStart(range: Range): string | undefined {
  if (range === 'all') return undefined;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  if (range === 'week') {
    // Semana de lunes a domingo, que es como se cuentan los turnos aquí.
    const weekday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - weekday);
  }

  if (range === 'month') start.setDate(1);

  return start.toISOString();
}

export function SalesHistory({
  permissions = [],
  initialSaleId,
  onOpened,
}: {
  permissions?: string[];
  /** Venta a abrir de entrada, cuando se llega desde "Ver venta". */
  initialSaleId?: string | null;
  onOpened?: () => void;
} = {}) {
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [cashierId, setCashierId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SaleDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  /**
   * Cajeros vistos hasta ahora.
   *
   * Se acumulan y NUNCA se recortan: si las opciones salieran de la página
   * actual, filtrar por un cajero dejaría el desplegable con un solo nombre y
   * no habría forma de volver atrás.
   */
  const [knownCashiers, setKnownCashiers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let cancelled = false;

    const handle = setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        try {
          const response = await api.listSales({
            search: search || undefined,
            from: rangeStart(range),
            userId: cashierId || undefined,
            limit: 40,
          });
          if (cancelled) return;

          setSales(response.data);
          setKnownCashiers((current) => {
            const byId = new Map(current.map((c) => [c.id, c]));
            for (const sale of response.data) {
              if (sale.cashier) byId.set(sale.cashier.id, sale.cashier);
            }
            return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
          });
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof ApiError ? err.message : 'No se pudo cargar el historial');
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      },
      search ? 200 : 0,
    );

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [search, range, cashierId]);

  // El aviso al padre se guarda en una referencia: así el efecto depende solo
  // del identificador y no se vuelve a disparar porque el padre haya vuelto a
  // crear la función.
  const notifyOpened = useRef(onOpened);
  notifyOpened.current = onOpened;

  // Llegada desde "Ver venta": se abre el detalle sin que el cajero busque.
  useEffect(() => {
    if (!initialSaleId) return;
    let cancelled = false;

    (async () => {
      setLoadingDetail(true);
      try {
        const detail = await api.getSale(initialSaleId);
        if (!cancelled) setSelected(detail);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'No se pudo abrir la venta');
        }
      } finally {
        if (!cancelled) {
          setLoadingDetail(false);
          notifyOpened.current?.();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialSaleId]);

  async function openSale(id: string) {
    setLoadingDetail(true);
    try {
      setSelected(await api.getSale(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo abrir la venta');
    } finally {
      setLoadingDetail(false);
    }
  }

  const filtered = search || range !== 'all' || cashierId;

  if (selected) {
    return (
      <SaleDetailView
        sale={selected}
        permissions={permissions}
        onChanged={(sale) => {
          setSelected(sale);
          setSales((rows) =>
            rows.map((row) => (row.id === sale.id ? { ...row, status: sale.status } : row)),
          );
        }}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Ventas"
        subtitle="Las más recientes primero."
        actions={loadingDetail ? <span className="spinner" aria-label="Abriendo venta" /> : null}
      />

      <div className="sales__filters">
        <SearchInput
          compact
          value={search}
          placeholder="Buscar por folio…"
          aria-label="Buscar por folio"
          onChange={(event) => setSearch(event.target.value)}
        />

        <Segmented options={RANGES} value={range} onChange={setRange} label="Rango de fechas" />

        {/* Solo se ofrece cuando hay más de un cajero: un desplegable con un
            único nombre no filtra nada y sí ocupa sitio. */}
        {knownCashiers.length > 1 && (
          <Select
            className="sales__filter-select"
            value={cashierId}
            aria-label="Filtrar por cajero"
            onChange={(event) => setCashierId(event.target.value)}
          >
            <option value="">Todos los cajeros</option>
            {knownCashiers.map((cashier) => (
              <option key={cashier.id} value={cashier.id}>
                {cashier.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--s-5)' }}>
          <Alert>{error}</Alert>
        </div>
      )}

      {loading && sales.length === 0 && (
        <Card>
          <p className="subtle center">Cargando…</p>
        </Card>
      )}

      {!loading && sales.length === 0 && (
        <Card>
          <EmptyState
            icon={filtered ? 'search' : 'receipt'}
            title={filtered ? 'Ninguna venta coincide' : 'Todavía no hay ventas'}
            text={
              filtered
                ? 'Prueba con otro folio o amplía el rango de fechas.'
                : 'Las ventas que registres en el punto de venta aparecerán aquí.'
            }
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setRange('all');
                    setCashierId('');
                  }}
                >
                  Quitar filtros
                </Button>
              ) : null
            }
          />
        </Card>
      )}

      {sales.length > 0 && (
        <div className="table-wrap">
          <table className="table table--roomy">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Fecha</th>
                <th>Cajero</th>
                <th>Cliente</th>
                <th>Pago</th>
                <th className="table__money">Total</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <tr
                  key={sale.id}
                  className="table__row--clickable"
                  tabIndex={0}
                  title={`Abrir ${sale.folio}`}
                  onClick={() => openSale(sale.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openSale(sale.id);
                  }}
                >
                  <td>
                    <span className="folio">{sale.folio}</span>
                    {sale.status !== 'COMPLETED' && (
                      <>
                        {' '}
                        <Badge tone={statusTone(sale.status)}>
                          {SALE_STATUS[sale.status] ?? sale.status}
                        </Badge>
                      </>
                    )}
                  </td>
                  <td className="tnum muted">{formatDateTime(sale.occurredAt)}</td>
                  <td>{sale.cashier?.name ?? '—'}</td>
                  <td className="muted">{sale.customer?.name ?? 'Público en general'}</td>
                  <td className="muted">{sale.paymentMethods.join(', ')}</td>
                  <td className="table__money table__money--strong">
                    {formatMoney(sale.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Detalle de una venta.
 *
 * Dos columnas: el desglose a la izquierda —que es lo que se lee— y a la
 * derecha los datos de cabecera, los totales y las acciones. Así el total
 * queda a la altura de los ojos sin tener que recorrer la tabla hasta el pie.
 */
function SaleDetailView({
  sale,
  permissions,
  onChanged,
  onBack,
}: {
  sale: SaleDetail;
  permissions: string[];
  onChanged: (sale: SaleDetail) => void;
  onBack: () => void;
}) {
  const discount = useMemo(() => Number(sale.discountTotal), [sale.discountTotal]);
  const [action, setAction] = useState<'cancel' | 'return' | null>(null);
  const [lastReturn, setLastReturn] = useState<ReturnDetail | null>(null);

  const isOpen = sale.status === 'COMPLETED' || sale.status === 'PARTIALLY_RETURNED';
  const canReturn = permissions.includes('return.create') && isOpen;
  const canCancel = sale.status === 'COMPLETED';

  async function afterReturn(ret: ReturnDetail) {
    setAction(null);
    setLastReturn(ret);
    onChanged(await api.getSale(sale.id));
    // El comprobante sale de inmediato: si hay nota de crédito, el cliente
    // se la lleva en la mano.
    setTimeout(printTicket, 50);
  }

  return (
    <div className="page">
      <PageHeader
        title={<span className="folio" style={{ fontSize: 'var(--text-2xl)' }}>{sale.folio}</span>}
        badge={
          <Badge tone={statusTone(sale.status)}>{SALE_STATUS[sale.status] ?? sale.status}</Badge>
        }
        subtitle={
          <>
            {formatDateTime(sale.occurredAt)} · {sale.branch.name}
            {sale.terminal ? ` · ${sale.terminal.name}` : ''}
          </>
        }
        actions={
          <Button variant="secondary" icon="back" onClick={onBack}>
            Volver a ventas
          </Button>
        }
      />

      <div className="sale-detail">
        <div className="cash__main">
          <Card title="Artículos vendidos" flush>
            <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Artículo</th>
                    <th>SKU</th>
                    <th className="table__num">Cant.</th>
                    <th className="table__money">Precio</th>
                    <th className="table__money">Desc.</th>
                    <th className="table__money">Importe</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.items.map((item) => (
                    <tr key={item.lineNumber}>
                      <td className="subtle tnum">{item.lineNumber}</td>
                      <td>{item.name}</td>
                      <td className="mono subtle text-sm">{item.sku}</td>
                      <td className="table__num">{formatQty(item.qty)}</td>
                      <td className="table__money">{formatMoney(item.unitPrice)}</td>
                      <td className="table__money">{formatMoney(item.discountAmount)}</td>
                      <td className="table__money table__money--strong">
                        {formatMoney(item.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Pagos" flush>
            <div className="methods">
              {sale.payments.map((payment, index) => (
                <div key={`${payment.methodCode}-${index}`} className="method-row">
                  <span className="method-row__name">
                    {payment.methodName}
                    {payment.reference && (
                      <span className="mono subtle text-sm">{payment.reference}</span>
                    )}
                  </span>
                  <span className="method-row__amount">{formatMoney(payment.amount)}</span>
                </div>
              ))}
              {Number(sale.changeGiven) > 0 && (
                <div className="method-row">
                  <span className="method-row__name muted">Cambio entregado</span>
                  <span className="method-row__amount muted">
                    {formatMoney(sale.changeGiven)}
                  </span>
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="sale-detail__side">
          <Card title="Datos de la venta" flush>
            <div className="sale-detail__meta">
              <MetaRow label="Cajero" value={sale.cashier?.name ?? '—'} />
              <MetaRow label="Cliente" value={sale.customer?.name ?? 'Público en general'} />
              <MetaRow
                label="Forma de pago"
                value={sale.payments.map((p) => p.methodName).join(' + ')}
              />
              {sale.profit !== undefined && (
                <MetaRow label="Utilidad" value={formatMoney(sale.profit)} />
              )}
            </div>
          </Card>

          <Card title="Totales" flush>
            <div className="sale-detail__totals">
              <div className="sale-detail__total-row">
                <span>Subtotal</span>
                <span className="sale-detail__amount">{formatMoney(sale.subtotal)}</span>
              </div>
              {discount > 0 && (
                <div className="sale-detail__total-row">
                  <span>Descuento</span>
                  <span className="sale-detail__amount">−{formatMoney(discount)}</span>
                </div>
              )}
              <div className="sale-detail__total-row">
                <span>IVA</span>
                <span className="sale-detail__amount">{formatMoney(sale.taxTotal)}</span>
              </div>
              <div className="sale-detail__total-row sale-detail__total-row--grand">
                <span className="totals__label">Total</span>
                <span className="sale-detail__amount">{formatMoney(sale.total)}</span>
              </div>
            </div>
          </Card>

          <Card title="Acciones">
            <div className="future-actions" style={{ padding: 0 }}>
              <Button
                variant="secondary"
                icon="printer"
                block
                onClick={() => {
                  setLastReturn(null);
                  setTimeout(printTicket, 0);
                }}
              >
                Reimprimir ticket
              </Button>
              <Button
                variant="secondary"
                icon="undo"
                block
                disabled={!canReturn}
                onClick={() => setAction('return')}
              >
                Devolución
              </Button>
              <Button
                variant="danger"
                icon="close"
                block
                disabled={!canCancel}
                onClick={() => setAction('cancel')}
              >
                Cancelar venta
              </Button>
              {sale.status === 'CANCELLED' && sale.cancelReason && (
                <p className="field__hint">Cancelada: {sale.cancelReason}</p>
              )}
              {lastReturn && (
                <Alert tone="warning">
                  Devolución {lastReturn.folio} por {formatMoney(lastReturn.total)}
                  {lastReturn.creditNote ? ` · nota de crédito ${lastReturn.creditNote.folio}` : ''}.
                </Alert>
              )}
            </div>
          </Card>

          {lastReturn ? <PrintTicket ret={lastReturn} /> : <PrintTicket sale={sale} reprint />}

          {action === 'cancel' && (
            <CancelSaleDialog
              sale={sale}
              onClose={() => setAction(null)}
              onDone={(updated) => {
                setAction(null);
                onChanged(updated);
              }}
            />
          )}
          {action === 'return' && (
            <ReturnDialog sale={sale} onClose={() => setAction(null)} onDone={afterReturn} />
          )}
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="meta-row">
      <span className="meta-row__label">{label}</span>
      <span className="meta-row__value">{value}</span>
    </div>
  );
}

const SALE_STATUS: Record<string, string> = {
  DRAFT: 'Borrador',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  PARTIALLY_RETURNED: 'Devuelta en parte',
  RETURNED: 'Devuelta',
};

/** El color dice qué pasó con la venta, no adorna la fila. */
function statusTone(status: string): Tone {
  switch (status) {
    case 'COMPLETED':
      return 'positive';
    case 'CANCELLED':
      return 'danger';
    case 'RETURNED':
    case 'PARTIALLY_RETURNED':
      return 'warning';
    default:
      return 'neutral';
  }
}
