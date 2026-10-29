import { isAtMax, lineTotal, type CartLine, type CartTotals } from '../lib/cart';
import { formatMoney, formatQty } from '../lib/format';
import { Button, EmptyState, Icon } from '../ui';
import type { PickedCustomer } from './PosDialogs';

/**
 * El ticket.
 *
 * Panel fijo a la derecha, con tres zonas que nunca cambian de sitio:
 * cabecera, renglones que hacen scroll, y un pie anclado con el total y el
 * cobro. Que el total y el botón estén SIEMPRE en el mismo píxel es lo que
 * convierte cobrar en un gesto en vez de una búsqueda.
 */
export function Ticket({
  lines,
  totals,
  hasOpenCashSession,
  customer,
  canDiscount,
  canHold,
  onClear,
  onRemove,
  onSetQty,
  onCharge,
  onPickCustomer,
  onDiscountAll,
  onDiscountLine,
  onHold,
  onShowHeld,
}: {
  lines: CartLine[];
  totals: CartTotals;
  hasOpenCashSession: boolean;
  customer: PickedCustomer | null;
  canDiscount: boolean;
  canHold: boolean;
  onClear: () => void;
  onRemove: (variantId: string) => void;
  onSetQty: (variantId: string, qty: number) => void;
  onCharge: () => void;
  onPickCustomer: () => void;
  onDiscountAll: () => void;
  onDiscountLine: (variantId: string) => void;
  onHold: () => void;
  onShowHeld: () => void;
}) {
  const empty = lines.length === 0;

  return (
    <aside className="ticket">
      <header className="ticket__head">
        <h2 className="ticket__title">
          Ticket
          {!empty && (
            <span className="ticket__count">
              {totals.lineCount} {totals.lineCount === 1 ? 'renglón' : 'renglones'} ·{' '}
              {formatQty(totals.itemCount)} art.
            </span>
          )}
        </h2>
        {!empty && (
          <Button variant="subtle" size="sm" icon="trash" onClick={onClear}>
            Vaciar
          </Button>
        )}
      </header>

      {/* El cliente decide el precio (mayoreo) y si se puede vender a crédito:
          por eso va arriba, antes de los renglones, y siempre a la vista. */}
      <button type="button" className="ticket__customer" onClick={onPickCustomer}>
        <Icon name="user" size={18} />
        <span className="ticket__customer-name">
          {customer ? customer.name : 'Público en general'}
          {customer?.priceList && customer.priceList.code !== 'PUBLICO' && (
            <span className="badge badge--info">{customer.priceList.name}</span>
          )}
        </span>
        <kbd className="kbd">F4</kbd>
      </button>

      {empty ? (
        /* Un panel en blanco no dice nada. Este dice qué falta y qué hacer. */
        <div className="ticket__empty">
          <EmptyState
            icon="receipt"
            title="Tu ticket está vacío"
            text="Escanea un código o selecciona un producto para comenzar la venta."
          />
        </div>
      ) : (
        <ul className="ticket__lines">
          {lines.map((line) => (
            <TicketLine
              key={line.variantId}
              line={line}
              canDiscount={canDiscount}
              onRemove={onRemove}
              onSetQty={onSetQty}
              onDiscount={onDiscountLine}
            />
          ))}
        </ul>
      )}

      <footer className="ticket__foot">
        <div className="totals">
          <div className="totals__row">
            <span>Subtotal</span>
            <span>{formatMoney(totals.gross)}</span>
          </div>

          {totals.discount > 0 && (
            <div className="totals__row totals__row--discount">
              <span>Descuento</span>
              <span>−{formatMoney(totals.discount)}</span>
            </div>
          )}

          <div className="totals__row totals__row--total">
            <span className="totals__label">Total</span>
            <span className="totals__amount">{formatMoney(totals.total)}</span>
          </div>
        </div>

        {!hasOpenCashSession && (
          <p className="alert alert--warning" role="status">
            <Icon name="alert" size={18} className="alert__icon" />
            <span>Abre la caja antes de cobrar.</span>
          </p>
        )}

        <div className="ticket__tools">
          {canDiscount && (
            <Button size="sm" variant="secondary" icon="tag" disabled={empty} onClick={onDiscountAll}>
              Descuento <kbd className="kbd">F5</kbd>
            </Button>
          )}
          {canHold && (
            <Button size="sm" variant="secondary" icon="pause" disabled={empty} onClick={onHold}>
              En espera <kbd className="kbd">F6</kbd>
            </Button>
          )}
          <Button size="sm" variant="secondary" icon="list" onClick={onShowHeld}>
            Recuperar <kbd className="kbd">F7</kbd>
          </Button>
        </div>

        <Button
          variant="primary"
          size="xl"
          shortcut="F2"
          disabled={empty || !hasOpenCashSession}
          onClick={onCharge}
        >
          {empty ? 'Cobrar' : `Cobrar ${formatMoney(totals.total)}`}
        </Button>

        <div className="ticket__shortcuts">
          <span>
            <kbd className="kbd">F2</kbd> Cobrar
          </span>
          <span>
            <kbd className="kbd">F3</kbd> Buscar
          </span>
          <span>
            <kbd className="kbd">F4</kbd> Cliente
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> Limpiar
          </span>
        </div>
      </footer>
    </aside>
  );
}

function TicketLine({
  line,
  canDiscount,
  onRemove,
  onSetQty,
  onDiscount,
}: {
  line: CartLine;
  canDiscount: boolean;
  onRemove: (variantId: string) => void;
  onSetQty: (variantId: string, qty: number) => void;
  onDiscount: (variantId: string) => void;
}) {
  const atMax = isAtMax(line);

  return (
    <li className="line">
      <div className="line__head">
        <div>
          <p className="line__name">{line.name}</p>
          <p className="line__sku">{line.sku}</p>
        </div>
        <button
          type="button"
          className="line__remove"
          aria-label={`Quitar ${line.name}`}
          title={`Quitar ${line.name}`}
          onClick={() => onRemove(line.variantId)}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="line__body">
        <div className="stepper">
          <button
            type="button"
            className="stepper__btn"
            aria-label={`Quitar una unidad de ${line.name}`}
            onClick={() => onSetQty(line.variantId, line.qty - 1)}
          >
            −
          </button>
          <input
            className="stepper__qty"
            inputMode="decimal"
            value={line.qty}
            aria-label={`Cantidad de ${line.name}`}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) onSetQty(line.variantId, next);
            }}
          />
          <button
            type="button"
            className="stepper__btn"
            aria-label={`Agregar una unidad de ${line.name}`}
            disabled={atMax}
            title={atMax ? 'No hay más existencia' : 'Aumentar'}
            onClick={() => onSetQty(line.variantId, line.qty + 1)}
          >
            +
          </button>
        </div>

        <span className="line__unit">× {formatMoney(line.unitPrice)}</span>
        <strong className="line__total">{formatMoney(lineTotal(line))}</strong>
      </div>

      {(line.discount > 0 || canDiscount) && (
        <div className="line__discount">
          {line.discount > 0 && <span>Descuento −{formatMoney(line.discount)}</span>}
          {canDiscount && (
            <button type="button" className="link-button" onClick={() => onDiscount(line.variantId)}>
              {line.discount > 0 ? 'Cambiar' : 'Descuento'}
            </button>
          )}
        </div>
      )}

      {line.trackStock && atMax && (
        <p className="line__note">
          Es todo lo que hay: {formatQty(line.available)} {line.unit} en existencia.
        </p>
      )}
    </li>
  );
}
