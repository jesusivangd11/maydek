import { useEffect, useRef } from 'react';
import type { SaleDetail } from '../lib/api';
import { formatMoney, formatQty, formatTime, toNumber } from '../lib/format';
import { Badge, Button } from '../ui';
import { PrintTicket, printTicket } from './PrintTicket';

/**
 * Venta completada.
 *
 * Lo que el cajero necesita en los tres segundos siguientes al cobro es el
 * CAMBIO, en grande. El folio y el desglose van después, porque solo hacen
 * falta si algo sale mal.
 *
 * IMPRESIÓN: el papel lo arma `PrintTicket`, en formato térmico de 58 u 80 mm.
 * La reimpresión desde el historial usa el mismo componente a partir de
 * `SaleDetail`, que es idéntico venga de una venta recién hecha o de una
 * consulta.
 */
export function Receipt({
  sale,
  cashReceived,
  onNewSale,
  onViewSale,
}: {
  sale: SaleDetail;
  cashReceived?: string | null;
  onNewSale: () => void;
  onViewSale?: (saleId: string) => void;
}) {
  const newSaleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    newSaleRef.current?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Enter' || event.key === 'Escape') onNewSale();
      if (event.key === 'F9') {
        event.preventDefault();
        printTicket();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNewSale]);

  const change = toNumber(sale.changeGiven);
  const received = toNumber(cashReceived);
  const methods = sale.payments.map((p) => p.methodName).join(' + ');

  return (
    <div className="receipt-screen">
      <PrintTicket sale={sale} cashReceived={cashReceived} />
      <div className="receipt">
        <Badge tone="positive">Venta completada</Badge>

        <div className="receipt__change">
          <p className="receipt__change-label">
            {change > 0 ? 'Cambio a entregar' : 'Cobrado'}
          </p>
          <p className="receipt__change-amount">
            {formatMoney(change > 0 ? change : sale.total)}
          </p>
        </div>

        <dl className="receipt__meta">
          <div>
            <dt>Folio</dt>
            <dd className="mono">{sale.folio}</dd>
          </div>
          <div>
            <dt>Hora</dt>
            <dd>{formatTime(sale.occurredAt)}</dd>
          </div>
          <div>
            <dt>Forma de pago</dt>
            <dd className="truncate" title={methods}>
              {methods}
            </dd>
          </div>
          <div>
            <dt>Cajero</dt>
            <dd className="truncate">{sale.cashier?.name ?? '—'}</dd>
          </div>
        </dl>

        <table className="receipt__lines">
          <tbody>
            {sale.items.map((item) => (
              <tr key={item.lineNumber}>
                <td className="receipt__qty">{formatQty(item.qty)}</td>
                <td>{item.name}</td>
                <td className="table__money">{formatMoney(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Subtotal</td>
              <td className="table__money">{formatMoney(sale.subtotal)}</td>
            </tr>
            <tr>
              <td colSpan={2}>IVA</td>
              <td className="table__money">{formatMoney(sale.taxTotal)}</td>
            </tr>
            <tr className="receipt__total">
              <td colSpan={2}>Total</td>
              <td className="table__money">{formatMoney(sale.total)}</td>
            </tr>
            {sale.payments.map((payment, index) => (
              <tr key={`${payment.methodCode}-${index}`}>
                <td colSpan={2}>
                  {payment.methodName}
                  {payment.reference && <span className="subtle"> · {payment.reference}</span>}
                </td>
                <td className="table__money">{formatMoney(payment.amount)}</td>
              </tr>
            ))}
            {received > 0 && (
              <tr>
                <td colSpan={2}>Recibido</td>
                <td className="table__money">{formatMoney(received)}</td>
              </tr>
            )}
            {change > 0 && (
              <tr>
                <td colSpan={2}>Cambio</td>
                <td className="table__money">{formatMoney(change)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      <div className="receipt-actions">
        <Button ref={newSaleRef} variant="primary" size="xl" shortcut="Enter" onClick={onNewSale}>
          Nueva venta
        </Button>

        <div className="receipt-actions__row">
          {onViewSale && (
            <Button variant="secondary" icon="receipt" onClick={() => onViewSale(sale.id)}>
              Ver venta
            </Button>
          )}
          <Button variant="secondary" icon="printer" shortcut="F9" onClick={printTicket}>
            Imprimir ticket
          </Button>
        </div>
      </div>
    </div>
  );
}
