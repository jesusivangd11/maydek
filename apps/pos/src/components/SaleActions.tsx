import { useMemo, useRef, useState } from 'react';
import { ApiError, api, type ReturnDetail, type SaleDetail } from '../lib/api';
import { formatMoney, formatQty, toNumber } from '../lib/format';
import { Alert, Button, Field, Modal, Segmented, Select, TextInput } from '../ui';

/**
 * Operaciones sobre una venta ya cobrada.
 *
 * CANCELAR deshace la venta completa dentro del mismo turno: la mercancía
 * vuelve, el efectivo sale del cajón y la venta queda marcada, nunca borrada.
 *
 * DEVOLVER es parcial o total, en cualquier momento dentro de la política:
 * se eligen artículos y cantidades, y el cliente recibe su dinero o una nota
 * de crédito.
 *
 * Cuando el usuario no tiene el permiso, el servidor contesta FORBIDDEN y el
 * diálogo pide el PIN de un supervisor en el mismo lugar, sin perder lo
 * capturado: así funciona un mostrador real.
 */

const RETURN_REASONS = [
  { code: 'TALLA_INCORRECTA', label: 'Talla o medida incorrecta' },
  { code: 'DEFECTO', label: 'Producto defectuoso' },
  { code: 'NO_LE_GUSTO', label: 'No le gustó / cambió de opinión' },
  { code: 'ERROR_CAJA', label: 'Error al cobrar' },
  { code: 'OTRO', label: 'Otro motivo' },
];

const CANCEL_REASONS = [
  'El cliente se arrepintió',
  'Error al capturar la venta',
  'Cobro duplicado',
  'Pago rechazado',
];

