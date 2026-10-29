import { useState } from 'react';
import { api, type PurchaseOrderDetail, type Supplier } from '@pos/lib/api';
import { formatDateTime, formatMoney, formatQty, toNumber } from '@pos/lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Select,
  TextInput,
  type Tone,
} from '@pos/ui';
import type { ScreenProps } from '../App';
import { VariantPicker } from '../components/VariantPicker';
import { can, errorText, useLoad } from '../lib/util';

/**
 * Compras.
 *
 * Orden (promesa del proveedor) → aprobación → recepción, total o en
 * partes. Solo la RECEPCIÓN mete mercancía al almacén y recalcula el costo
 * promedio, con el flete prorrateado. La recepción directa cubre el caso de
 * todos los días: llegó el proveedor sin orden previa.
 */

const STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Borrador', tone: 'neutral' },
  SENT: { label: 'Aprobada', tone: 'info' },
  PARTIALLY_RECEIVED: { label: 'Recibida en parte', tone: 'warning' },
  RECEIVED: { label: 'Recibida', tone: 'positive' },
  CANCELLED: { label: 'Cancelada', tone: 'danger' },
  CLOSED: { label: 'Cerrada', tone: 'neutral' },
};

interface DraftLine {
  variantId: string;
  name: string;
  sku: string;
  qty: string;
  unitCost: string;
}

type Tab = 'orders' | 'receipts' | 'suppliers' | 'suggestions';

