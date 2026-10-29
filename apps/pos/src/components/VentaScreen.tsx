import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type CatalogItem,
  type CommonItem,
  type SaleDetail,
  type SalePaymentInput,
} from '../lib/api';
import {
  addCommonItem,
  addToCart,
  applyGlobalDiscount,
  cartTotals,
  lineTotal,
  normalizeLines,
  removeLine,
  reprice,
  setQty,
  syncAvailability,
  toSaleLines,
  type CartLine,
} from '../lib/cart';
import { formatMoney, formatQty, toNumber } from '../lib/format';
import { useStoreSettings } from '../lib/settings';
import { Alert, Button, Field, Modal, TextInput } from '../ui';
import { PaymentDialog } from './PaymentDialog';
import { CustomerPicker, DiscountDialog, type PickedCustomer } from './PosDialogs';
import { PrintTicket, printTicket } from './PrintTicket';

/**
 * VENTA.
 *
 * La pantalla de mostrador, al estilo de los puntos de venta que el cajero ya
 * conoce: un campo «Código del producto» donde todo empieza, una tabla con lo
 * que lleva el ticket y el total grande abajo a la derecha. Todo se hace con
 * el teclado:
 *
 *   ENTER   agrega el código           F10  buscar por nombre
 *   INS     varios (cantidad)          F11  mayoreo (un toque)
 *   CTRL+P  artículo común             F7   entrada de efectivo
 *   DEL     borrar artículo            F8   salida de efectivo
 *   F5      cambiar de ticket          F6   dejar pendiente y abrir otro
 *   F12     cobrar                     ↑ ↓  elegir renglón · + − cantidad
 *
 * Varios tickets abiertos a la vez (el cliente que fue por otra cosa no
 * detiene la fila). Viven en este equipo, así que un apagón no los pierde.
 *
 * La existencia no detiene la venta: si el sistema dice 0 y el artículo está
 * en el mostrador, se vende y el inventario queda en negativo.
 */

interface OpenTicket {
  number: number;
  lines: CartLine[];
  customer: PickedCustomer | null;
  wholesale: boolean;
}

interface LastSale {
  sale: SaleDetail;
  cashReceived: string | null;
}

type Dialog =
  | { kind: 'varios'; editKey?: string }
  | { kind: 'comun' }
  | { kind: 'buscar'; term: string; qty: number }
  | { kind: 'cash'; type: 'CASH_IN' | 'CASH_OUT' }
  | { kind: 'remove'; key: string }
  | { kind: 'delete-ticket' }
  | { kind: 'customer' }
  | { kind: 'discount' }
  | null;

const TICKETS_KEY = 'pos.tickets.v2';

function loadTickets(): OpenTicket[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TICKETS_KEY) ?? '[]') as OpenTicket[];
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((t) => ({ ...t, lines: normalizeLines(t.lines) }));
    }
  } catch {
    // Almacenamiento dañado o bloqueado: se arranca con un ticket limpio.
  }
  return [newTicket([])];
}

function saveTickets(tickets: OpenTicket[]): void {
  try {
    localStorage.setItem(TICKETS_KEY, JSON.stringify(tickets));
  } catch {
    // Sin almacenamiento solo se pierde la recuperación tras un apagón.
  }
}

/**
 * El número de un ticket abierto es el primero libre (1, 2, 3…), no un folio:
 * sirve para que el cajero diga «el ticket 2 es de la señora». El folio de
 * verdad lo pone el servidor al cobrar.
 */
function newTicket(open: OpenTicket[]): OpenTicket {
  const used = new Set(open.map((t) => t.number));
  let number = 1;
  while (used.has(number)) number++;
  return { number, lines: [], customer: null, wholesale: false };
}

/** Lo que queda al cerrar un ticket; si solo sobra uno vacío, vuelve a ser el 1. */
function closeTicket(all: OpenTicket[], index: number): OpenTicket[] {
  const rest = all.filter((_, i) => i !== Math.min(index, all.length - 1));
  if (rest.length === 0 || (rest.length === 1 && rest[0]!.lines.length === 0)) return [newTicket([])];
  return rest;
}

