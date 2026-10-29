import { createPortal } from 'react-dom';
import type { ReturnDetail, SaleDetail } from '../lib/api';
import type { StoreSettings } from '../lib/api';
import { formatDateTime, formatMoney, formatQty, toNumber } from '../lib/format';
import { getSettings, useStoreSettings } from '../lib/settings';

/**
 * Ticket para impresora térmica.
 *
 * Se monta fuera del árbol visible (portal al `body`) y solo existe para el
 * papel: en pantalla está oculto y al imprimir es lo ÚNICO que sale. Funciona
 * con cualquier impresora de tickets instalada como impresora del sistema
 * (Epson TM, Xprinter, 3nStar…), que es como se conecta el 90 % de ellas.
 *
 * Encabezado, pie y qué datos salen los decide Configuración → Ticket. El
 * ancho del papel (58 u 80 mm) también, pero cada caja puede fijar el suyo
 * en Caja: cada equipo tiene su impresora.
 */

export type PaperWidth = '58' | '80';

const PAPER_KEY = 'pos.paperWidth';

export function getPaperWidth(): PaperWidth {
  try {
    const local = localStorage.getItem(PAPER_KEY);
    if (local === '58' || local === '80') return local;
  } catch {
    // Sin almacenamiento local manda la configuración de la tienda.
  }
  return getSettings()['ticket.paper'];
}

export function setPaperWidth(width: PaperWidth): void {
  try {
    localStorage.setItem(PAPER_KEY, width);
  } catch {
    // Sin almacenamiento local se queda en 80 mm: no es motivo para fallar.
  }
}

/** Imprime lo que esté montado como ticket. */
export function printTicket(): void {
  document.documentElement.dataset.paper = getPaperWidth();
  window.print();
}

