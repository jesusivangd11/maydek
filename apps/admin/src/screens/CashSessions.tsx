import { useState } from 'react';
import { api } from '@pos/lib/api';
import { formatDateTime, formatMoney, toNumber } from '@pos/lib/format';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader } from '@pos/ui';
import type { ScreenProps } from '../App';
import { downloadCsv, useLoad } from '../lib/util';

/**
 * Cortes de caja.
 *
 * Historial de turnos con su arqueo: esperado contra contado, diferencia y
 * motivo. Es donde el dueño revisa, al día siguiente, si alguna caja cerró
 * con faltante.
 */

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: 'Fondo inicial',
  SALE: 'Venta',
  RETURN_REFUND: 'Devolución / cancelación',
  CASH_IN: 'Entrada',
  CASH_OUT: 'Salida',
  WITHDRAWAL: 'Retiro',
  EXPENSE: 'Gasto',
  CLOSING: 'Arqueo de cierre',
  ADJUSTMENT: 'Ajuste',
};

export function CashSessionsScreen(_props: ScreenProps) {
  const sessions = useLoad(() => api.listCashSessions(), []);
  const [open, setOpen] = useState<string | null>(null);
  const rows = sessions.data?.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Cortes de caja"
        subtitle="Turnos abiertos y cerrados, con su arqueo."
        actions={
          <Button
            variant="subtle"
            icon="download"
            disabled={rows.length === 0}
            onClick={() =>
              downloadCsv('cortes-de-caja.csv', rows.map((s) => ({
                Folio: s.folio,
                Caja: s.terminal,
                Apertura: new Date(s.openedAt).toLocaleString('es-MX'),
                Cierre: s.closedAt ? new Date(s.closedAt).toLocaleString('es-MX') : '',
                Abrió: s.openedBy.name,
                Cerró: s.closedBy?.name ?? '',
                Fondo: s.openingFloat,
                Contado: s.countedCash ?? '',
                Diferencia: s.difference ?? '',
                Ventas: s.saleCount,
              })))
            }
          >
            Exportar
          </Button>
        }
      />
      {sessions.error && <Alert>{sessions.error}</Alert>}
      {sessions.data && rows.length === 0 && (
        <Card>
          <EmptyState icon="cash" title="Todavía no hay turnos de caja" />
        </Card>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Caja</th>
                <th>Apertura</th>
                <th>Cierre</th>
                <th className="table__num">Ventas</th>
                <th className="table__money">Contado</th>
                <th className="table__money">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const diff = toNumber(s.difference);
                return (
                  <tr key={s.id} className="table__row--clickable" tabIndex={0} onClick={() => setOpen(s.id)}>
                    <td>
                      <span className="folio">{s.folio}</span>{' '}
                      {s.status === 'OPEN' ? <Badge tone="positive">Abierta</Badge> : <Badge>Cerrada</Badge>}
                    </td>
                    <td>{s.terminal}</td>
                    <td className="text-sm">
                      {formatDateTime(s.openedAt)}
                      <div className="subtle">{s.openedBy.name}</div>
                    </td>
                    <td className="text-sm">
                      {s.closedAt ? formatDateTime(s.closedAt) : '—'}
                      {s.closedBy && <div className="subtle">{s.closedBy.name}</div>}
                    </td>
                    <td className="table__num">{s.saleCount}</td>
                    <td className="table__money">{s.countedCash ? formatMoney(s.countedCash) : '—'}</td>
                    <td className="table__money" style={{ color: diff < 0 ? 'var(--danger)' : diff > 0 ? 'var(--warning)' : undefined }}>
                      {s.difference ? formatMoney(diff) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <SessionDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SessionDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: s, error } = useLoad(() => api.getCashSession(id), [id]);
  return (
    <Modal
      label="Corte de caja"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">{s ? `Corte ${s.status === 'OPEN' ? 'X' : 'Z'} · ${s.folio}` : 'Corte'}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      {s && (
        <>
          <div className="stats">
            <div className="stat"><span className="stat__label">Fondo inicial</span><span className="stat__value stat__value--sm">{formatMoney(s.openingFloat)}</span></div>
            <div className="stat stat--key"><span className="stat__label">Efectivo esperado</span><span className="stat__value">{formatMoney(s.expectedCash)}</span></div>
            <div className="stat"><span className="stat__label">Contado</span><span className="stat__value stat__value--sm">{s.countedCash ? formatMoney(s.countedCash) : '—'}</span></div>
            <div className="stat"><span className="stat__label">Diferencia</span><span className="stat__value stat__value--sm">{s.difference ? formatMoney(s.difference) : '—'}</span></div>
          </div>
          {s.differenceReason && <Alert tone="warning">Motivo de la diferencia: {s.differenceReason}</Alert>}
          <p className="muted">
            {s.sales.count} ventas por {formatMoney(s.sales.total)} · ticket promedio {formatMoney(s.sales.average)}
          </p>
          <div className="grid-2">
            <Card title="Movimientos" flush>
              <table className="table">
                <tbody>
                  {s.movements.map((m) => (
                    <tr key={m.id}>
                      <td className="text-sm tnum">{formatDateTime(m.occurredAt)}</td>
                      <td>
                        {MOVEMENT_LABELS[m.type] ?? m.type}
                        {(m.reason || m.reference) && <div className="subtle text-sm">{m.reference ?? m.reason}</div>}
                      </td>
                      <td className="table__money">{formatMoney(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Por forma de pago" flush>
              <div className="methods">
                {s.totalsByMethod.map((m) => (
                  <div key={m.code} className="method-row">
                    <span className="method-row__name">{m.name}</span>
                    <span className="method-row__amount">{formatMoney(m.total)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </Modal>
  );
}