export function VentaScreen({
  permissions,
  cashSessionId,
  active,
  onSaleCompleted,
  onShowSales,
}: {
  permissions: string[];
  cashSessionId: string | null;
  /** Falso mientras otro módulo ocupa la ventana: las teclas no son de aquí. */
  active: boolean;
  onSaleCompleted: () => void;
  onShowSales: () => void;
}) {
  const settings = useStoreSettings();
  const [tickets, setTickets] = useState<OpenTicket[]>(loadTickets);
  const [current, setCurrent] = useState(0);
  const [code, setCode] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [looking, setLooking] = useState(false);

  const [charging, setCharging] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  const [printing, setPrinting] = useState<{ sale: SaleDetail; cashReceived: string | null; reprint: boolean } | null>(null);
  const commonRef = useRef<CommonItem | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);
  const ticketKey = useRef<string | null>(null);
  const submitting = useRef(false);

  const ticket = tickets[Math.min(current, tickets.length - 1)]!;
  const lines = ticket.lines;
  const totals = cartTotals(lines);

  const canDiscount = permissions.includes('sale.discount.apply');
  const canCreateCustomer = permissions.includes('customer.create');

  useEffect(() => saveTickets(tickets), [tickets]);

  useEffect(() => {
    if (!notice) return;
    const handle = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(handle);
  }, [notice]);

  // Imprimir cuando el ticket ya está montado en el DOM.
  useEffect(() => {
    if (!printing) return;
    const handle = setTimeout(() => {
      const copies = Math.max(1, settings['ticket.copies']);
      for (let i = 0; i < copies; i++) printTicket();
    }, 50);
    return () => clearTimeout(handle);
  }, [printing, settings]);

  const focusCode = useCallback(() => {
    requestAnimationFrame(() => {
      codeRef.current?.focus();
      codeRef.current?.select();
    });
  }, []);

  useEffect(() => {
    if (active && !dialog && !charging) focusCode();
  }, [active, dialog, charging, focusCode]);

  /** Cambia el ticket actual con una función sobre sus datos. */
  const updateTicket = useCallback(
    (fn: (t: OpenTicket) => OpenTicket) => {
      setTickets((all) => all.map((t, i) => (i === Math.min(current, all.length - 1) ? fn(t) : t)));
    },
    [current],
  );

  const setLines = useCallback(
    (fn: (lines: CartLine[]) => CartLine[]) => updateTicket((t) => ({ ...t, lines: fn(t.lines) })),
    [updateTicket],
  );

  const say = (text: string, tone: 'ok' | 'error' = 'ok') => setNotice({ text, tone });

  // ── Agregar por código ──
  const lookup = useCallback(
    async (raw: string, qty: number) => {
      const term = raw.trim();
      if (!term) return;
      setLooking(true);
      try {
        const response = await api.posSearch({
          q: term,
          limit: 50,
          wholesale: ticket.wholesale || undefined,
          ...(ticket.customer ? { customerId: ticket.customer.id } : {}),
        });
        const exact =
          (response.exactBarcode && response.data[0]) ||
          response.data.find((i) => i.sku.toLowerCase() === term.toLowerCase()) ||
          (response.data.length === 1 ? response.data[0] : undefined);

        if (exact) {
          setLines((current) => syncAvailability(addToCart(current, exact, qty), [exact]));
          setSelected(exact.variantId);
          setCode('');
          if (exact.trackStock && toNumber(exact.qtyAvailable) - qty < 0) {
            say(`«${exact.name}» queda con existencia en negativo.`);
          }
        } else if (response.data.length > 1) {
          setDialog({ kind: 'buscar', term, qty });
        } else {
          say(`No existe un producto con el código «${term}».`, 'error');
        }
      } catch (error) {
        say(error instanceof ApiError ? error.message : 'No se pudo consultar el catálogo', 'error');
      } finally {
        setLooking(false);
      }
    },
    [ticket.wholesale, ticket.customer, setLines],
  );

  const addItem = useCallback(
    (item: CatalogItem, qty: number) => {
      setLines((current) => syncAvailability(addToCart(current, item, qty), [item]));
      setSelected(item.variantId);
      setCode('');
      setDialog(null);
    },
    [setLines],
  );

  // ── Mayoreo y cliente: vuelven a preciar el ticket ──
  const repriceTicket = useCallback(
    async (wholesale: boolean, customer: PickedCustomer | null) => {
      const catalogLines = lines.filter((l) => !l.common);
      if (catalogLines.length === 0) return;
      const fresh = await Promise.all(
        catalogLines.map((line) =>
          api
            .posSearch({
              q: line.sku,
              limit: 10,
              wholesale: wholesale || undefined,
              ...(customer ? { customerId: customer.id } : {}),
            })
            .then((r) => r.data.find((i) => i.variantId === line.variantId) ?? null)
            .catch(() => null),
        ),
      );
      setLines((current) => reprice(current, fresh.filter((f): f is CatalogItem => f !== null)));
    },
    [lines, setLines],
  );

  const toggleWholesale = useCallback(() => {
    const next = !ticket.wholesale;
    updateTicket((t) => ({ ...t, wholesale: next }));
    void repriceTicket(next, ticket.customer);
    say(next ? 'Mayoreo activado: precios de mayoreo en este ticket.' : 'Mayoreo desactivado.');
  }, [ticket.wholesale, ticket.customer, updateTicket, repriceTicket]);

  // ── Quitar artículos ──
  const askRemove = useCallback(
    (key: string | null) => {
      if (!key) return;
      if (settings['sales.confirmRemove'] || lines.length === 1) {
        setDialog({ kind: 'remove', key });
      } else {
        setLines((current) => removeLine(current, key));
      }
    },
    [settings, lines.length, setLines],
  );

  const doRemove = (key: string) => {
    const index = lines.findIndex((l) => l.key === key);
    setLines((current) => removeLine(current, key));
    const next = lines[index + 1] ?? lines[index - 1];
    setSelected(next && next.key !== key ? next.key : null);
    setDialog(null);
  };

  // ── Tickets ──
  const switchTicket = () => {
    if (tickets.length < 2) {
      say('Solo hay un ticket abierto. Con F6 dejas éste pendiente y abres otro.');
      return;
    }
    setCurrent((c) => (c + 1) % tickets.length);
    setSelected(null);
    ticketKey.current = null;
  };

  const pendingTicket = () => {
    if (lines.length === 0) {
      say('El ticket está vacío: no hay nada que dejar pendiente.');
      return;
    }
    setTickets((all) => [...all, newTicket(all)]);
    setCurrent(tickets.length);
    setSelected(null);
    ticketKey.current = null;
    say(`Ticket ${ticket.number} quedó pendiente. Vuelve a él con F5.`);
  };

  const deleteTicket = () => {
    setTickets((all) => closeTicket(all, current));
    setCurrent(0);
    setSelected(null);
    ticketKey.current = null;
    setDialog(null);
  };

  // ── Cobrar ──
  const startCharging = () => {
    if (lines.length === 0) return;
    if (!cashSessionId) {
      say('La caja está cerrada. Ábrela en Corte para poder cobrar.', 'error');
      return;
    }
    if (ticketKey.current === null) {
      ticketKey.current = `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    setPayError(null);
    setCharging(true);
  };

  async function confirmPayment(payments: SalePaymentInput[], cashReceived?: string) {
    if (submitting.current) return;
    submitting.current = true;
    setPaying(true);
    setPayError(null);

    try {
      const sale = await api.createSale({
        items: toSaleLines(lines),
        payments,
        ...(ticket.customer ? { customerId: ticket.customer.id } : {}),
        ...(cashReceived ? { cashReceived } : {}),
        ...(ticket.wholesale ? { wholesale: true } : {}),
        idempotencyKey: ticketKey.current ?? undefined,
      });

      setLastSale({ sale, cashReceived: cashReceived ?? null });
      if (settings['ticket.autoPrint']) {
        setPrinting({ sale, cashReceived: cashReceived ?? null, reprint: false });
      }
      // El ticket cobrado se cierra; si era el único, se abre uno nuevo.
      setTickets((all) => closeTicket(all, current));
      setCurrent(0);
      setSelected(null);
      setCharging(false);
      ticketKey.current = null;
      onSaleCompleted();
    } catch (error) {
      setPayError(
        error instanceof ApiError
          ? describeSaleError(error)
          : 'No se pudo conectar con el servidor. Vuelve a intentar: si la venta ya se había registrado, el sistema la reconocerá y no cobrará dos veces.',
      );
    } finally {
      submitting.current = false;
      setPaying(false);
    }
  }

  const reprintLast = () => {
    if (!lastSale) {
      say('Todavía no hay una venta en esta sesión para reimprimir.');
      return;
    }
    setPrinting({ ...lastSale, reprint: true });
  };

  // ── Teclado ──
  const keyState = { lines, selected, dialog, charging, active, code };
  const keyRef = useRef(keyState);
  keyRef.current = keyState;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const s = keyRef.current;
      if (!s.active || s.dialog || s.charging) return;
      const key = event.key;
      const ctrl = event.ctrlKey || event.metaKey;

      if (key === 'Insert') {
        event.preventDefault();
        setDialog({ kind: 'varios' });
      } else if (ctrl && (key === 'p' || key === 'P')) {
        event.preventDefault();
        setDialog({ kind: 'comun' });
      } else if (key === 'F10') {
        event.preventDefault();
        setDialog({ kind: 'buscar', term: s.code, qty: 1 });
      } else if (key === 'F11') {
        event.preventDefault();
        toggleWholesale();
      } else if (key === 'F7') {
        event.preventDefault();
        setDialog({ kind: 'cash', type: 'CASH_IN' });
      } else if (key === 'F8') {
        event.preventDefault();
        setDialog({ kind: 'cash', type: 'CASH_OUT' });
      } else if (key === 'Delete' && !s.code) {
        event.preventDefault();
        askRemove(s.selected ?? s.lines[s.lines.length - 1]?.key ?? null);
      } else if (key === 'F5') {
        event.preventDefault();
        switchTicket();
      } else if (key === 'F6') {
        event.preventDefault();
        pendingTicket();
      } else if (key === 'F12') {
        event.preventDefault();
        startCharging();
      } else if (key === 'ArrowDown' || key === 'ArrowUp') {
        if (s.lines.length === 0) return;
        event.preventDefault();
        const index = s.lines.findIndex((l) => l.key === s.selected);
        const next =
          key === 'ArrowDown'
            ? Math.min(s.lines.length - 1, index + 1)
            : Math.max(0, index < 0 ? s.lines.length - 1 : index - 1);
        setSelected(s.lines[next]!.key);
      } else if ((key === '+' || key === '-') && !s.code && s.selected) {
        event.preventDefault();
        const line = s.lines.find((l) => l.key === s.selected);
        if (!line) return;
        if (key === '-' && line.qty <= 1) askRemove(line.key);
        else setLines((current) => setQty(current, line.key, line.qty + (key === '+' ? 1 : -1)));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const lineOverstock = (line: CartLine) => line.trackStock && !line.common && line.available - line.qty < 0;
  const itemCount = useMemo(() => lines.reduce((acc, l) => acc + l.qty, 0), [lines]);

  return (
    <div className="venta">
      {/* ── Encabezado y captura ── */}
      <div className="venta__head">
        <h1 className="venta__title">
          VENTA <span className="venta__dash">—</span> Ticket {ticket.number}
        </h1>
        <div className="venta__flags">
          {ticket.wholesale && (
            <span className="flag flag--accent" title="Precios de mayoreo en este ticket (F11)">
              Mayoreo activo
            </span>
          )}
          {ticket.customer && (
            <button
              type="button"
              className="flag flag--info"
              onClick={() => setDialog({ kind: 'customer' })}
              title="Cambiar cliente"
            >
              Cliente: {ticket.customer.name}
            </button>
          )}
          {!cashSessionId && <span className="flag flag--danger">Caja cerrada</span>}
        </div>
      </div>

      <form
        className="venta__capture"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup(code, 1);
        }}
      >
        <label className="venta__label" htmlFor="codigo">
          Código del producto:
        </label>
        <input
          id="codigo"
          ref={codeRef}
          className="venta__code"
          value={code}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setCode('');
          }}
        />
        <Button type="submit" variant="primary" disabled={looking} shortcut="ENTER">
          Agregar producto
        </Button>
      </form>

      <div className="venta__tools" role="toolbar" aria-label="Acciones del ticket">
        <ToolButton k="INS" label="Varios" onClick={() => setDialog({ kind: 'varios' })} />
        <ToolButton k="CTRL+P" label="Art. común" onClick={() => setDialog({ kind: 'comun' })} />
        <ToolButton k="F10" label="Buscar" onClick={() => setDialog({ kind: 'buscar', term: code, qty: 1 })} />
        <ToolButton k="F11" label="Mayoreo" pressed={ticket.wholesale} onClick={toggleWholesale} />
        <ToolButton k="F7" label="Entradas" onClick={() => setDialog({ kind: 'cash', type: 'CASH_IN' })} />
        <ToolButton k="F8" label="Salidas" onClick={() => setDialog({ kind: 'cash', type: 'CASH_OUT' })} />
        <ToolButton
          k="DEL"
          label="Borrar art."
          disabled={lines.length === 0}
          onClick={() => askRemove(selected ?? lines[lines.length - 1]?.key ?? null)}
        />
        <span className="venta__tools-gap" />
        <ToolButton label="Cliente" onClick={() => setDialog({ kind: 'customer' })} />
        {canDiscount && (
          <ToolButton label="Descuento" disabled={lines.length === 0} onClick={() => setDialog({ kind: 'discount' })} />
        )}
      </div>

      {/* ── Tickets abiertos ── */}
      <div className="venta__tabs" role="tablist" aria-label="Tickets abiertos">
        {tickets.map((t, i) => (
          <button
            key={t.number}
            type="button"
            role="tab"
            aria-selected={i === Math.min(current, tickets.length - 1)}
            className="venta__tab"
            onClick={() => {
              setCurrent(i);
              setSelected(null);
              ticketKey.current = null;
            }}
          >
            Ticket {t.number}
            {t.lines.length > 0 && <span className="venta__tab-total">{formatMoney(cartTotals(t.lines).total)}</span>}
          </button>
        ))}
        <span className="venta__tabs-note">
          {tickets.length > 1 ? `${tickets.length - 1} cuenta(s) pendiente(s) · F5 para cambiar` : 'F6 deja la cuenta pendiente'}
        </span>
      </div>

      {notice && (
        <p className={`venta__notice venta__notice--${notice.tone}`} role="status">
          {notice.text}
        </p>
      )}

      {/* ── Renglones ── */}
      <div className="venta__table-wrap">
        <table className="venta__table">
          <thead>
            <tr>
              <th>Código de barras</th>
              <th>Descripción del producto</th>
              <th className="num">Precio venta</th>
              <th className="num">Cant.</th>
              <th className="num">Importe</th>
              <th className="num">Existencia</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.key}
                aria-selected={line.key === selected}
                onClick={() => setSelected(line.key)}
                onDoubleClick={() => setDialog({ kind: 'varios', editKey: line.key })}
              >
                <td className="mono">{line.common ? '—' : (line.barcode ?? line.sku)}</td>
                <td>
                  {line.name}
                  {line.common && <span className="venta__tag">Común</span>}
                  {line.discount > 0 && (
                    <span className="venta__sub">Descuento −{formatMoney(line.discount)}</span>
                  )}
                </td>
                <td className="num">{formatMoney(line.unitPrice)}</td>
                <td className="num">
                  <button
                    type="button"
                    className="venta__qty"
                    title="Cambiar cantidad"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelected(line.key);
                      setDialog({ kind: 'varios', editKey: line.key });
                    }}
                  >
                    {formatQty(line.qty)}
                  </button>
                </td>
                <td className="num strong">{formatMoney(lineTotal(line))}</td>
                <td className={`num ${lineOverstock(line) ? 'danger' : ''}`}>
                  {line.common || !line.trackStock ? '—' : formatQty(line.available - line.qty)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines.length === 0 && (
          <p className="venta__empty">
            Escanea un código o escríbelo y presiona ENTER. F10 busca por nombre; CTRL+P vende un artículo
            común.
          </p>
        )}
      </div>

      {/* ── Pie: totales y acciones ── */}
      <div className="venta__foot">
        <div className="venta__foot-left">
          <p className="venta__count">
            <strong>{formatQty(itemCount)}</strong> productos en la venta actual
          </p>
          <div className="venta__foot-actions">
            <ToolButton k="F5" label="Cambiar" onClick={switchTicket} />
            <ToolButton k="F6" label="Pendiente" onClick={pendingTicket} />
            <ToolButton
              label="Eliminar"
              onClick={() => (lines.length > 0 ? setDialog({ kind: 'delete-ticket' }) : deleteTicket())}
            />
          </div>
          <div className="venta__last">
            {lastSale ? (
              <>
                <span>
                  Total: <strong>{formatMoney(lastSale.sale.total)}</strong>
                </span>
                <span>
                  Pagó con: <strong>{formatMoney(lastSale.cashReceived ?? lastSale.sale.paidTotal)}</strong>
                </span>
                <span>
                  Cambio: <strong>{formatMoney(lastSale.sale.changeGiven)}</strong>
                </span>
              </>
            ) : (
              <span className="subtle">Aquí aparece el cambio de la última venta.</span>
            )}
          </div>
          <div className="venta__foot-links">
            <button type="button" className="linkish" onClick={reprintLast}>
              Reimprimir último ticket
            </button>
            <button type="button" className="linkish" onClick={onShowSales}>
              Ventas del día y devoluciones
            </button>
          </div>
        </div>

        <div className="venta__charge">
          <button
            type="button"
            className="venta__pay"
            disabled={lines.length === 0}
            onClick={startCharging}
          >
            <kbd>F12</kbd> Cobrar
          </button>
          <p className="venta__total" aria-live="polite">
            {formatMoney(totals.total)}
          </p>
          {totals.discount > 0 && (
            <p className="venta__saving">Ahorro {formatMoney(totals.discount)}</p>
          )}
        </div>
      </div>

      {/* ── Diálogos ── */}
      {charging && (
        <PaymentDialog
          total={totals.total}
          busy={paying}
          error={payError}
          customer={ticket.customer}
          onCancel={() => {
            setCharging(false);
            setPayError(null);
          }}
          onConfirm={confirmPayment}
        />
      )}

      {dialog?.kind === 'varios' && (
        <VariosDialog
          editing={lines.find((l) => l.key === dialog.editKey) ?? null}
          initialCode={code}
          onClose={() => setDialog(null)}
          onSetQty={(key, qty) => {
            if (qty <= 0) {
              setDialog(null);
              askRemove(key);
              return;
            }
            setLines((current) => setQty(current, key, qty));
            setDialog(null);
          }}
          onAdd={(qty, productCode) => {
            setDialog(null);
            void lookup(productCode, qty);
          }}
        />
      )}

      {dialog?.kind === 'comun' && (
        <CommonDialog
          onClose={() => setDialog(null)}
          onAdd={async (input) => {
            try {
              commonRef.current ??= await api.commonItem();
              const common = commonRef.current;
              setLines((current) => addCommonItem(current, common, input));
              setDialog(null);
            } catch (error) {
              say(error instanceof ApiError ? error.message : 'No se pudo agregar el artículo común', 'error');
            }
          }}
        />
      )}

      {dialog?.kind === 'buscar' && (
        <SearchDialog
          initialTerm={dialog.term}
          wholesale={ticket.wholesale}
          customerId={ticket.customer?.id}
          onClose={() => setDialog(null)}
          onPick={(item) => addItem(item, dialog.qty)}
        />
      )}

      {dialog?.kind === 'cash' && (
        <CashMovementDialog
          type={dialog.type}
          cashSessionId={cashSessionId}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            say(text);
            onSaleCompleted();
          }}
        />
      )}

      {dialog?.kind === 'remove' &&
        (() => {
          const line = lines.find((l) => l.key === dialog.key);
          if (!line) return null;
          return (
            <ConfirmDialog
              title="Quitar artículo"
              message={
                lines.length === 1
                  ? `«${line.name}» es el último artículo del ticket. ¿Quitarlo y dejar el ticket vacío?`
                  : `¿Quitar «${line.name}» del ticket?`
              }
              confirmLabel="Sí, quitar"
              onCancel={() => setDialog(null)}
              onConfirm={() => doRemove(line.key)}
            />
          );
        })()}

      {dialog?.kind === 'delete-ticket' && (
        <ConfirmDialog
          title={`Eliminar ticket ${ticket.number}`}
          message={`Se descartan ${lines.length} artículo(s) por ${formatMoney(totals.total)}. Nada se cobró, así que no queda registro.`}
          confirmLabel="Sí, eliminar"
          onCancel={() => setDialog(null)}
          onConfirm={deleteTicket}
        />
      )}

      {dialog?.kind === 'customer' && (
        <CustomerPicker
          canCreate={canCreateCustomer}
          onClose={() => setDialog(null)}
          onPick={(customer) => {
            updateTicket((t) => ({ ...t, customer }));
            void repriceTicket(ticket.wholesale, customer);
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === 'discount' && (
        <DiscountDialog
          title="Descuento a todo el ticket"
          base={totals.gross}
          current={totals.discount}
          onClose={() => setDialog(null)}
          onApply={(amount) => {
            setLines((current) => applyGlobalDiscount(current, amount));
            setDialog(null);
          }}
        />
      )}

      {printing && (
        <PrintTicket sale={printing.sale} cashReceived={printing.cashReceived} reprint={printing.reprint} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════

function ToolButton({
  k,
  label,
  pressed,
  disabled,
  onClick,
}: {
  k?: string;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="tool"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {k && <kbd className="tool__key">{k}</kbd>}
      <span>{label}</span>
    </button>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      label={title}
      head={<h2 className="modal__title">{title}</h2>}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      foot={
        <>
          <Button onClick={onCancel} shortcut="ESC">
            No
          </Button>
          <Button variant="danger" autoFocus onClick={onConfirm} shortcut="ENTER">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

/** INS · Varios: cantidad para el siguiente código, o para el renglón elegido. */
function VariosDialog({
  editing,
  initialCode,
  onClose,
  onSetQty,
  onAdd,
}: {
  editing: CartLine | null;
  initialCode: string;
  onClose: () => void;
  onSetQty: (key: string, qty: number) => void;
  onAdd: (qty: number, code: string) => void;
}) {
  const [qty, setQty] = useState(editing ? String(editing.qty) : '');
  const [productCode, setProductCode] = useState(initialCode);
  const value = Number(qty.replace(',', '.'));
  const valid = Number.isFinite(value) && value >= 0 && qty.trim() !== '';

  return (
    <Modal
      label="Varios"
      head={<h2 className="modal__title">{editing ? `Cantidad · ${editing.name}` : 'Varios: cantidad del producto'}</h2>}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      foot={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="varios-form" variant="primary" disabled={!valid || (!editing && !productCode.trim())}>
            {editing ? 'Cambiar cantidad' : 'Agregar'}
          </Button>
        </>
      }
    >
      <form
        id="varios-form"
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          if (editing) onSetQty(editing.key, value);
          else if (productCode.trim()) onAdd(value, productCode);
        }}
      >
        <Field label="Cantidad" htmlFor="varios-qty" hint="Admite decimales para granel: 1.5, 0.250…">
          <TextInput
            id="varios-qty"
            amount
            autoFocus
            inputMode="decimal"
            value={qty}
            onChange={(event) => setQty(event.target.value)}
          />
        </Field>
        {!editing && (
          <Field label="Código del producto" htmlFor="varios-code">
            <TextInput
              id="varios-code"
              value={productCode}
              autoComplete="off"
              onChange={(event) => setProductCode(event.target.value)}
            />
          </Field>
        )}
      </form>
    </Modal>
  );
}

/** CTRL+P · Artículo común: algo que no está dado de alta. */
function CommonDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (input: { description: string; unitPrice: number; qty: number }) => Promise<void>;
}) {
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [busy, setBusy] = useState(false);
  const unitPrice = Number(price.replace(',', '.'));
  const quantity = Number(qty.replace(',', '.'));
  const valid =
    description.trim().length > 0 && Number.isFinite(unitPrice) && unitPrice > 0 && quantity > 0;

  return (
    <Modal
      label="Artículo común"
      head={<h2 className="modal__title">Artículo común</h2>}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      foot={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" form="comun-form" variant="primary" disabled={!valid || busy}>
            Agregar al ticket
          </Button>
        </>
      }
    >
      <form
        id="comun-form"
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid) return;
          setBusy(true);
          await onAdd({ description, unitPrice, qty: quantity });
          setBusy(false);
        }}
      >
        <p className="subtle">
          Para vender algo que no está en el catálogo. Sale en el ticket con la descripción que escribas y no
          mueve inventario.
        </p>
        <Field label="Descripción" htmlFor="comun-desc">
          <TextInput
            id="comun-desc"
            autoFocus
            maxLength={160}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className="row-2">
          <Field label="Precio" htmlFor="comun-price">
            <TextInput
              id="comun-price"
              amount
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </Field>
          <Field label="Cantidad" htmlFor="comun-qty">
            <TextInput
              id="comun-qty"
              amount
              inputMode="decimal"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/** F10 · Buscar por nombre, SKU o código. */
function SearchDialog({
  initialTerm,
  wholesale,
  customerId,
  onClose,
  onPick,
}: {
  initialTerm: string;
  wholesale: boolean;
  customerId?: string;
  onClose: () => void;
  onPick: (item: CatalogItem) => void;
}) {
  const [term, setTerm] = useState(initialTerm);
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(
      async () => {
        setBusy(true);
        setError(null);
        try {
          const response = await api.posSearch({
            q: term,
            limit: 50,
            wholesale: wholesale || undefined,
            ...(customerId ? { customerId } : {}),
          });
          if (!cancelled) {
            setResults(response.data);
            setIndex(0);
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof ApiError ? err.message : 'No se pudo buscar');
        } finally {
          if (!cancelled) setBusy(false);
        }
      },
      term ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [term, wholesale, customerId]);

  return (
    <Modal
      wide
      label="Buscar producto"
      head={<h2 className="modal__title">Buscar producto {wholesale && <span className="flag flag--accent">Mayoreo</span>}</h2>}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setIndex((i) => Math.min(results.length - 1, i + 1));
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setIndex((i) => Math.max(0, i - 1));
        }
        if (event.key === 'Enter' && results[index]) {
          event.preventDefault();
          onPick(results[index]!);
        }
      }}
      foot={<Button onClick={onClose}>Cerrar</Button>}
    >
      <div className="stack">
        <TextInput
          autoFocus
          large
          placeholder="Nombre, SKU o código de barras"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          aria-label="Buscar"
        />
        {error && <Alert>{error}</Alert>}
        <div className="venta__search-results">
          <table className="venta__table venta__table--compact">
            <thead>
              <tr>
                <th>Código</th>
                <th>Descripción</th>
                <th className="num">Precio</th>
                <th className="num">Existencia</th>
              </tr>
            </thead>
            <tbody>
              {results.map((item, i) => (
                <tr
                  key={item.variantId}
                  aria-selected={i === index}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => onPick(item)}
                >
                  <td className="mono">{item.barcode ?? item.sku}</td>
                  <td>{item.name}</td>
                  <td className="num">{formatMoney(item.unitPrice)}</td>
                  <td className={`num ${item.trackStock && toNumber(item.qtyAvailable) <= 0 ? 'danger' : ''}`}>
                    {item.trackStock ? formatQty(item.qtyAvailable) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && results.length === 0 && <p className="venta__empty">Nada coincide con «{term}».</p>}
        </div>
        <p className="subtle">↑ ↓ para elegir · ENTER agrega · ESC cierra</p>
      </div>
    </Modal>
  );
}

/** F7 / F8 · Entradas y salidas de efectivo de la caja. */
function CashMovementDialog({
  type,
  cashSessionId,
  onClose,
  onDone,
}: {
  type: 'CASH_IN' | 'CASH_OUT';
  cashSessionId: string | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isIn = type === 'CASH_IN';
  const value = Number(amount.replace(',', '.'));
  const valid = value > 0 && reason.trim().length >= 3;

  return (
    <Modal
      label={isIn ? 'Entrada de efectivo' : 'Salida de efectivo'}
      head={<h2 className="modal__title">{isIn ? 'Entrada de efectivo' : 'Salida de efectivo'}</h2>}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      foot={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            form="cash-form"
            variant="primary"
            disabled={!valid || busy || !cashSessionId}
          >
            Registrar {isIn ? 'entrada' : 'salida'}
          </Button>
        </>
      }
    >
      {!cashSessionId ? (
        <Alert tone="warning">La caja está cerrada. Ábrela en Corte para registrar movimientos.</Alert>
      ) : (
        <form
          id="cash-form"
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid) return;
            setBusy(true);
            setError(null);
            try {
              await api.createCashMovement({
                cashSessionId,
                type,
                amount: value.toFixed(2),
                reason: reason.trim(),
              });
              onDone(`${isIn ? 'Entrada' : 'Salida'} de ${formatMoney(value)} registrada.`);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'No se pudo registrar el movimiento');
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="subtle">
            {isIn
              ? 'Dinero que entra al cajón sin ser venta: cambio que trajeron, un abono en efectivo…'
              : 'Dinero que sale del cajón: pago a un proveedor, una compra menor, un retiro…'}
          </p>
          <Field label="Monto" htmlFor="cash-amount">
            <TextInput
              id="cash-amount"
              amount
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field label="Motivo" htmlFor="cash-reason">
            <TextInput
              id="cash-reason"
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {error && <Alert>{error}</Alert>}
        </form>
      )}
    </Modal>
  );
}

/**
 * Traduce el error del servidor a algo accionable: el cajero necesita saber si
 * le falta existencia, si la caja está cerrada o si el problema es de permisos.
 */
function describeSaleError(error: ApiError): string {
  switch (error.code) {
    case 'INSUFFICIENT_STOCK': {
      const lines = Array.isArray(error.details) ? error.details : [];
      const detail = lines
        .map(
          (l: { name?: string; sku?: string; available?: string; requested?: string }) =>
            `${l.name ?? l.sku}: quedan ${formatQty(l.available ?? '0')}, pediste ${formatQty(l.requested ?? '0')}`,
        )
        .join(' · ');
      return detail
        ? `La tienda no permite vender sin existencia (Configuración → Ventas). ${detail}`
        : error.message;
    }
    case 'CASH_SESSION_REQUIRED':
      return 'La caja de esta terminal está cerrada. Ábrela en Corte para poder cobrar.';
    case 'FORBIDDEN':
      return `${error.message}. Pide autorización a un supervisor.`;
    case 'LOCK_TIMEOUT':
      return 'Otra caja estaba tocando los mismos artículos. Vuelve a intentar.';
    default:
      return error.message;
  }
}