export function CancelSaleDialog({
  sale,
  onDone,
  onClose,
}: {
  sale: SaleDetail;
  onDone: (sale: SaleDetail) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [needsPin, setNeedsPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.cancelSale(sale.id, {
        reason: reason.trim(),
        ...(pin ? { supervisorPin: pin } : {}),
      });
      onDone(updated);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'FORBIDDEN' || err.code === 'AUTHORIZATION_REQUIRED') && !pin) {
        setNeedsPin(true);
        setError('Se necesita la autorización de un supervisor. Pídele que escriba su PIN.');
      } else {
        setError(err instanceof ApiError ? err.message : 'No se pudo cancelar la venta');
      }
    } finally {
      setBusy(false);
    }
  }

  const cashBack = sale.payments
    .filter((p) => p.methodCode === 'CASH' && p.status !== 'VOIDED')
    .reduce((acc, p) => acc + toNumber(p.amount), 0);

  return (
    <Modal
      label="Cancelar venta"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
      head={
        <>
          <h2 className="modal__title">Cancelar la venta {sale.folio}</h2>
          <Button variant="subtle" icon="close" onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          <Button variant="subtle" onClick={onClose} disabled={busy}>
            No cancelar
          </Button>
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 3 || (needsPin && pin.length < 4)}
            onClick={submit}
          >
            {busy ? 'Cancelando…' : `Cancelar venta de ${formatMoney(sale.total)}`}
          </Button>
        </div>
      }
    >
      <p className="field__hint">
        La mercancía regresa al inventario y la venta queda marcada como cancelada.
        {cashBack > 0 && (
          <>
            {' '}
            Entrega al cliente <strong>{formatMoney(cashBack)}</strong> en efectivo: se descuentan
            de la caja.
          </>
        )}
      </p>
      <div className="quick-row">
        {CANCEL_REASONS.map((r) => (
          <button key={r} type="button" className="quick" onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      <Field label="Motivo" htmlFor="cancel-reason">
        <TextInput
          id="cancel-reason"
          autoFocus
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      {needsPin && (
        <Field label="PIN del supervisor" htmlFor="cancel-pin">
          <TextInput
            id="cancel-pin"
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            maxLength={8}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      )}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}

export function ReturnDialog({
  sale,
  onDone,
  onClose,
}: {
  sale: SaleDetail;
  onDone: (ret: ReturnDetail) => void;
  onClose: () => void;
}) {
  const returnable = sale.items.filter((i) => toNumber(i.qty) - toNumber(i.returnedQty) > 0);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  const [type, setType] = useState<'REFUND' | 'STORE_CREDIT'>('REFUND');
  const [method, setMethod] = useState('CASH');
  const [reason, setReason] = useState(RETURN_REASONS[0]!.code);
  const [notes, setNotes] = useState('');
  const [pin, setPin] = useState('');
  const [needsPin, setNeedsPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(`ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const paidByCredit = sale.payments.some((p) => p.methodCode === 'CREDIT');

  const estimate = useMemo(
    () =>
      returnable.reduce((acc, item) => {
        const n = Number(qty[item.id] ?? 0);
        if (!Number.isFinite(n) || n <= 0) return acc;
        return acc + (toNumber(item.lineTotal) / toNumber(item.qty)) * n;
      }, 0),
    [qty, returnable],
  );

  const selected = returnable
    .map((item) => ({ item, n: Number(qty[item.id] ?? 0) }))
    .filter(({ n }) => Number.isFinite(n) && n > 0);

  const invalid = selected.some(
    ({ item, n }) => n > toNumber(item.qty) - toNumber(item.returnedQty),
  );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const ret = await api.createReturn({
        saleId: sale.id,
        items: selected.map(({ item, n }) => ({
          saleItemId: item.id,
          qty: String(n),
          condition: damaged[item.id] ? 'DAMAGED' : 'GOOD',
        })),
        type,
        ...(type === 'REFUND' ? { refundMethodCode: method } : {}),
        reasonCode: reason,
        notes: notes || undefined,
        ...(pin ? { supervisorPin: pin } : {}),
        idempotencyKey: key.current,
      });
      onDone(ret);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'FORBIDDEN' || err.code === 'AUTHORIZATION_REQUIRED') && !pin) {
        setNeedsPin(true);
        setError(`${err.message}. Pide a un supervisor que escriba su PIN.`);
      } else if (err instanceof ApiError && err.code === 'CASH_SESSION_REQUIRED') {
        setError('Para reembolsar en efectivo la caja tiene que estar abierta.');
      } else {
        setError(err instanceof ApiError ? err.message : 'No se pudo registrar la devolución');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      label="Devolución"
      wide
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose();
      }}
      head={
        <>
          <h2 className="modal__title">Devolución de la venta {sale.folio}</h2>
          <Button variant="subtle" icon="close" onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          <span className="modal__summary">
            A devolver: <strong>{formatMoney(estimate)}</strong>
          </span>
          <Button
            variant="primary"
            disabled={busy || selected.length === 0 || invalid || (needsPin && pin.length < 4)}
            onClick={submit}
          >
            {busy ? 'Registrando…' : 'Registrar devolución'}
          </Button>
        </div>
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th>Artículo</th>
            <th className="table__num">Vendido</th>
            <th className="table__num">Devolver</th>
            <th>Dañado</th>
          </tr>
        </thead>
        <tbody>
          {returnable.map((item) => {
            const pending = toNumber(item.qty) - toNumber(item.returnedQty);
            return (
              <tr key={item.id}>
                <td>
                  {item.name}
                  <div className="subtle text-sm">{formatMoney(toNumber(item.lineTotal) / toNumber(item.qty))} c/u</div>
                </td>
                <td className="table__num">
                  {formatQty(item.qty)}
                  {toNumber(item.returnedQty) > 0 && (
                    <div className="subtle text-sm">ya dev. {formatQty(item.returnedQty)}</div>
                  )}
                </td>
                <td className="table__num">
                  <div className="stepper stepper--sm">
                    <button
                      type="button"
                      className="stepper__btn"
                      onClick={() =>
                        setQty((q) => ({ ...q, [item.id]: String(Math.max(0, Number(q[item.id] ?? 0) - 1)) }))
                      }
                    >
                      −
                    </button>
                    <input
                      className="stepper__qty"
                      inputMode="decimal"
                      value={qty[item.id] ?? '0'}
                      aria-label={`Cantidad a devolver de ${item.name}`}
                      onChange={(e) => setQty((q) => ({ ...q, [item.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="stepper__btn"
                      disabled={Number(qty[item.id] ?? 0) >= pending}
                      onClick={() =>
                        setQty((q) => ({ ...q, [item.id]: String(Math.min(pending, Number(q[item.id] ?? 0) + 1)) }))
                      }
                    >
                      +
                    </button>
                  </div>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={Boolean(damaged[item.id])}
                    aria-label={`${item.name} viene dañado`}
                    onChange={(e) => setDamaged((d) => ({ ...d, [item.id]: e.target.checked }))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="field__hint">
        Lo dañado va al almacén de mermas y no vuelve a la venta.
      </p>

      <div className="form-grid">
        <Field label="Motivo" htmlFor="ret-reason">
          <Select id="ret-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {RETURN_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notas" htmlFor="ret-notes">
          <TextInput id="ret-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      {paidByCredit ? (
        <p className="field__hint">
          La venta fue a crédito: lo devuelto se abona a la cuenta del cliente.
        </p>
      ) : (
        <>
          <Segmented
            block
            label="Cómo se devuelve el dinero"
            value={type}
            onChange={setType}
            options={[
              { value: 'REFUND', label: 'Reembolso' },
              { value: 'STORE_CREDIT', label: 'Nota de crédito' },
            ]}
          />
          {type === 'REFUND' && (
            <Field label="Reembolsar con" htmlFor="ret-method">
              <Select id="ret-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">Efectivo (sale de la caja)</option>
                <option value="CARD_DEBIT">Tarjeta de débito</option>
                <option value="CARD_CREDIT">Tarjeta de crédito</option>
                <option value="TRANSFER">Transferencia</option>
              </Select>
            </Field>
          )}
          {type === 'STORE_CREDIT' && (
            <p className="field__hint">
              Se imprime una nota de crédito con folio. El cliente la usa como forma de pago en su
              siguiente compra.
            </p>
          )}
        </>
      )}

      {needsPin && (
        <Field label="PIN del supervisor" htmlFor="ret-pin">
          <TextInput
            id="ret-pin"
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            maxLength={8}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      )}
      {invalid && <Alert>No puedes devolver más de lo pendiente en algún renglón.</Alert>}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
