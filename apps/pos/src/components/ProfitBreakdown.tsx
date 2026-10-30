import type { CashProfit } from '../lib/api';
import { formatMoney } from '../lib/format';
import { Card } from '../ui';

/**
 * Ganancia de un turno: neta total y por departamento (categoría).
 *
 * Ganancia neta = ventas sin IVA − devoluciones − costo de lo vendido (el
 * costo que tenía cada artículo AL VENDERSE, no el actual). Solo se pinta si
 * el servidor mandó `profit`, que es solo para quien puede ver utilidad.
 */
export function ProfitBreakdown({ profit }: { profit: CashProfit }) {
  const net = Number(profit.netProfit);
  return (
    <Card title="Ganancia del turno" flush>
      <div className="methods">
        <div className="method-row">
          <span className="method-row__name">Ventas sin IVA (menos devoluciones)</span>
          <span className="method-row__amount">{formatMoney(profit.netSales)}</span>
        </div>
        <div className="method-row">
          <span className="method-row__name">Costo de lo vendido</span>
          <span className="method-row__amount">{formatMoney(profit.cost)}</span>
        </div>
        <div className="method-row">
          <span className="method-row__name">
            <strong>Ganancia neta</strong>
            <span className="subtle"> · margen {Number(profit.margin).toFixed(1)} %</span>
          </span>
          <span
            className="method-row__amount"
            style={{ color: net < 0 ? 'var(--danger)' : undefined, fontWeight: 700 }}
          >
            {formatMoney(profit.netProfit)}
          </span>
        </div>
      </div>
      {profit.byCategory.length > 0 && (
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Departamento</th>
                <th className="table__money">Ventas sin IVA</th>
                <th className="table__money">Costo</th>
                <th className="table__money">Ganancia</th>
                <th className="table__money">Margen</th>
              </tr>
            </thead>
            <tbody>
              {profit.byCategory.map((row) => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td className="table__money">{formatMoney(row.netSales)}</td>
                  <td className="table__money">{formatMoney(row.cost)}</td>
                  <td
                    className="table__money"
                    style={Number(row.profit) < 0 ? { color: 'var(--danger)' } : undefined}
                  >
                    {formatMoney(row.profit)}
                  </td>
                  <td className="table__money">{Number(row.margin).toFixed(1)} %</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
