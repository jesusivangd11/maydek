import { useState } from 'react';
import { api, type LicenseStatus } from '@pos/lib/api';
import { formatDateTime } from '@pos/lib/format';
import { Alert, Badge, Button, Card, Field, PageHeader, type Tone } from '@pos/ui';
import type { ScreenProps } from '../App';
import { errorText, useLoad } from '../lib/util';

/**
 * Licencia.
 *
 * Muestra el estado (prueba, vigente, vencida), el plan y sus límites, y
 * permite pegar la licencia que entrega soporte. El «código de instalación»
 * identifica este equipo: con él se puede emitir una licencia atada a él.
 */

const PLAN: Record<string, string> = { BASICO: 'Básico', PROFESIONAL: 'Profesional', EMPRESARIAL: 'Empresarial' };

const STATE: Record<LicenseStatus['state'], { label: string; tone: Tone }> = {
  LICENSED: { label: 'Licencia vigente', tone: 'positive' },
  TRIAL: { label: 'Periodo de prueba', tone: 'warning' },
  TRIAL_EXPIRED: { label: 'Prueba terminada', tone: 'danger' },
  EXPIRED: { label: 'Licencia vencida', tone: 'danger' },
};

const limit = (value: number | null) => (value === null ? 'Sin límite' : String(value));

export function LicenseScreen({ user }: ScreenProps) {
  const license = useLoad(() => api.getLicense(), []);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const canEdit = user.permissions.includes('settings.manage');
  const s = license.data;

  const activate = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      license.setData(await api.activateLicense(token));
      setToken('');
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Licencia" subtitle="Estado de tu licencia y activación." />

      {license.error && <Alert>{license.error}</Alert>}
      {!s && !license.error && <p className="subtle">Cargando…</p>}

      {s && (
        <>
          {!s.canSell && (
            <Alert>
              {s.state === 'EXPIRED' ? 'La licencia venció' : 'Terminó el periodo de prueba'}: no se pueden registrar
              ventas nuevas hasta activar una licencia. Tu información, reportes y respaldos siguen disponibles.
            </Alert>
          )}
          {s.problem && <Alert tone="warning">{s.problem}</Alert>}

          <Card title="Estado">
            <p>
              <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
            </p>
            <dl className="kv">
              {s.licensee && (
                <>
                  <dt>Licenciado a</dt>
                  <dd>{s.licensee}</dd>
                </>
              )}
              {s.plan && (
                <>
                  <dt>Plan</dt>
                  <dd>{PLAN[s.plan]}</dd>
                </>
              )}
              {s.licenseId && (
                <>
                  <dt>Folio</dt>
                  <dd>{s.licenseId}</dd>
                </>
              )}
              <dt>Vigencia</dt>
              <dd>
                {s.kind === 'PERMANENT'
                  ? 'Permanente: no vence'
                  : `${s.state === 'TRIAL' || s.state === 'LICENSED' ? 'Hasta' : 'Terminó el'} ${formatDateTime(s.expiresAt ?? '')}${
                      s.daysLeft !== null && s.canSell ? ` (${s.daysLeft} días)` : ''
                    }`}
              </dd>
              <dt>Código de instalación</dt>
              <dd>
                <code>{s.installationCode}</code>
              </dd>
            </dl>
          </Card>

          {s.plan && (
            <Card title="Lo que incluye tu plan">
              <dl className="kv">
                <dt>Cajas</dt>
                <dd>{limit(s.limits.terminals)}</dd>
                <dt>Usuarios</dt>
                <dd>{limit(s.limits.users)}</dd>
                <dt>Productos</dt>
                <dd>{limit(s.limits.products)}</dd>
              </dl>
            </Card>
          )}

          {canEdit ? (
            <Card title={s.state === 'LICENSED' ? 'Cambiar de licencia' : 'Activar una licencia'}>
              <Field
                label="Licencia"
                htmlFor="license-token"
                hint="Pega aquí el texto que te entregó soporte. Empieza con MAYDEK1."
              >
                <textarea
                  id="license-token"
                  className="input textarea"
                  rows={4}
                  value={token}
                  spellCheck={false}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setError(null);
                    setDone(false);
                  }}
                />
              </Field>
              {error && <Alert>{error}</Alert>}
              {done && <p className="subtle">✓ Licencia activada. Ya puedes seguir trabajando.</p>}
              <Button onClick={activate} disabled={busy || token.trim().length < 20}>
                {busy ? 'Verificando…' : 'Activar licencia'}
              </Button>
            </Card>
          ) : (
            <p className="subtle">Solo un administrador puede activar una licencia.</p>
          )}
        </>
      )}
    </div>
  );
}
