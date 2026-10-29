import { useEffect, useState } from 'react';
import { ApiError, api, type StoreSettings } from '@pos/lib/api';
import { setSettings } from '@pos/lib/settings';
import { Alert, Button, Card, Field, PageHeader, Segmented, TextInput } from '@pos/ui';
import type { ScreenProps } from '../App';
import { useLoad } from '../lib/util';

/**
 * Configuración de la tienda.
 *
 * Tres bloques: los datos del negocio (encabezado del ticket), cómo se
 * imprime el ticket y las reglas de venta. Quien no tiene `settings.manage`
 * la ve, pero no la puede cambiar.
 */
export function SettingsScreen({ user }: ScreenProps) {
  const loaded = useLoad(() => api.getSettings(), []);
  const [draft, setDraft] = useState<StoreSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canEdit = user.permissions.includes('settings.manage');

  useEffect(() => {
    if (loaded.data) setDraft(loaded.data);
  }, [loaded.data]);

  if (loaded.error) {
    return (
      <div className="page">
        <Alert>{loaded.error}</Alert>
      </div>
    );
  }
  if (!draft) return <div className="page"><p className="subtle">Cargando…</p></div>;

  const set = <K extends keyof StoreSettings>(key: K, value: StoreSettings[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSaved(false);
  };

  const text = (key: keyof StoreSettings, label: string, hint?: string, max = 160) => (
    <Field label={label} htmlFor={`set-${key}`} hint={hint}>
      <TextInput
        id={`set-${key}`}
        value={String(draft[key])}
        maxLength={max}
        disabled={!canEdit}
        onChange={(event) => set(key, event.target.value as never)}
      />
    </Field>
  );

  const toggle = (key: keyof StoreSettings, label: string, hint: string) => (
    <label className="check">
      <input
        type="checkbox"
        checked={Boolean(draft[key])}
        disabled={!canEdit}
        onChange={(event) => set(key, event.target.checked as never)}
      />
      <span>
        <strong>{label}</strong>
        <span className="subtle text-sm"> — {hint}</span>
      </span>
    </label>
  );

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveSettings(draft);
      setDraft(next);
      setSettings(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la configuración');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Configuración"
        subtitle="Datos del negocio, ticket y reglas de venta."
        actions={
          canEdit && (
            <Button variant="primary" icon="check" disabled={busy} onClick={save}>
              {busy ? 'Guardando…' : 'Guardar cambios'}
            </Button>
          )
        }
      />
      {!canEdit && <Alert tone="warning">Puedes consultar la configuración, pero cambiarla requiere el permiso de administrar la configuración.</Alert>}
      {error && <Alert>{error}</Alert>}
      {saved && <p className="flag flag--positive">Configuración guardada</p>}

      <div className="grid-2">
        <Card title="Datos del negocio">
          <div className="stack">
            {text('business.name', 'Nombre comercial', 'Sale en grande arriba del ticket.', 120)}
            {text('business.legalName', 'Razón social')}
            {text('business.rfc', 'RFC', undefined, 13)}
            {text('business.address', 'Dirección', undefined, 300)}
            <div className="row-2">
              {text('business.phone', 'Teléfono', undefined, 40)}
              {text('business.email', 'Correo')}
            </div>
          </div>
        </Card>

        <Card title="Ticket">
          <div className="stack">
            <Field label="Ancho del papel" htmlFor="set-paper" hint="Cada caja puede fijar el suyo en Corte.">
              <Segmented
                label="Ancho del papel"
                value={draft['ticket.paper']}
                disabled={!canEdit}
                options={[
                  { value: '58', label: '58 mm' },
                  { value: '80', label: '80 mm' },
                ]}
                onChange={(value) => set('ticket.paper', value)}
              />
            </Field>
            <Field label="Encabezado (texto libre)" htmlFor="set-header" hint="Una línea por renglón: horario, sucursal, redes…">
              <textarea
                id="set-header"
                className="input textarea"
                rows={3}
                maxLength={400}
                disabled={!canEdit}
                value={draft['ticket.header']}
                onChange={(event) => set('ticket.header', event.target.value)}
              />
            </Field>
            <Field label="Pie del ticket" htmlFor="set-footer" hint="Agradecimiento, política de cambios…">
              <textarea
                id="set-footer"
                className="input textarea"
                rows={3}
                maxLength={400}
                disabled={!canEdit}
                value={draft['ticket.footer']}
                onChange={(event) => set('ticket.footer', event.target.value)}
              />
            </Field>
            {toggle('ticket.showCashier', 'Mostrar quién atendió', 'nombre del cajero')}
            {toggle('ticket.showCustomer', 'Mostrar el cliente', 'nombre y RFC')}
            {toggle('ticket.showSku', 'Mostrar el código', 'SKU antes de la descripción')}
            {toggle('ticket.showSavings', 'Mostrar el ahorro', 'suma de descuentos')}
            {toggle('ticket.autoPrint', 'Imprimir al cobrar', 'sin preguntar')}
            <Field label="Copias por venta" htmlFor="set-copies">
              <Segmented
                label="Copias"
                value={String(draft['ticket.copies'])}
                disabled={!canEdit}
                options={[
                  { value: '1', label: '1' },
                  { value: '2', label: '2' },
                  { value: '3', label: '3' },
                ]}
                onChange={(value) => set('ticket.copies', Number(value))}
              />
            </Field>
          </div>
        </Card>
      </div>

      <Card title="Ventas">
        <div className="stack">
          {toggle(
            'sales.allowNegativeStock',
            'Vender sin existencia',
            'si el sistema dice 0 y el artículo está en el mostrador, se vende y el inventario queda en negativo',
          )}
          {toggle(
            'sales.confirmRemove',
            'Confirmar al quitar artículos',
            'pide confirmación antes de borrar un renglón del ticket (el último siempre la pide)',
          )}
          <p className="subtle text-sm">
            Los precios de mayoreo (F11) salen de la lista de precios «Mayoreo». Captúralos al dar de alta cada
            producto o en Listas de precios.
          </p>
        </div>
      </Card>
    </div>
  );
}