/** Texto libre de varias líneas → renglones del ticket. */
function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function PrintTicket({
  sale,
  ret,
  cashReceived,
  reprint,
}: {
  sale?: SaleDetail;
  ret?: ReturnDetail;
  cashReceived?: string | null;
  reprint?: boolean;
}) {
  const settings = useStoreSettings();
  const issuer = mergeIssuer(sale?.issuer, settings);
  const header = linesOf(settings['ticket.header']);
  const footer = linesOf(settings['ticket.footer']);

  const content = sale ? (
    <>
      <Header issuer={issuer} fallback={sale.branch.name} />
      {header.map((line) => (
        <p key={line} className="pt-center">
          {line}
        </p>
      ))}
      <div className="pt-meta">
        <div>
          <span>Folio</span>
          <strong>{sale.folio}</strong>
        </div>
        <div>
          <span>Fecha</span>
          <span>{formatDateTime(sale.occurredAt)}</span>
        </div>
        {settings['ticket.showCashier'] && (
          <div>
            <span>Atendió</span>
            <span>{sale.cashier?.name ?? '—'}</span>
          </div>
        )}
        {settings['ticket.showCustomer'] && (
          <div>
            <span>Cliente</span>
            <span>{sale.customer?.name ?? 'Público en general'}</span>
          </div>
        )}
        {settings['ticket.showCustomer'] && sale.customer?.rfc && (
          <div>
            <span>RFC</span>
            <span>{sale.customer.rfc}</span>
          </div>
        )}
      </div>
      {reprint && <p className="pt-center pt-strong">*** REIMPRESIÓN ***</p>}
      {sale.status === 'CANCELLED' && <p className="pt-center pt-strong">*** VENTA CANCELADA ***</p>}

      <div className="pt-rule" />
      {sale.items.map((item) => (
        <div key={item.lineNumber} className="pt-item">
          <div className="pt-item__name">
            {settings['ticket.showSku'] && item.sku !== 'COMUN' ? `${item.sku} · ` : ''}
            {item.name}
          </div>
          <div className="pt-row">
            <span>
              {formatQty(item.qty)} × {formatMoney(item.unitPrice)}
            </span>
            <span>{formatMoney(toNumber(item.unitPrice) * toNumber(item.qty))}</span>
          </div>
          {toNumber(item.discountAmount) > 0 && (
            <div className="pt-row pt-muted">
              <span>Descuento</span>
              <span>−{formatMoney(item.discountAmount)}</span>
            </div>
          )}
        </div>
      ))}
      <div className="pt-rule" />

      <div className="pt-row">
        <span>Subtotal</span>
        <span>{formatMoney(sale.subtotal)}</span>
      </div>
      {settings['ticket.showSavings'] && toNumber(sale.discountTotal) > 0 && (
        <div className="pt-row">
          <span>Ahorro</span>
          <span>−{formatMoney(sale.discountTotal)}</span>
        </div>
      )}
      <div className="pt-row">
        <span>IVA</span>
        <span>{formatMoney(sale.taxTotal)}</span>
      </div>
      <div className="pt-row pt-total">
        <span>TOTAL</span>
        <span>{formatMoney(sale.total)}</span>
      </div>

      <div className="pt-rule" />
      {sale.payments
        .filter((p) => p.status !== 'VOIDED')
        .map((payment, index) => (
          <div key={index} className="pt-row">
            <span>
              {payment.methodName}
              {payment.reference ? ` ${payment.reference}` : ''}
            </span>
            <span>{formatMoney(payment.amount)}</span>
          </div>
        ))}
      {toNumber(cashReceived) > 0 && (
        <div className="pt-row">
          <span>Recibido</span>
          <span>{formatMoney(cashReceived)}</span>
        </div>
      )}
      {toNumber(sale.changeGiven) > 0 && (
        <div className="pt-row pt-strong">
          <span>Cambio</span>
          <span>{formatMoney(sale.changeGiven)}</span>
        </div>
      )}
      {toNumber(sale.balanceDue) > 0 && (
        <div className="pt-row pt-strong">
          <span>Saldo a crédito</span>
          <span>{formatMoney(sale.balanceDue)}</span>
        </div>
      )}
      <p className="pt-center pt-muted">
        Artículos: {formatQty(sale.items.reduce((acc, i) => acc + toNumber(i.qty), 0))}
      </p>
      <div className="pt-rule" />
      {footer.map((line) => (
        <p key={line} className="pt-center">
          {line}
        </p>
      ))}
      <p className="pt-center pt-barcode">{sale.folio}</p>
    </>
  ) : ret ? (
    <>
      <Header issuer={issuer} fallback="Comprobante de devolución" />
      <p className="pt-center pt-strong">DEVOLUCIÓN</p>
      <div className="pt-meta">
        <div>
          <span>Folio</span>
          <strong>{ret.folio}</strong>
        </div>
        <div>
          <span>Venta</span>
          <span>{ret.sale.folio}</span>
        </div>
        <div>
          <span>Fecha</span>
          <span>{formatDateTime(ret.occurredAt)}</span>
        </div>
        {ret.customer && (
          <div>
            <span>Cliente</span>
            <span>{ret.customer.name}</span>
          </div>
        )}
      </div>
      <div className="pt-rule" />
      {ret.items.map((item) => (
        <div key={item.id} className="pt-row">
          <span>
            {formatQty(item.qty)} {item.name}
          </span>
          <span>{formatMoney(item.lineTotal)}</span>
        </div>
      ))}
      <div className="pt-rule" />
      <div className="pt-row pt-total">
        <span>TOTAL DEVUELTO</span>
        <span>{formatMoney(ret.total)}</span>
      </div>
      {ret.refunds.map((r, i) => (
        <div key={i} className="pt-row">
          <span>Reembolso {r.methodName}</span>
          <span>{formatMoney(r.amount)}</span>
        </div>
      ))}
      {ret.creditNote && (
        <>
          <div className="pt-rule" />
          <p className="pt-center pt-strong">NOTA DE CRÉDITO</p>
          <p className="pt-center pt-barcode">{ret.creditNote.folio}</p>
          <p className="pt-center">Saldo a favor: {formatMoney(ret.creditNote.amount)}</p>
          {ret.creditNote.expiresAt && (
            <p className="pt-center pt-muted">
              Válida hasta {new Date(ret.creditNote.expiresAt).toLocaleDateString('es-MX')}
            </p>
          )}
          <p className="pt-center pt-muted">Preséntela al pagar su próxima compra.</p>
        </>
      )}
      <div className="pt-rule" />
      <p className="pt-center pt-muted">Firma del cliente</p>
      <p className="pt-center">______________________</p>
    </>
  ) : null;

  if (!content) return null;
  return createPortal(
    <div className="print-ticket" data-print="ticket">
      {content}
    </div>,
    document.body,
  );
}

/**
 * Los datos del negocio capturados en Configuración mandan sobre los de la
 * empresa registrada; lo que quede vacío se toma de la empresa.
 */
function mergeIssuer(
  issuer: SaleDetail['issuer'] | undefined,
  settings: StoreSettings,
): SaleDetail['issuer'] {
  const pick = (value: string, fallback: string | null | undefined) =>
    value.trim() || fallback || null;
  return {
    ...(issuer ?? {}),
    name: pick(settings['business.name'], issuer?.name) ?? '',
    legalName: pick(settings['business.legalName'], issuer?.legalName),
    rfc: pick(settings['business.rfc'], issuer?.rfc),
    address: pick(settings['business.address'], issuer?.address),
    phone: pick(settings['business.phone'], issuer?.phone),
  } as SaleDetail['issuer'];
}

function Header({
  issuer,
  fallback,
}: {
  issuer: SaleDetail['issuer'];
  fallback: string;
}) {
  return (
    <div className="pt-head">
      <p className="pt-title">{issuer?.name ?? fallback}</p>
      {issuer?.legalName && <p>{issuer.legalName}</p>}
      {issuer?.rfc && <p>RFC: {issuer.rfc}</p>}
      {issuer?.address && <p>{issuer.address}</p>}
      {issuer?.phone && <p>Tel. {issuer.phone}</p>}
    </div>
  );
}
