import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type CreditNoteInfo, type SalePaymentInput } from '../lib/api';
import { formatMoney, toNumber } from '../lib/format';
import { Alert, Button, Field, Icon, Modal, Segmented, Select, TextInput } from '../ui';

/**
 * Cobro.
 *
 * El efectivo es el caso que se optimiza, porque es el 80 % de las operaciones
 * de mostrador: el campo entra enfocado, hay botones de importes redondos y el
 * cambio se calcula mientras se teclea. El botón de confirmar NO se habilita
 * si lo recibido no alcanza.
 *
 * PAGO MIXTO: "Agregar otro pago" aparta una parte con otra forma de pago
 * (500 con tarjeta y el resto en efectivo). Lo apartado se lista arriba y la
 * forma de pago principal cubre solo lo que FALTA. El servidor recibe N pagos
 * y exige que sumen el total al centavo.
 *
 * Crédito del cliente solo aparece con un cliente elegido. Crédito a favor
 * pide el folio de la nota y muestra su saldo antes de cobrar.
 */

interface PaymentMethod {
  code: string;
  name: string;
  affectsCash: boolean;
  requiresReference: boolean;
  kind: 'CASH' | 'CARD' | 'TRANSFER' | 'CREDIT' | 'STORE_CREDIT';
}

const METHODS: PaymentMethod[] = [
  { code: 'CASH', name: 'Efectivo', affectsCash: true, requiresReference: false, kind: 'CASH' },
  { code: 'CARD_DEBIT', name: 'Débito', affectsCash: false, requiresReference: true, kind: 'CARD' },
  { code: 'CARD_CREDIT', name: 'T. crédito', affectsCash: false, requiresReference: true, kind: 'CARD' },
  { code: 'TRANSFER', name: 'Transferencia', affectsCash: false, requiresReference: true, kind: 'TRANSFER' },
  { code: 'CREDIT', name: 'A crédito', affectsCash: false, requiresReference: false, kind: 'CREDIT' },
  { code: 'STORE_CREDIT', name: 'Nota de crédito', affectsCash: false, requiresReference: true, kind: 'STORE_CREDIT' },
];

