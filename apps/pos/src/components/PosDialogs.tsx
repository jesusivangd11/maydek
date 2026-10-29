import { useEffect, useState } from 'react';
import { ApiError, api, type Customer, type HeldSale } from '../lib/api';
import { formatDateTime, formatMoney, toNumber } from '../lib/format';
import { Alert, Button, EmptyState, Field, Icon, Modal, SearchInput, Segmented, TextInput } from '../ui';

/**
 * Diálogos del mostrador: cliente, descuento y tickets en espera.
 *
 * Los tres se abren con una tecla (F4, F5, F6) y se cierran con Esc. Ninguno
 * obliga al ratón: el cajero tiene una mano en el lector y la otra en el
 * teclado.
 */

// ── Cliente ─────────────────────────────────────────────────────────────────

export type PickedCustomer = Pick<Customer, 'id' | 'name' | 'creditAvailable' | 'priceList' | 'phone'>;

export function CustomerPicker({
  canCreate,
  onPick,
  onClose,
}: {
  canCreate: boolean;
  onPick: (customer: PickedCustomer | null) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      setBusy(true);
      try {
        const response = await api.listCustomers({ search: term || undefined, limit: 12 });
        if (!cancelled) {
          setResults(response.data);
          setHighlight(0);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'No se pudo buscar');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, term ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [term]);

  if (creating) {
    return (
      <QuickCustomerForm
        initialName={term}
        onCancel={() => setCreating(false)}
        onCreated={(customer) => onPick(customer)}
      />
    );
  }

  return (
    <Modal
      label="Elegir cliente"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setHighlight((h) => Math.min(h + 1, results.length - 1));
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setHighlight((h) => Math.max(h - 1, 0));
        }
        if (event.key === 'Enter' && results[highlight]) onPick(results[highlight]!);
      }}
      head={
        <>
          <h2 className="modal__title">Cliente de la venta</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          <Button variant="secondary" onClick={() => onPick(null)}>
            Público en general
          </Button>
          {canCreate && (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              Nuevo cliente
            </Button>
          )}
        </div>
      }
    >
      <SearchInput
        compact
        autoFocus
        busy={busy}
        value={term}
        placeholder="Nombre, teléfono, correo o RFC…"
        aria-label="Buscar cliente"
        onChange={(event) => setTerm(event.target.value)}
      />
      {error && <Alert>{error}</Alert>}
      {!busy && results.length === 0 && (
        <EmptyState icon="user" title="Ningún cliente coincide" text="Puedes darlo de alta en este momento." />
      )}
      <ul className="pick-list">
        {results.map((customer, index) => (
          <li key={customer.id}>
            <button
              type="button"
              className="pick-list__item"
              aria-selected={index === highlight}
              onClick={() => onPick(customer)}
            >
              <span className="pick-list__main">
                <strong>{customer.name}</strong>
                <span className="subtle text-sm">
                  {[customer.phone, customer.email, customer.rfc].filter(Boolean).join(' · ') || 'Sin datos de contacto'}
                </span>
              </span>
              <span className="pick-list__side">
                {customer.priceList && customer.priceList.code !== 'PUBLICO' && (
                  <span className="badge badge--info">{customer.priceList.name}</span>
                )}
                {toNumber(customer.balance) > 0 && (
                  <span className="badge badge--warning">Debe {formatMoney(customer.balance)}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function QuickCustomerForm({
  initialName,
  onCancel,
  onCreated,
}: {
  initialName: string;
  onCancel: () => void;
  onCreated: (customer: PickedCustomer) => void;
}) {
  const looksLikePhone = /^\+?[\d\s-]{7,}$/.test(initialName);
  const [firstName, setFirstName] = useState(looksLikePhone ? '' : initialName);
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState(looksLikePhone ? initialName : '');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const customer = await api.createCustomer({
        firstName,
        lastName: lastName || undefined,
        phone: phone || undefined,
        email: email || undefined,
      });
      onCreated(customer);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el cliente');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      label="Nuevo cliente"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      head={<h2 className="modal__title">Nuevo cliente</h2>}
      foot={
        <div className="modal__actions">
          <Button variant="subtle" onClick={onCancel}>
            Volver
          </Button>
          <Button variant="primary" disabled={busy || firstName.trim().length < 2} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar y usar'}
          </Button>
        </div>
      }
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Nombre" htmlFor="c-first">
          <TextInput id="c-first" autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </Field>
        <Field label="Apellidos" htmlFor="c-last">
          <TextInput id="c-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </Field>
        <Field label="Teléfono" htmlFor="c-phone">
          <TextInput id="c-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Correo" htmlFor="c-email">
          <TextInput id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}

// ── Descuento ───────────────────────────────────────────────────────────────

export function DiscountDialog({
  title,
  base,
  current,
  onApply,
  onClose,
}: {
  title: string;
  /** Importe sobre el que se calcula el porcentaje. */
  base: number;
  current: number;
  onApply: (amount: number) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState(current > 0 ? String(current) : '');
  const parsed = Number(value.replace(',', '.'));
  const amount =
    !Number.isFinite(parsed) || parsed < 0
      ? 0
      : mode === 'percent'
        ? Math.round(base * Math.min(parsed, 100)) / 100
        : Math.min(parsed, base);

  return (
    <Modal
      label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'Enter') onApply(amount);
      }}
      head={
        <>
          <h2 className="modal__title">{title}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          {current > 0 && (
            <Button variant="danger" onClick={() => onApply(0)}>
              Quitar descuento
            </Button>
          )}
          <Button variant="primary" onClick={() => onApply(amount)}>
            Aplicar −{formatMoney(amount)}
          </Button>
        </div>
      }
    >
      <Segmented
        block
        label="Tipo de descuento"
        value={mode}
        onChange={(next) => {
          setMode(next);
          setValue('');
        }}
        options={[
          { value: 'percent', label: 'Porcentaje %' },
          { value: 'amount', label: 'Importe $' },
        ]}
      />
      <Field
        label={mode === 'percent' ? 'Porcentaje' : 'Importe a descontar'}
        htmlFor="discount"
        hint={`Sobre ${formatMoney(base)}. Queda en ${formatMoney(base - amount)}.`}
      >
        <TextInput
          id="discount"
          amount
          autoFocus
          inputMode="decimal"
          value={value}
          placeholder={mode === 'percent' ? '10' : '0.00'}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, ''))}
        />
      </Field>
      {mode === 'percent' && (
        <div className="quick-row">
          {[5, 10, 15, 20, 50].map((pct) => (
            <button key={pct} type="button" className="quick" onClick={() => setValue(String(pct))}>
              {pct} %
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── Tickets en espera ───────────────────────────────────────────────────────

export function HeldSalesDialog({
  onResume,
  onClose,
}: {
  onResume: (held: HeldSale) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<HeldSale[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api.listHeld());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los tickets');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Modal
      label="Tickets en espera"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      head={
        <>
          <h2 className="modal__title">Tickets en espera</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      {rows === null && !error && <p className="subtle center">Cargando…</p>}
      {rows?.length === 0 && (
        <EmptyState
          icon="pause"
          title="No hay tickets en espera"
          text="Usa «En espera» (F6) para apartar un ticket mientras atiendes a otro cliente."
        />
      )}
      <ul className="pick-list">
        {rows?.map((held) => {
          const lines = Array.isArray(held.cart.lines) ? held.cart.lines.length : 0;
          return (
            <li key={held.id} className="pick-list__row">
              <button
                type="button"
                className="pick-list__item"
                onClick={async () => {
                  try {
                    onResume(await api.resumeHeld(held.id));
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : 'No se pudo recuperar');
                  }
                }}
              >
                <span className="pick-list__main">
                  <strong>{held.label || held.cart.customer?.name || 'Ticket sin nombre'}</strong>
                  <span className="subtle text-sm">
                    {lines} {lines === 1 ? 'renglón' : 'renglones'} · {formatDateTime(held.createdAt)}
                    {held.user ? ` · ${held.user.name}` : ''}
                  </span>
                </span>
                <span className="pick-list__side">
                  <Icon name="back" size={16} /> Recuperar
                </span>
              </button>
              <Button
                variant="subtle"
                size="sm"
                icon="trash"
                aria-label="Descartar ticket"
                onClick={async () => {
                  await api.discardHeld(held.id).catch(() => undefined);
                  void load();
                }}
              />
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
