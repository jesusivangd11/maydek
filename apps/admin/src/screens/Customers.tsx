import { useState } from 'react';
import { api, type CustomerDetail, type CustomerInput, type PriceList } from '@pos/lib/api';
import { formatDateTime, formatMoney, toNumber } from '@pos/lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  TextInput,
} from '@pos/ui';
import type { ScreenProps } from '../App';
import { can, downloadCsv, errorText, useLoad } from '../lib/util';

/**
 * Clientes.
 *
 * Ficha, lista de precios (el mayorista ve su precio en caja), crédito con
 * límite y días, estado de cuenta por asientos y abonos. El saldo nunca se
 * edita: se mueve con ventas a crédito, abonos y devoluciones.
 */

const ENTRY_LABELS: Record<string, string> = {
  CHARGE: 'Venta a crédito',
  PAYMENT: 'Abono',
  CREDIT_NOTE: 'Nota de crédito',
  ADJUSTMENT: 'Ajuste',
  REFUND: 'Devolución',
};

export function CustomersScreen({ user }: ScreenProps) {
  const [search, setSearch] = useState('');
  const [withBalance, setWithBalance] = useState(false);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const list = useLoad(
    () => api.listCustomers({ search: search || undefined, withBalance: withBalance || undefined, includeInactive: true, limit: 200 }),
    [search, withBalance],
  );
  const priceLists = useLoad(() => api.priceLists().catch(() => [] as PriceList[]), []);

  return (
    <div className="page">
      <PageHeader
        title="Clientes"
        subtitle="Fichas, precios de mayoreo, crédito y cobranza."
        actions={
          can(user.permissions, 'customer.create') && (
            <Button variant="primary" icon="plus" onClick={() => setOpen('new')}>
              Nuevo cliente
            </Button>
          )
        }
      />

      <div className="toolbar">
        <SearchInput
          compact
          value={search}
          placeholder="Nombre, teléfono, correo o RFC…"
          aria-label="Buscar clientes"
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={withBalance} onChange={(e) => setWithBalance(e.target.checked)} />
          Solo con saldo pendiente
        </label>
        <span className="toolbar__spacer" />
        <Button
          variant="subtle"
          icon="download"
          disabled={!list.data?.data.length}
          onClick={() =>
            downloadCsv('clientes.csv', (list.data?.data ?? []).map((c) => ({
              Nombre: c.name,
              Teléfono: c.phone ?? '',
              Correo: c.email ?? '',
              RFC: c.rfc ?? '',
              'Lista de precios': c.priceList?.name ?? '',
              'Límite de crédito': c.creditLimit,
              Saldo: c.balance,
              'Total comprado': c.totalPurchased,
              Compras: c.purchaseCount,
            })))
          }
        >
          Exportar
        </Button>
      </div>

      {list.error && <Alert>{list.error}</Alert>}
      {list.data && list.data.data.length === 0 && (
        <Card>
          <EmptyState icon="users" title="Sin clientes que mostrar" />
        </Card>
      )}
      {list.data && list.data.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Contacto</th>
                <th>Lista</th>
                <th className="table__money">Comprado</th>
                <th className="table__money">Saldo</th>
                <th>Última compra</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((c) => (
                <tr key={c.id} className="table__row--clickable" tabIndex={0} onClick={() => setOpen(c.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(c.id)}>
                  <td>
                    <strong>{c.name}</strong>
                    {!c.isActive && <Badge>Inactivo</Badge>}
                    {c.rfc && <div className="mono subtle text-sm">{c.rfc}</div>}
                  </td>
                  <td className="muted text-sm">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{c.priceList ? <Badge tone="info" dot={false}>{c.priceList.name}</Badge> : '—'}</td>
                  <td className="table__money">{formatMoney(c.totalPurchased)}</td>
                  <td className="table__money">
                    {toNumber(c.balance) > 0 ? <strong style={{ color: 'var(--warning)' }}>{formatMoney(c.balance)}</strong> : formatMoney(c.balance)}
                  </td>
                  <td className="muted text-sm">{c.lastPurchaseAt ? formatDateTime(c.lastPurchaseAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <CustomerDialog
          id={open === 'new' ? null : open}
          priceLists={priceLists.data ?? []}
          permissions={user.permissions}
          onClose={() => {
            setOpen(null);
            void list.reload();
          }}
          onCreated={(id) => setOpen(id)}
        />
      )}
    </div>
  );
}

function CustomerDialog({
  id,
  priceLists,
  permissions,
  onClose,
  onCreated,
}: {
  id: string | null;
  priceLists: PriceList[];
  permissions: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [tab, setTab] = useState<'ficha' | 'cuenta'>('ficha');
  const detail = useLoad(() => (id ? api.getCustomer(id) : Promise.resolve(null)), [id]);

  return (
    <Modal
      label="Cliente"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">{id ? (detail.data?.name ?? 'Cliente') : 'Nuevo cliente'}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
    >
      {id && (
        <Segmented
          label="Sección"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'ficha', label: 'Ficha' },
            { value: 'cuenta', label: 'Estado de cuenta' },
          ]}
        />
      )}
      {detail.error && <Alert>{detail.error}</Alert>}
      {(!id || detail.data) && tab === 'ficha' && (
        <CustomerForm
          customer={detail.data}
          priceLists={priceLists}
          permissions={permissions}
          onSaved={(saved) => {
            if (!id) onCreated(saved.id);
            else detail.setData(saved);
          }}
        />
      )}
      {id && detail.data && tab === 'cuenta' && (
        <AccountPanel customer={detail.data} canCollect={can(permissions, 'customer.account.view')} onChanged={detail.reload} />
      )}
    </Modal>
  );
}

function CustomerForm({
  customer,
  priceLists,
  permissions,
  onSaved,
}: {
  customer: CustomerDetail | null;
  priceLists: PriceList[];
  permissions: string[];
  onSaved: (customer: CustomerDetail) => void;
}) {
  const [form, setForm] = useState<CustomerInput>({
    type: customer?.type ?? 'PERSON',
    firstName: customer?.firstName ?? '',
    lastName: customer?.lastName ?? '',
    businessName: customer?.businessName ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    rfc: customer?.rfc ?? '',
    fiscalName: customer?.fiscalName ?? '',
    fiscalPostalCode: customer?.fiscalPostalCode ?? '',
    address: customer?.address ?? '',
    priceListId: customer?.priceList?.id ?? null,
    creditLimit: customer ? String(Number(customer.creditLimit)) : '0',
    creditDays: customer?.creditDays ?? 0,
    notes: customer?.notes ?? '',
    isActive: customer?.isActive ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canCredit = can(permissions, 'customer.credit.manage');
  const canEdit = customer ? can(permissions, 'customer.update') : can(permissions, 'customer.create');
  const set = (patch: Partial<CustomerInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
  };

  async function save() {
    setBusy(true);
    setError(null);
    const body: CustomerInput = {
      ...form,
      rfc: form.rfc?.trim() || undefined,
      email: form.email?.trim() || undefined,
      ...(canCredit ? {} : { creditLimit: undefined, creditDays: undefined }),
    };
    if (!customer && !canCredit) {
      delete body.creditLimit;
      delete body.creditDays;
    }
    try {
      const result = customer ? await api.updateCustomer(customer.id, body) : await api.createCustomer(body);
      setSaved(true);
      onSaved(result);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Segmented
        label="Tipo de cliente"
        value={form.type ?? 'PERSON'}
        onChange={(type) => set({ type })}
        options={[
          { value: 'PERSON', label: 'Persona' },
          { value: 'COMPANY', label: 'Empresa' },
        ]}
      />
      <div className="form-grid">
        {form.type === 'COMPANY' ? (
          <div className="field--wide">
            <Field label="Razón social / nombre comercial" htmlFor="cu-biz">
              <TextInput id="cu-biz" value={form.businessName ?? ''} onChange={(e) => set({ businessName: e.target.value })} />
            </Field>
          </div>
        ) : (
          <>
            <Field label="Nombre" htmlFor="cu-first">
              <TextInput id="cu-first" value={form.firstName ?? ''} onChange={(e) => set({ firstName: e.target.value })} />
            </Field>
            <Field label="Apellidos" htmlFor="cu-last">
              <TextInput id="cu-last" value={form.lastName ?? ''} onChange={(e) => set({ lastName: e.target.value })} />
            </Field>
          </>
        )}
        <Field label="Teléfono" htmlFor="cu-phone">
          <TextInput id="cu-phone" inputMode="tel" value={form.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Correo" htmlFor="cu-email">
          <TextInput id="cu-email" type="email" value={form.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <div className="field--wide">
          <Field label="Dirección" htmlFor="cu-addr">
            <TextInput id="cu-addr" value={form.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
          </Field>
        </div>
        <Field label="Lista de precios" htmlFor="cu-pl" hint="Mayoreo, distribuidor… se aplica sola en caja.">
          <Select id="cu-pl" value={form.priceListId ?? ''} onChange={(e) => set({ priceListId: e.target.value || null })}>
            <option value="">Precio de mostrador</option>
            {priceLists.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Límite de crédito" htmlFor="cu-limit" hint={canCredit ? '0 = sin crédito.' : 'Requiere permiso de crédito.'}>
          <TextInput id="cu-limit" inputMode="decimal" disabled={!canCredit} value={form.creditLimit ?? ''} onChange={(e) => set({ creditLimit: e.target.value.replace(/[^\d.]/g, '') })} />
        </Field>
        <Field label="Días de crédito" htmlFor="cu-days">
          <TextInput id="cu-days" inputMode="numeric" disabled={!canCredit} value={String(form.creditDays ?? 0)} onChange={(e) => set({ creditDays: Number(e.target.value.replace(/\D/g, '') || 0) })} />
        </Field>
        <Field label="RFC" htmlFor="cu-rfc" hint="Para facturar.">
          <TextInput id="cu-rfc" value={form.rfc ?? ''} maxLength={13} onChange={(e) => set({ rfc: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Razón social fiscal" htmlFor="cu-fn">
          <TextInput id="cu-fn" value={form.fiscalName ?? ''} onChange={(e) => set({ fiscalName: e.target.value })} />
        </Field>
        <Field label="C.P. fiscal" htmlFor="cu-cp">
          <TextInput id="cu-cp" inputMode="numeric" maxLength={5} value={form.fiscalPostalCode ?? ''} onChange={(e) => set({ fiscalPostalCode: e.target.value.replace(/\D/g, '') })} />
        </Field>
        <div className="field--wide">
          <Field label="Notas" htmlFor="cu-notes">
            <TextInput id="cu-notes" value={form.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
        {customer && (
          <label className="check">
            <input type="checkbox" checked={form.isActive ?? true} onChange={(e) => set({ isActive: e.target.checked })} />
            Cliente activo
          </label>
        )}
      </div>
      {customer && (
        <div className="stats">
          <div className="stat"><span className="stat__label">Total comprado</span><span className="stat__value stat__value--sm">{formatMoney(customer.totalPurchased)}</span></div>
          <div className="stat"><span className="stat__label">Compras</span><span className="stat__value stat__value--sm">{customer.purchaseCount}</span></div>
          <div className="stat"><span className="stat__label">Ticket promedio</span><span className="stat__value stat__value--sm">{formatMoney(customer.averageTicket)}</span></div>
          <div className="stat"><span className="stat__label">Saldo</span><span className="stat__value stat__value--sm">{formatMoney(customer.balance)}</span></div>
        </div>
      )}
      {customer && customer.creditNotes.length > 0 && (
        <Alert tone="warning">
          Notas de crédito vigentes: {customer.creditNotes.map((n) => `${n.folio} (${formatMoney(n.available)})`).join(', ')}
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {saved && <p className="toast">Cliente guardado.</p>}
      <div className="modal__actions">
        <Button variant="primary" disabled={busy || !canEdit} onClick={save}>
          {busy ? 'Guardando…' : customer ? 'Guardar cambios' : 'Crear cliente'}
        </Button>
      </div>
    </>
  );
}

function AccountPanel({
  customer,
  canCollect,
  onChanged,
}: {
  customer: CustomerDetail;
  canCollect: boolean;
  onChanged: () => void;
}) {
  const statement = useLoad(() => api.customerStatement(customer.id), [customer.id]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      statement.setData(
        await api.customerPayment(customer.id, { amount: Number(amount).toFixed(2), methodCode: method, reference: reference || undefined }),
      );
      setAmount('');
      setReference('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const balance = toNumber(statement.data?.balance ?? customer.balance);

  return (
    <>
      <div className="stats">
        <div className="stat stat--key">
          <span className="stat__label">Saldo pendiente</span>
          <span className="stat__value">{formatMoney(balance)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">Límite de crédito</span>
          <span className="stat__value stat__value--sm">{formatMoney(customer.creditLimit)}</span>
          <span className="stat__foot">Disponible {formatMoney(customer.creditAvailable)}</span>
        </div>
      </div>
      {statement.error && <Alert>{statement.error}</Alert>}
      {statement.data && statement.data.entries.length === 0 && <EmptyState icon="receipt" title="Sin movimientos en la cuenta" />}
      {statement.data && statement.data.entries.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Concepto</th>
              <th>Referencia</th>
              <th className="table__money">Cargo</th>
              <th className="table__money">Abono</th>
              <th className="table__money">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {statement.data.entries.map((e) => (
              <tr key={e.id}>
                <td className="text-sm tnum">{formatDateTime(e.occurredAt)}</td>
                <td>
                  {ENTRY_LABELS[e.type] ?? e.type}
                  {e.notes && <div className="subtle text-sm">{e.notes}</div>}
                </td>
                <td className="mono text-sm">{e.referenceFolio ?? '—'}</td>
                <td className="table__money">{toNumber(e.amount) > 0 ? formatMoney(e.amount) : ''}</td>
                <td className="table__money">{toNumber(e.amount) < 0 ? formatMoney(-toNumber(e.amount)) : ''}</td>
                <td className="table__money table__money--strong">{formatMoney(e.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canCollect && balance > 0 && (
        <Card title="Registrar abono">
          <div className="form-grid form-grid--3" style={{ alignItems: 'end' }}>
            <Field label="Importe" htmlFor="ab-amount">
              <TextInput id="ab-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            <Field label="Forma de pago" htmlFor="ab-method">
              <Select id="ab-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">Efectivo (entra a la caja abierta)</option>
                <option value="TRANSFER">Transferencia</option>
                <option value="CARD_DEBIT">Tarjeta de débito</option>
                <option value="CARD_CREDIT">Tarjeta de crédito</option>
              </Select>
            </Field>
            {method !== 'CASH' && (
              <Field label="Referencia" htmlFor="ab-ref">
                <TextInput id="ab-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
            )}
            <Button variant="primary" disabled={busy || !(Number(amount) > 0) || (method !== 'CASH' && !reference)} onClick={pay}>
              {busy ? 'Registrando…' : 'Registrar abono'}
            </Button>
          </div>
          {error && <Alert>{error}</Alert>}
        </Card>
      )}
    </>
  );
}
