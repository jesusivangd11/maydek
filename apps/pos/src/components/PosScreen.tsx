import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type CatalogItem,
  type Category,
  type SaleDetail,
  type SalePaymentInput,
} from '../lib/api';
import {
  addToCart,
  applyGlobalDiscount,
  cartTotals,
  setDiscount,
  removeLine,
  setQty,
  syncAvailability,
  toSaleLines,
  type CartLine,
} from '../lib/cart';
import { formatQty } from '../lib/format';
import { Alert, EmptyState, SearchInput } from '../ui';
import { PaymentDialog } from './PaymentDialog';
import {
  CustomerPicker,
  DiscountDialog,
  HeldSalesDialog,
  type PickedCustomer,
} from './PosDialogs';
import { ProductCard } from './ProductCard';
import { Receipt } from './Receipt';
import { Ticket } from './Ticket';

/**
 * La pantalla de venta.
 *
 * Diseñada para alguien que tiene un cliente enfrente:
 *   · El foco vive en el buscador. Se vuelve a él solo tras cada acción.
 *   · Un código de barras completo entra y se agrega SOLO, sin elegir nada.
 *   · F2 cobra. F3 busca. F4 cliente. F5 descuento. F6 en espera. F7
 *     recuperar. Esc limpia la búsqueda.
 *   · El carrito no se pierde si la búsqueda falla o el servidor tarda.
 *
 * El reparto de la pantalla es fijo: catálogo a la izquierda, ticket a la
 * derecha, y el ticket NO se esconde nunca en escritorio. Lo que el cajero
 * lleva cobrado tiene que estar a la vista mientras sigue agregando.
 */

/** Todas las categorías: valor centinela del filtro, no un identificador. */
const ALL = 'all';

type Dialog =
  | { kind: 'customer' }
  | { kind: 'discount-all' }
  | { kind: 'discount-line'; variantId: string }
  | { kind: 'held' }
  | null;

