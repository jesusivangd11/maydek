import { useState } from 'react';
import { api, type SupportTicket } from '@pos/lib/api';
import { formatDateTime } from '@pos/lib/format';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Segmented, Select, type Tone } from '@pos/ui';
import type { ScreenProps } from '../App';
import { errorText, useLoad } from '../lib/util';

/**
 * Soporte.
 *
 * Bandeja de lo que llega desde la página web: solicitudes de soporte,
 * cotizaciones de ventas y contacto. Responder aquí deja la respuesta visible
 * para el cliente cuando consulta su folio en la web.
 */

const KIND: Record<string, string> = { SUPPORT: 'Soporte', SALES: 'Ventas', CONTACT: 'Contacto' };
const STATUS: Record<string, { label: string; tone: Tone }> = {
  OPEN: { label: 'Abierto', tone: 'danger' },
  IN_PROGRESS: { label: 'En proceso', tone: 'warning' },
  ANSWERED: { label: 'Respondido', tone: 'positive' },
  CLOSED: { label: 'Cerrado', tone: 'neutral' },
};

type Filter = 'pending' | 'all';

export function SupportScreen(_props: ScreenProps) {
  const [filter, setFilter] = useState<Filter>('pending');
  const tickets = useLoad(() => api.listTickets(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = (tickets.data ?? []).filter((t) => filter === 'all' || t.status === 'OPEN' || t.status === 'IN_PROGRESS');
  const selected = tickets.data?.find((t) => t.id === selectedId) ?? rows[0] ?? null;

  return (
    <div className="page">
      <PageHeader
        title="Soporte"
        subtitle="Solicitudes que llegan desde la página web."
        actions={
          <Segmented
            value={filter}
            onChange={setFilter}
            label="Filtro"
            options={[
              { value: 'pending', label: 'Pendientes' },
              { value: 'all', label: 'Todos' },
            ]}
          />
        }
      />
      {tickets.error && <Alert>{tickets.error}</Alert>}
      {tickets.data && rows.length === 0 && (
        <Card>
          <EmptyState icon="check" title="Sin tickets pendientes" text="Todo lo que llega desde la web aparecerá aquí." />
        </Card>
      )}
      {rows.length > 0 && (
        <div className="grid-2" style={{ gridTemplateColumns: 'minmax(260px, 0.8fr) minmax(0, 1.6fr)' }}>
          <Card flush>
            <ul className="pick-list" style={{ padding: 'var(--s-3)', maxHeight: '70dvh' }}>
              {rows.map((t) => (
                <li key={t.id}>
                  <button type="button" className="pick-list__item" aria-selected={selected?.id === t.id} onClick={() => setSelectedId(t.id)}>
                    <span className="pick-list__main">
                      <strong>{t.subject}</strong>
                      <span className="subtle text-sm">
                        {t.folio} · {t.name} · {formatDateTime(t.createdAt)}
                      </span>
                    </span>
                    <span className="pick-list__side">
                      <Badge tone={STATUS[t.status]?.tone}>{STATUS[t.status]?.label}</Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {selected && (
            <TicketView
              key={selected.id}
              ticket={selected}
              onSaved={(t) => tickets.setData((tickets.data ?? []).map((x) => (x.id === t.id ? t : x)))}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TicketView({ ticket, onSaved }: { ticket: SupportTicket; onSaved: (t: SupportTicket) => void }) {
  const [answer, setAnswer] = useState(ticket.answer ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function update(body: { status?: string; priority?: string; answer?: string }) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateTicket(ticket.id, body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <>
          {ticket.subject} <Badge dot={false}>{KIND[ticket.kind]}</Badge>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          <strong>{ticket.name}</strong> · <a href={`mailto:${ticket.email}?subject=${encodeURIComponent(`[${ticket.folio}] ${ticket.subject}`)}`}>{ticket.email}</a>
          {ticket.phone && <> · <a href={`tel:${ticket.phone}`}>{ticket.phone}</a></>}
          {ticket.company && <> · {ticket.company}</>}
          {ticket.plan && <> · plan {ticket.plan}</>}
        </p>
        <p className="subtle text-sm" style={{ margin: 0 }}>
          Folio {ticket.folio} · recibido {formatDateTime(ticket.createdAt)}
        </p>
        <pre className="ticket-msg">{ticket.message}</pre>

        <div className="form-grid">
          <Field label="Estado" htmlFor="t-status">
            <Select id="t-status" value={ticket.status} disabled={busy} onChange={(e) => update({ status: e.target.value })}>
              {Object.entries(STATUS).map(([value, s]) => (
                <option key={value} value={value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prioridad" htmlFor="t-prio">
            <Select id="t-prio" value={ticket.priority} disabled={busy} onChange={(e) => update({ priority: e.target.value })}>
              <option value="LOW">Baja</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">Alta</option>
              <option value="URGENT">Urgente</option>
            </Select>
          </Field>
        </div>

        <Field label="Respuesta (el cliente la ve al consultar su folio)" htmlFor="t-answer">
          <textarea id="t-answer" className="input textarea" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        {ticket.answeredAt && <p className="field__hint">Respondido {formatDateTime(ticket.answeredAt)}</p>}
        {error && <Alert>{error}</Alert>}
        <div className="modal__actions">
          <Button variant="primary" disabled={busy || answer.trim().length < 3 || answer === (ticket.answer ?? '')} onClick={() => update({ answer })}>
            {busy ? 'Guardando…' : 'Enviar respuesta'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