export function PurchasesScreen({ user }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('orders');
  const [dialog, setDialog] = useState<
    | { kind: 'new-order'; lines?: DraftLine[] }
    | { kind: 'order'; id: string }
    | { kind: 'direct' }
    | { kind: 'supplier'; supplier: Supplier | null }
    | null
  >(null);

  const suppliers = useLoad(() => api.listSuppliers(undefined, true), []);
  const orders = useLoad(() => api.listPurchaseOrders(), []);
  const receipts = useLoad(() => (tab === 'receipts' ? api.listReceipts() : Promise.resolve(null)), [tab]);
  const suggestions = useLoad(() => (tab === 'suggestions' ? api.purchaseSuggestions() : Promise.resolve(null)), [tab]);

  const canCreate = can(user.permissions, 'purchase.create');
  const canReceive = can(user.permissions, 'purchase.receive');
  const canSuppliers = can(user.permissions, 'supplier.manage');

  return (
    <div className="page">
      <PageHeader
        title="Compras"
        subtitle="Órdenes, recepción de mercancía y proveedores."
        actions={
          <>
            {canReceive && (
              <Button variant="secondary" icon="truck" onClick={() => setDialog({ kind: 'direct' })}>
                Recepción directa
              </Button>
            )}
            {canCreate && (
              <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'new-order' })}>
                Nueva orden
              </Button>
            )}
          </>
        }
      />

      <div className="tabs" role="tablist">
        {(
          [
            ['orders', 'Órdenes'],
            ['receipts', 'Recepciones'],
            ['suppliers', 'Proveedores'],
            ['suggestions', 'Sugerencia de compra'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className="tabs__item" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'orders' && (
        <>
          {orders.error && <Alert>{orders.error}</Alert>}
          {orders.data?.length === 0 && (
            <Card>
              <EmptyState icon="truck" title="Sin órdenes de compra" text="Crea una con «Nueva orden» o recibe mercancía directa." />
            </Card>
          )}
          {orders.data && orders.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Folio</th>
                    <th>Proveedor</th>
                    <th>Estado</th>
                    <th className="table__num">Recibido</th>
                    <th className="table__money">Total</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.map((o) => (
                    <tr key={o.id} className="table__row--clickable" tabIndex={0} onClick={() => setDialog({ kind: 'order', id: o.id })}>
                      <td className="folio">{o.folio}</td>
                      <td>{o.supplier.businessName}</td>
                      <td>
                        <Badge tone={STATUS[o.status]?.tone}>{STATUS[o.status]?.label ?? o.status}</Badge>
                      </td>
                      <td className="table__num">
                        {formatQty(o.qtyReceived)} / {formatQty(o.qtyOrdered)}
                      </td>
                      <td className="table__money">{formatMoney(o.total)}</td>
                      <td className="muted text-sm">{formatDateTime(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'receipts' && (
        <>
          {receipts.error && <Alert>{receipts.error}</Alert>}
          {receipts.data?.length === 0 && (
            <Card>
              <EmptyState icon="truck" title="Sin recepciones" />
            </Card>
          )}
          {receipts.data && receipts.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Folio</th>
                    <th>Proveedor</th>
                    <th>Orden</th>
                    <th>Factura</th>
                    <th className="table__money">Costo puesto en bodega</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.data.map((r) => (
                    <tr key={r.id}>
                      <td className="folio">{r.folio}</td>
                      <td>{r.supplier.businessName}</td>
                      <td className="mono text-sm">{r.purchaseOrder?.folio ?? 'Directa'}</td>
                      <td className="mono text-sm">{r.supplierInvoiceNumber ?? '—'}</td>
                      <td className="table__money">{formatMoney(r.total)}</td>
                      <td className="muted text-sm">{formatDateTime(r.receivedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'suppliers' && (
        <>
          {canSuppliers && (
            <div className="toolbar">
              <Button variant="secondary" icon="plus" onClick={() => setDialog({ kind: 'supplier', supplier: null })}>
                Nuevo proveedor
              </Button>
            </div>
          )}
          {suppliers.data?.length === 0 && (
            <Card>
              <EmptyState icon="truck" title="Sin proveedores" />
            </Card>
          )}
          {suppliers.data && suppliers.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Proveedor</th>
                    <th>Contacto</th>
                    <th>Condiciones</th>
                    <th className="table__num">Órdenes</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {suppliers.data.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.businessName}</strong>
                        {!s.isActive && <Badge>Inactivo</Badge>}
                        {s.rfc && <div className="mono subtle text-sm">{s.rfc}</div>}
                      </td>
                      <td className="text-sm">{[s.contactName, s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="text-sm muted">
                        {s.paymentTerms ?? '—'}
                        {s.leadTimeDays ? ` · entrega en ${s.leadTimeDays} días` : ''}
                      </td>
                      <td className="table__num">{s.orderCount}</td>
                      <td className="cell-actions">
                        {canSuppliers && (
                          <Button size="sm" variant="subtle" icon="edit" onClick={() => setDialog({ kind: 'supplier', supplier: s })}>
                            Editar
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'suggestions' && (
        <>
          {suggestions.error && <Alert>{suggestions.error}</Alert>}
          {suggestions.data?.length === 0 && (
            <Card>
              <EmptyState icon="check" title="Nada por debajo de su mínimo" text="Define la existencia mínima en cada producto para recibir sugerencias." />
            </Card>
          )}
          {suggestions.data && suggestions.data.length > 0 && (
            <>
              <div className="toolbar">
                <span className="muted">Artículos en su mínimo o por debajo, con la cantidad para llegar al doble del mínimo.</span>
                <span className="toolbar__spacer" />
                {canCreate && (
                  <Button
                    variant="primary"
                    icon="plus"
                    onClick={() =>
                      setDialog({
                        kind: 'new-order',
                        lines: suggestions.data!.map((s) => ({
                          variantId: s.variantId,
                          name: s.name,
                          sku: s.sku,
                          qty: s.suggestedQty,
                          unitCost: toNumber(s.lastCost).toFixed(2),
                        })),
                      })
                    }
                  >
                    Crear orden con lo sugerido
                  </Button>
                )}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Artículo</th>
                      <th className="table__num">Disponible</th>
                      <th className="table__num">Mínimo</th>
                      <th className="table__num">Sugerido</th>
                      <th className="table__money">Último costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.data.map((s) => (
                      <tr key={s.variantId}>
                        <td>
                          {s.name}
                          <div className="mono subtle text-sm">{s.sku}</div>
                        </td>
                        <td className="table__num">{formatQty(s.available)}</td>
                        <td className="table__num">{formatQty(s.minStock)}</td>
                        <td className="table__num">
                          <strong>{formatQty(s.suggestedQty)}</strong>
                        </td>
                        <td className="table__money">{formatMoney(s.lastCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {dialog?.kind === 'new-order' && (
        <OrderForm
          mode="order"
          suppliers={suppliers.data ?? []}
          initialLines={dialog.lines}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            void orders.reload();
            setTab('orders');
            setDialog(id ? { kind: 'order', id } : null);
          }}
        />
      )}
      {dialog?.kind === 'direct' && (
        <OrderForm
          mode="direct"
          suppliers={suppliers.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setTab('receipts');
            setDialog(null);
            void receipts.reload();
          }}
        />
      )}
      {dialog?.kind === 'order' && (
        <OrderDialog
          id={dialog.id}
          permissions={user.permissions}
          onClose={() => {
            setDialog(null);
            void orders.reload();
          }}
        />
      )}
      {dialog?.kind === 'supplier' && (
        <SupplierDialog
          supplier={dialog.supplier}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void suppliers.reload();
          }}
        />
      )}
    </div>
  );
}

/** Captura de renglones: sirve para la orden de compra y para la recepción directa. */
function OrderForm({
  mode,
  suppliers,
  initialLines,
  onClose,
  onSaved,
}: {
  mode: 'order' | 'direct';
  suppliers: Supplier[];
  initialLines?: DraftLine[];
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const active = suppliers.filter((s) => s.isActive);
  const [supplierId, setSupplierId] = useState(active[0]?.id ?? '');
  const [lines, setLines] = useState<DraftLine[]>(initialLines ?? []);
  const [shipping, setShipping] = useState('');
  const [invoice, setInvoice] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = lines.reduce((acc, l) => acc + Number(l.qty || 0) * Number(l.unitCost || 0), 0);
  const invalid = !supplierId || lines.length === 0 || lines.some((l) => !(Number(l.qty) > 0) || l.unitCost === '');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const items = lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: Number(l.unitCost).toFixed(2) }));
      if (mode === 'order') {
        const order = await api.createPurchaseOrder({
          supplierId,
          items,
          shippingCost: shipping || undefined,
          expectedDate: expected ? new Date(expected).toISOString() : undefined,
          notes: notes || undefined,
        });
        onSaved(order.id);
      } else {
        await api.receivePurchase({
          supplierId,
          items,
          freightCost: shipping || undefined,
          supplierInvoiceNumber: invoice || undefined,
          notes: notes || undefined,
        });
        onSaved();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      label={mode === 'order' ? 'Nueva orden de compra' : 'Recepción directa'}
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">{mode === 'order' ? 'Nueva orden de compra' : 'Recepción directa de mercancía'}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          <span className="modal__summary">
            Mercancía: <strong>{formatMoney(subtotal)}</strong>
            {Number(shipping) > 0 && <> · flete {formatMoney(shipping)}</>}
          </span>
          <Button variant="primary" disabled={busy || invalid} onClick={save}>
            {busy ? 'Guardando…' : mode === 'order' ? 'Crear orden (borrador)' : 'Recibir e ingresar al inventario'}
          </Button>
        </div>
      }
    >
      {active.length === 0 && <Alert tone="warning">Primero da de alta un proveedor en la pestaña Proveedores.</Alert>}
      <div className="form-grid">
        <Field label="Proveedor" htmlFor="po-supplier">
          <Select id="po-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {active.map((s) => (
              <option key={s.id} value={s.id}>
                {s.businessName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={mode === 'order' ? 'Flete estimado' : 'Flete y otros costos'} htmlFor="po-ship" hint="Se reparte entre los artículos según su valor.">
          <TextInput id="po-ship" inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value.replace(/[^\d.]/g, ''))} />
        </Field>
        {mode === 'order' ? (
          <Field label="Fecha esperada" htmlFor="po-date">
            <TextInput id="po-date" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
        ) : (
          <Field label="Factura del proveedor" htmlFor="po-inv">
            <TextInput id="po-inv" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </Field>
        )}
      </div>
      <VariantPicker
        placeholder="Agregar artículo…"
        onPick={(item) =>
          setLines((rows) =>
            rows.some((r) => r.variantId === item.variantId)
              ? rows
              : [...rows, { variantId: item.variantId, name: item.name, sku: item.sku, qty: '1', unitCost: item.cost ? toNumber(item.cost).toFixed(2) : '' }],
          )
        }
      />
      {lines.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Artículo</th>
              <th className="table__num">Cantidad</th>
              <th className="table__money">Costo unitario (sin IVA)</th>
              <th className="table__money">Importe</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const update = (patch: Partial<DraftLine>) => setLines((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              return (
                <tr key={l.variantId}>
                  <td>
                    {l.name}
                    <div className="mono subtle text-sm">{l.sku}</div>
                  </td>
                  <td className="table__num">
                    <TextInput className="input--sm num-input" inputMode="decimal" value={l.qty} onChange={(e) => update({ qty: e.target.value.replace(/[^\d.]/g, '') })} />
                  </td>
                  <td className="table__money">
                    <TextInput className="input--sm num-input" inputMode="decimal" value={l.unitCost} onChange={(e) => update({ unitCost: e.target.value.replace(/[^\d.]/g, '') })} />
                  </td>
                  <td className="table__money">{formatMoney(Number(l.qty || 0) * Number(l.unitCost || 0))}</td>
                  <td>
                    <Button size="sm" variant="subtle" icon="trash" aria-label="Quitar" onClick={() => setLines((rows) => rows.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Field label="Notas" htmlFor="po-notes">
        <TextInput id="po-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}

function OrderDialog({ id, permissions, onClose }: { id: string; permissions: string[]; onClose: () => void }) {
  const { data: order, error, setData, reload } = useLoad(() => api.getPurchaseOrder(id), [id]);
  const [receiving, setReceiving] = useState<Record<string, string>>({});
  const [freight, setFreight] = useState('');
  const [invoice, setInvoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const canApprove = can(permissions, 'purchase.approve');
  const canReceive = can(permissions, 'purchase.receive');
  const receivable = order && (order.status === 'SENT' || order.status === 'PARTIALLY_RECEIVED');

  async function act(action: () => Promise<PurchaseOrderDetail | void>, ok: string) {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      const result = await action();
      if (result) setData(result);
      else await reload();
      setMessage(ok);
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const toReceive = order
    ? order.items
        .map((i) => ({ variantId: i.variantId, qty: receiving[i.id] ?? i.qtyPending }))
        .filter((l) => Number(l.qty) > 0)
    : [];

  return (
    <Modal
      label="Orden de compra"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">
            {order ? `Orden ${order.folio}` : 'Orden de compra'}{' '}
            {order && <Badge tone={STATUS[order.status]?.tone}>{STATUS[order.status]?.label}</Badge>}
          </h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        order && (
          <div className="modal__actions">
            {canApprove && order.status !== 'RECEIVED' && order.status !== 'CANCELLED' && order.status !== 'CLOSED' && (
              <Button variant="danger" disabled={busy} onClick={() => act(() => api.cancelPurchaseOrder(order.id), 'Orden actualizada.')}>
                {order.status === 'PARTIALLY_RECEIVED' ? 'Cerrar con lo recibido' : 'Cancelar orden'}
              </Button>
            )}
            {canApprove && order.status === 'DRAFT' && (
              <Button variant="primary" disabled={busy} onClick={() => act(() => api.approvePurchaseOrder(order.id), 'Orden aprobada: ya puede recibirse.')}>
                Aprobar y enviar
              </Button>
            )}
            {canReceive && receivable && (
              <Button
                variant="primary"
                icon="truck"
                disabled={busy || toReceive.length === 0}
                onClick={() =>
                  act(async () => {
                    const receipt = await api.receivePurchase({
                      purchaseOrderId: order.id,
                      items: toReceive,
                      freightCost: freight || undefined,
                      supplierInvoiceNumber: invoice || undefined,
                    });
                    setReceiving({});
                    setFreight('');
                    setInvoice('');
                    setMessage(`Recepción ${receipt.folio} registrada.`);
                  }, 'Mercancía recibida e ingresada al inventario.')
                }
              >
                Recibir mercancía
              </Button>
            )}
          </div>
        )
      }
    >
      {error && <Alert>{error}</Alert>}
      {order && (
        <>
          <p className="muted">
            {order.supplier.businessName}
            {order.supplier.phone ? ` · ${order.supplier.phone}` : ''} · creada {formatDateTime(order.createdAt)}
            {order.expectedDate ? ` · esperada ${new Date(order.expectedDate).toLocaleDateString('es-MX')}` : ''}
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Artículo</th>
                <th className="table__num">Pedido</th>
                <th className="table__num">Recibido</th>
                <th className="table__num">Pendiente</th>
                <th className="table__money">Costo</th>
                {receivable && <th className="table__num">Recibir ahora</th>}
              </tr>
            </thead>
            <tbody>
              {order.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.name}
                    <div className="mono subtle text-sm">{i.sku}</div>
                  </td>
                  <td className="table__num">{formatQty(i.qtyOrdered)}</td>
                  <td className="table__num">{formatQty(i.qtyReceived)}</td>
                  <td className="table__num">
                    <strong>{formatQty(i.qtyPending)}</strong>
                  </td>
                  <td className="table__money">{formatMoney(i.unitCost)}</td>
                  {receivable && (
                    <td className="table__num">
                      <TextInput
                        className="input--sm num-input"
                        inputMode="decimal"
                        value={receiving[i.id] ?? formatQty(i.qtyPending)}
                        onChange={(e) => setReceiving((r) => ({ ...r, [i.id]: e.target.value.replace(/[^\d.]/g, '') }))}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {receivable && canReceive && (
            <div className="form-grid">
              <Field label="Flete de esta entrega" htmlFor="rc-freight" hint="Se suma al costo de lo recibido.">
                <TextInput id="rc-freight" inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value.replace(/[^\d.]/g, ''))} />
              </Field>
              <Field label="Factura del proveedor" htmlFor="rc-inv">
                <TextInput id="rc-inv" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
              </Field>
            </div>
          )}
          <p className="muted">
            Total de la orden: <strong>{formatMoney(order.total)}</strong>
            {toNumber(order.shippingCost) > 0 && ` (incluye flete ${formatMoney(order.shippingCost)})`}
          </p>
          {order.receipts.length > 0 && (
            <p className="field__hint">
              Recepciones: {order.receipts.map((r) => `${r.folio} (${formatDateTime(r.receivedAt)})`).join(' · ')}
            </p>
          )}
        </>
      )}
      {message && <p className="toast">{message}</p>}
      {failure && <Alert>{failure}</Alert>}
    </Modal>
  );
}

function SupplierDialog({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    businessName: supplier?.businessName ?? '',
    tradeName: supplier?.tradeName ?? '',
    rfc: supplier?.rfc ?? '',
    contactName: supplier?.contactName ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    paymentTerms: supplier?.paymentTerms ?? '',
    leadTimeDays: supplier?.leadTimeDays ? String(supplier.leadTimeDays) : '',
    notes: supplier?.notes ?? '',
    isActive: supplier?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      businessName: form.businessName.trim(),
      tradeName: form.tradeName,
      rfc: form.rfc.trim() || undefined,
      contactName: form.contactName,
      phone: form.phone,
      email: form.email.trim() || undefined,
      paymentTerms: form.paymentTerms,
      leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
      notes: form.notes,
      isActive: form.isActive,
    };
    try {
      if (supplier) await api.updateSupplier(supplier.id, body);
      else await api.createSupplier(body);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      label="Proveedor"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">{supplier ? 'Editar proveedor' : 'Nuevo proveedor'}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          <Button variant="primary" disabled={busy || form.businessName.trim().length < 2} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      }
    >
      <div className="form-grid">
        <Field label="Razón social" htmlFor="s-biz">
          <TextInput id="s-biz" autoFocus value={form.businessName} onChange={(e) => set({ businessName: e.target.value })} />
        </Field>
        <Field label="Nombre comercial" htmlFor="s-trade">
          <TextInput id="s-trade" value={form.tradeName} onChange={(e) => set({ tradeName: e.target.value })} />
        </Field>
        <Field label="RFC" htmlFor="s-rfc">
          <TextInput id="s-rfc" maxLength={13} value={form.rfc} onChange={(e) => set({ rfc: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Contacto" htmlFor="s-contact">
          <TextInput id="s-contact" value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} />
        </Field>
        <Field label="Teléfono" htmlFor="s-phone">
          <TextInput id="s-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Correo" htmlFor="s-email">
          <TextInput id="s-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Condiciones de pago" htmlFor="s-terms">
          <TextInput id="s-terms" value={form.paymentTerms} placeholder="Contado, 30 días…" onChange={(e) => set({ paymentTerms: e.target.value })} />
        </Field>
        <Field label="Días de entrega" htmlFor="s-lead">
          <TextInput id="s-lead" inputMode="numeric" value={form.leadTimeDays} onChange={(e) => set({ leadTimeDays: e.target.value.replace(/\D/g, '') })} />
        </Field>
      </div>
      <Field label="Notas" htmlFor="s-notes">
        <TextInput id="s-notes" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      {supplier && (
        <label className="check">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Proveedor activo
        </label>
      )}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
