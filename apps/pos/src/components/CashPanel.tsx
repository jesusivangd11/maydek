import { useState } from 'react';
import { ApiError, api, type CashSession } from '../lib/api';
import { getPaperWidth, setPaperWidth, type PaperWidth } from './PrintTicket';
import { formatDateTime, formatMoney, formatTime } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  PageHeader,
  Segmented,
  StatCard,
  TextInput,
} from '../ui';

/**
 * Caja.
 *
 * El efectivo ESPERADO lo calcula el servidor y aquí es de solo lectura, a
 * propósito: si el cajero pudiera teclearlo, el arqueo no detectaría nada.
 * Lo que sí se captura es lo CONTADO, y la diferencia aparece antes de
 * confirmar el cierre para que nadie cierre a ciegas.
 *
 * El reparto de la pantalla separa lo que se CONSULTA de lo que se OPERA: a
 * la izquierda el turno —formas de pago y movimientos—, a la derecha el
 * arqueo. Antes era una columna estrecha centrada que dejaba media pantalla
 * en blanco y obligaba a bajar para encontrar el dato del cierre.
 */
export function CashPanel({
  session,
  canClose,
  onChanged,
}: {
  session: CashSession | null;
  canClose: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openingFloat, setOpeningFloat] = useState('500.00');
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [movementAmount, setMovementAmount] = useState('');
  const [movementReason, setMovementReason] = useState('');
  const [movementType, setMovementType] = useState<
    'CASH_IN' | 'CASH_OUT' | 'WITHDRAWAL' | 'EXPENSE'
  >('CASH_OUT');
  const [paper, setPaper] = useState<PaperWidth>(getPaperWidth());

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      setCounted('');
      setReason('');
      setMovementAmount('');
      setMovementReason('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo completar la operación');
    } finally {
      setBusy(false);
    }
  }

  // ── Caja cerrada: solo se puede abrir ──
  if (!session) {
    return (
      /* Aquí no hay nada más que hacer que abrir el turno, así que la tarjeta
         ocupa el centro de la pantalla en lugar de quedarse arrinconada arriba
         a la izquierda dejando tres cuartos en blanco. */
      <div className="cash-closed">
        <div className="cash-closed__panel">
          <PageHeader
            title="Caja"
            badge={<Badge tone="danger">Cerrada</Badge>}
            subtitle="Mientras no haya una sesión abierta no se puede cobrar en efectivo."
          />

          <Card title="Abrir turno">
            <div className="stack">
              <p className="muted">
                El fondo inicial es el dinero con el que arranca el turno. Es la base contra
                la que se compara el arqueo al cerrar.
              </p>

              <Field label="Fondo inicial" htmlFor="float">
                <TextInput
                  id="float"
                  amount
                  inputMode="decimal"
                  value={openingFloat}
                  disabled={busy}
                  onChange={(event) =>
                    setOpeningFloat(event.target.value.replace(/[^\d.]/g, ''))
                  }
                />
              </Field>

              {/* Los fondos habituales, igual que los importes redondos del
                  cobro: casi siempre es una de estas cuatro cifras. */}
              <div className="quick-row">
                {OPENING_FLOATS.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    className="quick"
                    disabled={busy}
                    onClick={() => setOpeningFloat(amount.toFixed(2))}
                  >
                    {formatMoney(amount)}
                  </button>
                ))}
              </div>

              {error && <Alert>{error}</Alert>}

              <Button
                variant="primary"
                size="xl"
                disabled={busy || !openingFloat}
                onClick={() => run(() => api.openCashSession(Number(openingFloat).toFixed(2)))}
              >
                {busy ? 'Abriendo…' : 'Abrir caja'}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // ── Caja abierta: corte X en vivo ──
  const expected = Number(session.expectedCash);
  const countedNumber = Number(counted.replace(',', '.'));
  const difference = counted === '' ? null : countedNumber - expected;
  const balanced = difference !== null && Math.abs(difference) < 0.005;

  return (
    <div className="page">
      <PageHeader
        title={session.terminal.name}
        badge={<Badge tone="positive">Abierta</Badge>}
        subtitle={
          <>
            <span className="mono">{session.folio}</span> · {session.branch.name} · abierta a
            las {formatTime(session.openedAt)} por {session.openedBy.name}
          </>
        }
      />

      {/* Los cuatro números del turno, en fila y en grande: es lo que se
          consulta de reojo veinte veces al día. */}
      <div className="stat-grid" style={{ marginBottom: 'var(--s-6)' }}>
        <StatCard label="Fondo inicial" value={formatMoney(session.openingFloat)} />
        <StatCard label="Ventas del turno" value={session.sales.count} />
        <StatCard label="Importe vendido" value={formatMoney(session.sales.total)} />
        <StatCard label="Ticket promedio" value={formatMoney(session.sales.average)} />
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--s-5)' }}>
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="cash">
        {/* ── Lo que se consulta ── */}
        <div className="cash__main">
          <Card title="Formas de pago" flush>
            {session.totalsByMethod.length === 0 ? (
              <EmptyState
                icon="cash"
                title="Todavía no se ha cobrado nada"
                text="Los importes por forma de pago aparecen aquí en cuanto se registre la primera venta del turno."
              />
            ) : (
              <div className="methods">
                {session.totalsByMethod.map((method) => (
                  <div key={method.code} className="method-row">
                    <span className="method-row__name">
                      {method.name}
                      {method.affectsCash ? (
                        <Badge tone="positive">Entra al cajón</Badge>
                      ) : (
                        <Badge dot={false}>No entra al cajón</Badge>
                      )}
                    </span>
                    <span className="method-row__amount">{formatMoney(method.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Movimientos de caja" flush>
            {session.movements.length === 0 ? (
              <EmptyState
                icon="chart"
                title="Sin movimientos"
                text="Aquí se registran el fondo inicial, las ventas y cualquier entrada o salida de efectivo del turno."
              />
            ) : (
              <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Hora</th>
                      <th>Concepto</th>
                      <th>Quién</th>
                      <th className="table__money">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.movements.map((movement) => (
                      <tr key={movement.id}>
                        <td className="tnum">{formatTime(movement.occurredAt)}</td>
                        <td>
                          {MOVEMENT_LABELS[movement.type] ?? movement.type}
                          {movement.reference && (
                            <span className="mono subtle text-sm"> {movement.reference}</span>
                          )}
                          {/* El asiento de apertura trae como motivo su propia
                              etiqueta, y repetirla daba "Fondo inicial · Fondo
                              inicial". Solo se añade cuando aporta algo. */}
                          {movement.reason &&
                            movement.reason !== MOVEMENT_LABELS[movement.type] && (
                              <span className="subtle"> · {movement.reason}</span>
                            )}
                        </td>
                        <td className="muted">{movement.user.name}</td>
                        <td
                          className="table__money"
                          style={
                            Number(movement.amount) < 0 ? { color: 'var(--danger)' } : undefined
                          }
                        >
                          {formatMoney(movement.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* ── Lo que se opera ── */}
        <div className="cash__side">
          {/* El dato del corte. Es lo que el cajero compara contra lo que
              cuenta en el cajón, así que es el número más grande de la
              pantalla y el único con fondo de acento. */}
          <StatCard
            emphasis
            label="Efectivo esperado"
            value={formatMoney(session.expectedCash)}
            foot="Fondo inicial + cobros en efectivo − salidas"
          />

          <Card title="Cerrar caja">
            <div className="stack">
              <p className="muted text-sm">
                Cuenta el efectivo del cajón y captúralo. El sistema compara contra lo
                esperado antes de cerrar.
              </p>

              <Field label="Efectivo contado" htmlFor="counted">
                <TextInput
                  id="counted"
                  amount
                  inputMode="decimal"
                  value={counted}
                  placeholder="0.00"
                  disabled={busy || !canClose}
                  onChange={(event) => setCounted(event.target.value.replace(/[^\d.,]/g, ''))}
                />
              </Field>

              {difference !== null && (
                <div
                  className={
                    balanced
                      ? 'change change--positive cash__difference'
                      : 'change change--danger cash__difference'
                  }
                >
                  <span className="change__label">
                    {balanced ? 'Cuadra' : difference > 0 ? 'Sobrante' : 'Faltante'}
                  </span>
                  <strong className="change__amount">
                    {formatMoney(Math.abs(difference))}
                  </strong>
                </div>
              )}

              {difference !== null && !balanced && (
                <Field
                  label="Explica la diferencia"
                  htmlFor="reason"
                  hint="Obligatorio cuando el arqueo no cuadra: queda en la auditoría del turno."
                >
                  <TextInput
                    id="reason"
                    value={reason}
                    disabled={busy}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
              )}

              {!canClose && <Alert tone="warning">No tienes permiso para cerrar la caja.</Alert>}

              <Button
                variant="danger"
                size="xl"
                disabled={
                  busy ||
                  !canClose ||
                  counted === '' ||
                  (Math.abs(difference ?? 0) >= 0.005 && reason.trim() === '')
                }
                onClick={() =>
                  run(() =>
                    api.closeCashSession({
                      cashSessionId: session.id,
                      countedCash: countedNumber.toFixed(2),
                      ...(reason.trim() ? { differenceReason: reason.trim() } : {}),
                    }),
                  )
                }
              >
                {busy ? 'Cerrando…' : 'Cerrar caja'}
              </Button>
            </div>
          </Card>

          <Card title="Entrada o salida de efectivo">
            <div className="stack">
              <Segmented
                block
                label="Tipo de movimiento"
                value={movementType}
                disabled={busy}
                options={[
                  { value: 'CASH_IN', label: 'Entrada' },
                  { value: 'CASH_OUT', label: 'Salida' },
                  { value: 'EXPENSE', label: 'Gasto' },
                  { value: 'WITHDRAWAL', label: 'Retiro' },
                ]}
                onChange={setMovementType}
              />

              <Field label="Importe" htmlFor="mov-amount">
                <TextInput
                  id="mov-amount"
                  inputMode="decimal"
                  value={movementAmount}
                  disabled={busy}
                  onChange={(event) =>
                    setMovementAmount(event.target.value.replace(/[^\d.]/g, ''))
                  }
                />
              </Field>

              <Field label="Motivo" htmlFor="mov-reason">
                <TextInput
                  id="mov-reason"
                  value={movementReason}
                  placeholder="Pago de mensajería, cambio de billete…"
                  disabled={busy}
                  onChange={(event) => setMovementReason(event.target.value)}
                />
              </Field>

              <Button
                variant="secondary"
                block
                disabled={busy || !movementAmount || !movementReason.trim()}
                onClick={() =>
                  run(() =>
                    api.createCashMovement({
                      cashSessionId: session.id,
                      type: movementType,
                      amount: Number(movementAmount).toFixed(2),
                      reason: movementReason.trim(),
                    }),
                  )
                }
              >
                Registrar movimiento
              </Button>
            </div>
          </Card>

          <Card title="Impresora de tickets">
            <div className="stack">
              <Segmented
                block
                label="Ancho del papel"
                value={paper}
                options={[
                  { value: '80', label: 'Papel de 80 mm' },
                  { value: '58', label: 'Papel de 58 mm' },
                ]}
                onChange={(next) => {
                  setPaper(next);
                  setPaperWidth(next);
                }}
              />
              <p className="field__hint">
                Se recuerda en esta computadora. Instala la impresora térmica como impresora del
                sistema y márcala como predeterminada.
              </p>
            </div>
          </Card>

          <p className="field__hint">Abierta desde {formatDateTime(session.openedAt)}</p>
        </div>
      </div>
    </div>
  );
}

/** Fondos iniciales habituales de un turno. */
const OPENING_FLOATS = [200, 500, 1000, 1500];

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: 'Fondo inicial',
  SALE: 'Venta',
  RETURN_REFUND: 'Devolución',
  CASH_IN: 'Entrada de efectivo',
  CASH_OUT: 'Salida de efectivo',
  WITHDRAWAL: 'Retiro',
  EXPENSE: 'Gasto',
  CLOSING: 'Arqueo de cierre',
  ADJUSTMENT: 'Ajuste',
};