export function PosScreen({
  permissions,
  hasOpenCashSession,
  onSaleCompleted,
  onViewSale,
}: {
  permissions: string[];
  hasOpenCashSession: boolean;
  onSaleCompleted: () => void;
  onViewSale: (saleId: string) => void;
}) {
  const [term, setTerm] = useState('');
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [categories, setCategories] = useState<Category[]>([]);
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const linesRef = useRef<CartLine[]>([]);
  linesRef.current = lines;

  const canDiscount = permissions.includes('sale.discount.apply');
  const canHold = permissions.includes('sale.hold');
  const canCreateCustomer = permissions.includes('customer.create');
  const [charging, setCharging] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    sale: SaleDetail;
    cashReceived: string | null;
  } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * Clave de idempotencia POR TICKET, no por clic.
   *
   * Se fija al abrir el cobro y no cambia mientras el ticket siga siendo el
   * mismo. Así, si el cajero da dos veces a cobrar —o la red falla y
   * reintenta—, el servidor reconoce la petición repetida y devuelve la venta
   * original en vez de cobrar dos veces. Generarla dentro del manejador, como
   * estaba, producía una clave distinta en cada intento: justo lo contrario de
   * lo que hace falta.
   */
  const ticketKey = useRef<string | null>(null);
  /** Cerrojo síncrono: dos clics en el mismo tick no esperan al estado. */
  const submitting = useRef(false);

  const startCharging = useCallback(() => {
    if (ticketKey.current === null) {
      ticketKey.current = `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    setCharging(true);
  }, []);

  const totals = cartTotals(lines);

  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  /* ── Categorías ───────────────────────────────────────────────────────────
     Se piden una vez. Si el usuario no tiene permiso de catálogo la petición
     falla y los filtros simplemente no se pintan: no es un error que deba
     interrumpir una venta. */
  useEffect(() => {
    let cancelled = false;

    api
      .listCategories()
      .then((data) => {
        if (!cancelled) {
          setCategories(data.filter((category) => category.isActive && category.productCount > 0));
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Búsqueda con rebote: el POS no consulta en cada tecla ──
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(
      async () => {
        setSearching(true);
        setSearchError(null);
        try {
          const response = await api.posSearch({
            q: term,
            limit: 24,
            ...(categoryId !== ALL ? { categoryId } : {}),
            ...(customer ? { customerId: customer.id } : {}),
          });
          if (cancelled) return;

          // Código de barras inequívoco: se agrega solo y se limpia el campo.
          if (response.exactBarcode && response.data.length === 1 && term.length >= 8) {
            setLines((current) => addToCart(current, response.data[0]!));
            setTerm('');
            setResults([]);
            focusSearch();
            return;
          }

          setResults(response.data);
          // Si otra caja vendió las últimas piezas mientras este ticket estaba
          // abierto, el tope del renglón baja AQUÍ y no al cobrar.
          setLines((current) => syncAvailability(current, response.data));
        } catch (error) {
          if (cancelled) return;
          setSearchError(
            error instanceof ApiError ? error.message : 'No se pudo consultar el catálogo',
          );
        } finally {
          if (!cancelled) setSearching(false);
        }
      },
      term ? 180 : 0,
    );

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [term, categoryId, focusSearch, customer]);

  // El aviso efímero ("ticket en espera") se va solo.
  useEffect(() => {
    if (!notice) return;
    const handle = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(handle);
  }, [notice]);

  /**
   * Cambiar de cliente cambia los precios (lista de mayoreo). Los renglones ya
   * capturados se vuelven a preciar con la lista nueva; el servidor recalcula
   * de todos modos al cobrar, pero el total que se le dice al cliente tiene
   * que ser el bueno desde ahora.
   */
  const repriceCart = useCallback(async (next: PickedCustomer | null) => {
    const current = linesRef.current;
    if (current.length === 0) return;
    const fresh = await Promise.all(
      current.map((line) =>
        api
          .posSearch({ q: line.sku, limit: 5, ...(next ? { customerId: next.id } : {}) })
          .then((r) => r.data.find((item) => item.variantId === line.variantId) ?? null)
          .catch(() => null),
      ),
    );
    setLines((rows) =>
      rows.map((line) => {
        const item = fresh.find((f) => f?.variantId === line.variantId);
        return item ? { ...line, unitPrice: Number(item.unitPrice), discount: 0 } : line;
      }),
    );
  }, []);

  const pickCustomer = useCallback(
    (next: PickedCustomer | null) => {
      setCustomer(next);
      setDialog(null);
      void repriceCart(next);
      focusSearch();
    },
    [repriceCart, focusSearch],
  );

  const holdTicket = useCallback(async () => {
    if (linesRef.current.length === 0) return;
    try {
      await api.holdSale({
        label: customer?.name,
        cart: { lines: linesRef.current, customer },
      });
      setLines([]);
      setCustomer(null);
      ticketKey.current = null;
      setNotice('Ticket puesto en espera. Recupéralo con F7.');
      focusSearch();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : 'No se pudo poner en espera');
    }
  }, [customer, focusSearch]);

  // ── Atajos ──
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Con un diálogo o el cobro abiertos, las teclas son de ese diálogo.
      if (dialog || charging) return;
      if (event.key === 'F2') {
        event.preventDefault();
        if (lines.length > 0 && hasOpenCashSession) startCharging();
      }
      if (event.key === 'F3') {
        event.preventDefault();
        focusSearch();
      }
      if (event.key === 'F4') {
        event.preventDefault();
        setDialog({ kind: 'customer' });
      }
      if (event.key === 'F5' && canDiscount && lines.length > 0) {
        event.preventDefault();
        setDialog({ kind: 'discount-all' });
      }
      if (event.key === 'F6' && canHold) {
        event.preventDefault();
        void holdTicket();
      }
      if (event.key === 'F7') {
        event.preventDefault();
        setDialog({ kind: 'held' });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    lines.length,
    hasOpenCashSession,
    focusSearch,
    startCharging,
    dialog,
    charging,
    canDiscount,
    canHold,
    holdTicket,
  ]);

  const addItem = useCallback(
    (item: CatalogItem) => {
      setLines((current) => addToCart(current, item));
      focusSearch();
    },
    [focusSearch],
  );

  async function confirmPayment(payments: SalePaymentInput[], cashReceived?: string) {
    // Doble clic: el segundo se descarta antes de tocar la red.
    if (submitting.current) return;
    submitting.current = true;

    setPaying(true);
    setPayError(null);

    try {
      const sale = await api.createSale({
        items: toSaleLines(lines),
        payments,
        ...(customer ? { customerId: customer.id } : {}),
        ...(cashReceived ? { cashReceived } : {}),
        idempotencyKey: ticketKey.current ?? undefined,
      });

      setReceipt({ sale, cashReceived: cashReceived ?? null });
      setLines([]);
      setCustomer(null);
      setCharging(false);
      setTerm('');
      // Ticket cerrado: el siguiente estrena clave.
      ticketKey.current = null;
      onSaleCompleted();
    } catch (error) {
      if (error instanceof ApiError) {
        setPayError(describeSaleError(error));
      } else {
        setPayError(
          'No se pudo conectar con el servidor. Vuelve a intentar: si la venta ya se había registrado, el sistema la reconocerá y no cobrará dos veces.',
        );
      }
    } finally {
      submitting.current = false;
      setPaying(false);
    }
  }

  if (receipt) {
    return (
      <Receipt
        sale={receipt.sale}
        cashReceived={receipt.cashReceived}
        onNewSale={() => {
          setReceipt(null);
          focusSearch();
        }}
        onViewSale={onViewSale}
      />
    );
  }

  return (
    <div className="pos">
      {/* ── Catálogo ── */}
      <section className="catalog">
        {/* Buscador y filtros quedan fuera del scroll: son el punto de entrada
            de la pantalla y tienen que estar siempre donde el cajero mira. */}
        <div className="catalog__head">
          <SearchInput
            ref={searchRef}
            value={term}
            autoFocus
            busy={searching}
            shortcut="F3"
            placeholder="Buscar producto, SKU o escanear código…"
            aria-label="Buscar artículos"
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setTerm('');
              if (event.key === 'Enter' && results.length === 1) {
                setLines((current) => addToCart(current, results[0]!));
                setTerm('');
              }
            }}
          />

          {categories.length > 0 && (
            <div className="catalog__filters" role="group" aria-label="Filtrar por categoría">
              <button
                type="button"
                className="chip"
                aria-pressed={categoryId === ALL}
                onClick={() => setCategoryId(ALL)}
              >
                Todos
              </button>
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="chip"
                  aria-pressed={categoryId === category.id}
                  onClick={() => setCategoryId(category.id)}
                >
                  {category.name}
                  <span className="chip__count">{category.productCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="catalog__body">
          {notice && (
            <p className="toast" role="status">
              {notice}
            </p>
          )}
          {searchError && <Alert>{searchError}</Alert>}

          {!searchError && results.length > 0 && (
            <p className="catalog__meta">
              <span>
                {results.length} {results.length === 1 ? 'artículo' : 'artículos'}
                {term && <> para «{term}»</>}
              </span>
              <span>Toca una tarjeta para agregarla al ticket</span>
            </p>
          )}

          {!searchError && results.length === 0 && !searching && (
            <EmptyState
              boxed
              icon={term ? 'search' : 'box'}
              title={term ? `Nada coincide con «${term}»` : 'Sin artículos que mostrar'}
              text={
                term
                  ? 'Revisa el nombre o el SKU, o escanea el código de barras del producto.'
                  : 'Escanea un código de barras o escribe para buscar en el catálogo.'
              }
            />
          )}

          {results.length > 0 && (
            <div className="products">
              {results.map((item) => (
                <ProductCard key={item.variantId} item={item} onSelect={addItem} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Ticket ── */}
      <Ticket
        lines={lines}
        totals={totals}
        hasOpenCashSession={hasOpenCashSession}
        customer={customer}
        canDiscount={canDiscount}
        canHold={canHold}
        onPickCustomer={() => setDialog({ kind: 'customer' })}
        onDiscountAll={() => setDialog({ kind: 'discount-all' })}
        onDiscountLine={(variantId) => setDialog({ kind: 'discount-line', variantId })}
        onHold={() => void holdTicket()}
        onShowHeld={() => setDialog({ kind: 'held' })}
        onClear={() => {
          setLines([]);
          setCustomer(null);
        }}
        onRemove={(variantId) => setLines((current) => removeLine(current, variantId))}
        onSetQty={(variantId, qty) => setLines((current) => setQty(current, variantId, qty))}
        onCharge={startCharging}
      />

      {charging && (
        <PaymentDialog
          total={totals.total}
          busy={paying}
          error={payError}
          customer={customer}
          onCancel={() => {
            setCharging(false);
            setPayError(null);
            focusSearch();
          }}
          onConfirm={confirmPayment}
        />
      )}

      {dialog?.kind === 'customer' && (
        <CustomerPicker
          canCreate={canCreateCustomer}
          onPick={pickCustomer}
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
        />
      )}

      {dialog?.kind === 'discount-all' && (
        <DiscountDialog
          title="Descuento a todo el ticket"
          base={totals.gross}
          current={totals.discount}
          onClose={() => setDialog(null)}
          onApply={(amount) => {
            setLines((current) => applyGlobalDiscount(current, amount));
            setDialog(null);
            focusSearch();
          }}
        />
      )}

      {dialog?.kind === 'discount-line' &&
        (() => {
          const line = lines.find((l) => l.variantId === dialog.variantId);
          if (!line) return null;
          return (
            <DiscountDialog
              title={`Descuento · ${line.name}`}
              base={line.unitPrice * line.qty}
              current={line.discount}
              onClose={() => setDialog(null)}
              onApply={(amount) => {
                setLines((current) => setDiscount(current, line.variantId, amount));
                setDialog(null);
                focusSearch();
              }}
            />
          );
        })()}

      {dialog?.kind === 'held' && (
        <HeldSalesDialog
          onClose={() => setDialog(null)}
          onResume={(held) => {
            const restored = (Array.isArray(held.cart.lines) ? held.cart.lines : []) as CartLine[];
            // Si había un ticket en curso, no se pierde: se aparta antes.
            if (lines.length > 0) void holdTicket();
            setLines(restored);
            setCustomer((held.cart.customer as PickedCustomer | null | undefined) ?? null);
            ticketKey.current = null;
            setDialog(null);
            focusSearch();
          }}
        />
      )}
    </div>
  );
}

/**
 * Traduce el error del servidor a algo accionable.
 *
 * "Something went wrong" no le sirve a nadie detrás de un mostrador: el cajero
 * necesita saber si le falta existencia, si la caja está cerrada o si el
 * problema es de permisos.
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
      return detail ? `No alcanza la existencia. ${detail}` : error.message;
    }
    case 'CASH_SESSION_REQUIRED':
      return 'La caja de esta terminal está cerrada. Ábrela para poder cobrar.';
    case 'FORBIDDEN':
      return `${error.message}. Pide autorización a un supervisor.`;
    case 'LOCK_TIMEOUT':
      return 'Otra caja estaba tocando los mismos artículos. Vuelve a intentar.';
    default:
      return error.message;
  }
}