/** Importes con los que la gente paga de verdad. */
function quickAmounts(total: number): number[] {
  const options = new Set<number>();
  options.add(Math.ceil(total * 100) / 100);
  for (const step of [50, 100, 200, 500, 1000]) {
    const rounded = Math.ceil(total / step) * step;
    if (rounded >= total) options.add(rounded);
  }
  return [...options].sort((a, b) => a - b).slice(0, 5);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function PaymentDialog({
  total,
  busy,
  error,
  customer,
  onCancel,
  onConfirm,
}: {
  total: number;
  busy: boolean;
  error: string | null;
  customer: { id: string; name: string; creditAvailable: string } | null;
  onCancel: () => void;
  onConfirm: (payments: SalePaymentInput[], cashReceived?: string) => void;
}) {
  const available = METHODS.filter((m) => m.kind !== 'CREDIT' || customer !== null);

  const [partials, setPartials] = useState<SalePaymentInput[]>([]);
  const [method, setMethod] = useState<PaymentMethod>(METHODS[0]!);
  const [received, setReceived] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState<CreditNoteInfo | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  const partialSum = round2(partials.reduce((acc, p) => acc + toNumber(p.amount), 0));
  const remaining = round2(Math.max(0, total - partialSum));

  useEffect(() => {
    amountRef.current?.focus();
    amountRef.current?.select();
  }, [method, partials.length]);

  // Nota de crédito: se consulta su saldo al escribir el folio completo.
  useEffect(() => {
    setNote(null);
    setNoteError(null);
    if (method.kind !== 'STORE_CREDIT' || reference.trim().length < 6) return;
    const handle = setTimeout(() => {
      api
        .creditNote(reference)
        .then((info) => {
          if (info.status === 'USED' || info.status === 'CANCELLED' || toNumber(info.available) <= 0) {
            setNoteError(`La nota ${info.folio} ya no tiene saldo`);
          } else {
            setNote(info);
          }
        })
        .catch((err) =>
          setNoteError(err instanceof ApiError ? err.message : 'No se pudo consultar la nota'),
        );
    }, 300);
    return () => clearTimeout(handle);
  }, [method.kind, reference]);

  const receivedNumber = Number(received.replace(',', '.'));
  const isCash = method.affectsCash;

  const change = useMemo(() => {
    if (!isCash || !Number.isFinite(receivedNumber)) return 0;
    return Math.max(0, receivedNumber - remaining);
  }, [isCash, receivedNumber, remaining]);

  // Lo que cubre el método principal. La nota de crédito cubre hasta su saldo:
  // si no alcanza, el resto se aparta como otro pago.
  const mainAmount =
    method.kind === 'STORE_CREDIT' && note ? Math.min(remaining, toNumber(note.available)) : remaining;

  const creditAvailable = toNumber(customer?.creditAvailable);
  const overCredit = method.kind === 'CREDIT' && mainAmount > creditAvailable + 0.001;
  const insufficient = isCash && remaining > 0 && (!received || receivedNumber < remaining);
  const missingReference = method.requiresReference && remaining > 0 && reference.trim().length === 0;
  const noteShort = method.kind === 'STORE_CREDIT' && remaining > 0 && (!note || mainAmount < remaining);
  const canConfirm =
    !busy && !insufficient && !missingReference && !overCredit && !noteShort && !splitting;

  function selectMethod(code: string) {
    const next = METHODS.find((m) => m.code === code)!;
    setMethod(next);
    setReference('');
    setReceived(next.affectsCash ? '' : remaining.toFixed(2));
  }

  function confirm() {
    if (!canConfirm) return;

    const payments: SalePaymentInput[] = [...partials];
    if (remaining > 0) {
      payments.push({
        methodCode: method.code,
        amount: remaining.toFixed(2),
        ...(reference.trim() ? { reference: reference.trim().toUpperCase() } : {}),
      });
    }

    onConfirm(payments, isCash && remaining > 0 ? Math.max(receivedNumber, remaining).toFixed(2) : undefined);
  }

  return (
    <Modal
      label="Cobrar"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          if (splitting) setSplitting(false);
          else onCancel();
        }
        if (event.key === 'Enter' && canConfirm) confirm();
      }}
      head={
        <>
          <div className="pay__total">
            <span className="pay__label">
              {partials.length > 0 ? 'Falta por cobrar' : 'Total a cobrar'}
            </span>
            <span className="pay__amount">{formatMoney(partials.length > 0 ? remaining : total)}</span>
          </div>
          <Button variant="subtle" icon="close" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
        </>
      }
      foot={
        <>
          <Button variant="primary" size="xl" onClick={confirm} disabled={!canConfirm}>
            {busy ? 'Registrando…' : `Cobrar ${formatMoney(total)}`}
          </Button>
          <p className="field__hint center" style={{ marginTop: 'var(--s-3)' }}>
            <kbd className="kbd">Enter</kbd> confirmar · <kbd className="kbd">Esc</kbd> volver
          </p>
        </>
      }
    >
      {customer && (
        <p className="pay__customer">
          <Icon name="user" size={16} /> {customer.name}
          {toNumber(customer.creditAvailable) > 0 && (
            <span className="subtle"> · crédito disponible {formatMoney(customer.creditAvailable)}</span>
          )}
        </p>
      )}

      {partials.length > 0 && (
        <div className="pay__partials">
          {partials.map((p, index) => (
            <div key={`${p.methodCode}-${index}`} className="method-row">
              <span className="method-row__name">
                {METHODS.find((m) => m.code === p.methodCode)?.name ?? p.methodCode}
                {p.reference && <span className="mono subtle text-sm"> {p.reference}</span>}
              </span>
              <span className="method-row__amount">{formatMoney(p.amount)}</span>
              <button
                type="button"
                className="line__remove"
                aria-label="Quitar este pago"
                disabled={busy}
                onClick={() => setPartials((current) => current.filter((_, i) => i !== index))}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {splitting ? (
        <SplitForm
          methods={available}
          max={remaining}
          creditAvailable={creditAvailable}
          onCancel={() => setSplitting(false)}
          onAdd={(payment) => {
            setPartials((current) => [...current, payment]);
            setSplitting(false);
            setReceived('');
          }}
        />
      ) : (
        remaining > 0 && (
          <>
            <Segmented
              block
              label="Forma de pago"
              value={method.code}
              disabled={busy}
              options={available.map((m) => ({ value: m.code, label: m.name }))}
              onChange={selectMethod}
            />

            {isCash && (
              <>
                <Field label="Efectivo recibido" htmlFor="received">
                  <TextInput
                    id="received"
                    ref={amountRef}
                    amount
                    inputMode="decimal"
                    value={received}
                    placeholder="0.00"
                    disabled={busy}
                    onChange={(event) => setReceived(event.target.value.replace(/[^\d.,]/g, ''))}
                  />
                </Field>

                <div className="quick-row">
                  {quickAmounts(remaining).map((amount) => (
                    <button
                      key={amount}
                      type="button"
                      className="quick"
                      disabled={busy}
                      onClick={() => setReceived(amount.toFixed(2))}
                    >
                      {formatMoney(amount)}
                    </button>
                  ))}
                </div>

                <div className={change > 0 ? 'change change--positive' : 'change'}>
                  <span className="change__label">Cambio</span>
                  <strong className="change__amount">{formatMoney(change)}</strong>
                </div>

                {insufficient && received !== '' && (
                  <Alert>Faltan {formatMoney(remaining - receivedNumber)} para completar el pago.</Alert>
                )}
              </>
            )}

            {(method.kind === 'CARD' || method.kind === 'TRANSFER') && (
              <Field
                label="Referencia o autorización"
                htmlFor="reference"
                hint="Obligatoria: es lo que permite cuadrar el cobro contra el estado de cuenta."
              >
                <TextInput
                  id="reference"
                  ref={amountRef}
                  large
                  value={reference}
                  placeholder="Últimos 4 dígitos, folio de autorización…"
                  disabled={busy}
                  onChange={(event) => setReference(event.target.value)}
                />
              </Field>
            )}

            {method.kind === 'CREDIT' && (
              <>
                <p className="field__hint">
                  Se cargan {formatMoney(remaining)} a la cuenta de {customer?.name}. Crédito
                  disponible: {formatMoney(creditAvailable)}.
                </p>
                {overCredit && (
                  <Alert>
                    El cliente no tiene crédito suficiente. Cobra una parte con otra forma de pago.
                  </Alert>
                )}
              </>
            )}

            {method.kind === 'STORE_CREDIT' && (
              <>
                <Field label="Folio de la nota de crédito" htmlFor="note">
                  <TextInput
                    id="note"
                    ref={amountRef}
                    large
                    value={reference}
                    placeholder="A-NC-000001"
                    disabled={busy}
                    onChange={(event) => setReference(event.target.value.toUpperCase())}
                  />
                </Field>
                {note && (
                  <p className="field__hint">
                    Saldo de la nota: <strong>{formatMoney(note.available)}</strong>
                    {note.customer ? ` · ${note.customer.name}` : ''}
                  </p>
                )}
                {noteError && <Alert>{noteError}</Alert>}
                {note && mainAmount < remaining && (
                  <Alert tone="warning">
                    La nota cubre {formatMoney(mainAmount)}. Aparta ese importe con «Agregar otro
                    pago» y cobra el resto con otra forma.
                  </Alert>
                )}
              </>
            )}
          </>
        )
      )}

      {!splitting && remaining > 0 && (
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => setSplitting(true)}
        >
          <Icon name="plus" size={16} /> Agregar otro pago (pago mixto)
        </button>
      )}

      {remaining === 0 && partials.length > 0 && (
        <p className="field__hint">Los pagos cubren el total. Confirma para registrar la venta.</p>
      )}

      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}

/** Aparta una parte del total con otra forma de pago. */
function SplitForm({
  methods,
  max,
  creditAvailable,
  onCancel,
  onAdd,
}: {
  methods: PaymentMethod[];
  max: number;
  creditAvailable: number;
  onCancel: () => void;
  onAdd: (payment: SalePaymentInput) => void;
}) {
  const nonCash = methods.filter((m) => !m.affectsCash);
  const [code, setCode] = useState(nonCash[0]?.code ?? 'CARD_DEBIT');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const method = methods.find((m) => m.code === code)!;
  const value = Number(amount.replace(',', '.'));

  const invalid =
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max + 0.001 ||
    (method.requiresReference && !reference.trim()) ||
    (method.kind === 'CREDIT' && value > creditAvailable + 0.001);

  return (
    <div className="pay__split">
      <div className="pay__split-grid">
        <Field label="Forma de pago" htmlFor="split-method">
          <Select id="split-method" value={code} onChange={(e) => setCode(e.target.value)}>
            {nonCash.map((m) => (
              <option key={m.code} value={m.code}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Importe (máx. ${formatMoney(max)})`} htmlFor="split-amount">
          <TextInput
            id="split-amount"
            autoFocus
            inputMode="decimal"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
          />
        </Field>
      </div>
      {method.requiresReference && (
        <Field
          label={method.kind === 'STORE_CREDIT' ? 'Folio de la nota' : 'Referencia'}
          htmlFor="split-ref"
        >
          <TextInput id="split-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      <div className="pay__split-actions">
        <Button variant="subtle" onClick={onCancel}>
          Volver
        </Button>
        <Button
          variant="primary"
          disabled={invalid}
          onClick={() =>
            onAdd({
              methodCode: code,
              amount: value.toFixed(2),
              ...(reference.trim() ? { reference: reference.trim().toUpperCase() } : {}),
            })
          }
        >
          Apartar {Number.isFinite(value) && value > 0 ? formatMoney(value) : ''}
        </Button>
      </div>
    </div>
  );
}
