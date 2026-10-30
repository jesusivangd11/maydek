import { useState } from 'react';
import { api, type UserRow } from '@pos/lib/api';
import { formatDateTime } from '@pos/lib/format';
import { Alert, Badge, Button, Card, Field, Modal, PageHeader, TextInput } from '@pos/ui';
import type { ScreenProps } from '../App';
import { can, errorText, useLoad } from '../lib/util';

/**
 * Usuarios y roles.
 *
 * Cada persona entra con su propio usuario: es lo que hace que la auditoría
 * diga QUIÉN canceló una venta. El PIN de 4 a 8 dígitos sirve para autorizar
 * en caja (cancelaciones, devoluciones fuera de política) sin escribir la
 * contraseña delante del cliente.
 */

/** Correo interno que el servidor inventa cuando la persona no tiene uno. */
const NO_EMAIL_SUFFIX = '@sin-correo.maydek';

/** Reglas de la clave de acceso (las mismas que valida el servidor). */
const PIN_RE = /^\d{4,12}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const validKey = (key: string) => PIN_RE.test(key) || key.length >= 8;

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspendido',
  ARCHIVED: 'Archivado',
};

export function UsersScreen({ user }: ScreenProps) {
  const users = useLoad(() => api.listUsers(), []);
  const roles = useLoad(() => api.listRoles(), []);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [privileges, setPrivileges] = useState<UserRow | null>(null);
  const canManage = can(user.permissions, 'user.manage');
  // El catálogo de permisos se consulta con role.manage.
  const canRoles = can(user.permissions, 'role.manage');

  return (
    <div className="page">
      <PageHeader
        title="Usuarios"
        subtitle="Quién entra al sistema y qué puede hacer."
        actions={
          canManage && (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Nuevo usuario
            </Button>
          )
        }
      />
      {users.error && <Alert>{users.error}</Alert>}
      {users.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Usuario</th>
                <th>Correo</th>
                <th>Roles</th>
                <th>Estado</th>
                <th>Último acceso</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                  </td>
                  <td>
                    <code>{u.username}</code>
                  </td>
                  <td className="muted">{u.email.endsWith(NO_EMAIL_SUFFIX) ? '—' : u.email}</td>
                  <td>
                    {u.roles.map((r) => (
                      <Badge key={r.code} dot={false}>
                        {r.name}
                      </Badge>
                    ))}
                  </td>
                  <td>
                    <Badge tone={u.status === 'ACTIVE' ? 'positive' : 'danger'}>{STATUS_LABEL[u.status] ?? u.status}</Badge>
                  </td>
                  <td className="muted text-sm">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</td>
                  <td className="cell-actions">
                    {canManage && (
                      <Button size="sm" variant="subtle" icon="edit" onClick={() => setEditing(u)}>
                        Editar
                      </Button>
                    )}
                    {canManage && canRoles && (
                      <Button size="sm" variant="subtle" icon="settings" onClick={() => setPrivileges(u)}>
                        Privilegios
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {roles.data && (
        <Card title="Roles del sistema">
          <div className="form-grid">
            {roles.data.map((r) => (
              <div key={r.code}>
                <strong>{r.name}</strong>
                <p className="field__hint">{r.permissions.length} permisos</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {editing && roles.data && (
        <UserDialog
          target={editing === 'new' ? null : editing}
          roles={roles.data}
          self={editing !== 'new' && editing.id === user.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void users.reload();
          }}
        />
      )}

      {privileges && (
        <PrivilegesDialog
          target={privileges}
          self={privileges.id === user.id}
          onClose={() => setPrivileges(null)}
        />
      )}
    </div>
  );
}

/**
 * Privilegios de una persona, casilla por casilla.
 *
 * Parte de lo que le da su rol; lo que se marque o desmarque aquí queda como
 * excepción solo para ella (a un cajero se le puede dejar hacer descuentos sin
 * convertirlo en gerente).
 */
function PrivilegesDialog({ target, self, onClose }: { target: UserRow; self: boolean; onClose: () => void }) {
  const catalog = useLoad(() => api.listPermissions(), []);
  const detail = useLoad(() => api.getUser(target.id), [target.id]);
  const [granted, setGranted] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current = granted ?? (detail.data ? new Set(detail.data.permissions) : null);

  async function save() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      await api.setUserPermissions(target.id, [...current]);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const flip = (code: string, on: boolean) => {
    const next = new Set(current ?? []);
    if (on) next.add(code);
    else next.delete(code);
    setGranted(next);
    setSaved(false);
  };

  return (
    <Modal
      label="Privilegios"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">Privilegios · {target.name}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          {saved && <span className="flag flag--positive">Guardado</span>}
          <Button variant="subtle" onClick={onClose}>
            Cerrar
          </Button>
          <Button variant="primary" disabled={busy || !current || !granted} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar privilegios'}
          </Button>
        </div>
      }
    >
      <p className="field__hint">
        Roles: {target.roles.map((r) => r.name).join(', ')}. Lo que cambies aquí aplica solo a esta persona y
        surte efecto en su siguiente acción.
      </p>
      {(catalog.error || detail.error) && <Alert>{catalog.error ?? detail.error}</Alert>}
      {error && <Alert>{error}</Alert>}
      {catalog.data && current && (
        <div className="perm-groups">
          {catalog.data.map((group) => (
            <fieldset key={group.group} className="perm-group">
              <legend className="field__label">{group.group}</legend>
              {group.permissions.map((p) => (
                <label key={p.code} className="check" title={p.code}>
                  <input
                    type="checkbox"
                    checked={current.has(p.code)}
                    disabled={self && p.code === 'user.manage'}
                    onChange={(e) => flip(p.code, e.target.checked)}
                  />
                  <span>
                    {p.name}
                    {p.isSensitive && <span className="flag flag--accent perm-sensitive">Sensible</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </Modal>
  );
}

function UserDialog({
  target,
  roles,
  self,
  onClose,
  onSaved,
}: {
  target: UserRow | null;
  roles: { code: string; name: string }[];
  self: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(target?.name ?? '');
  const [username, setUsername] = useState(target?.username ?? '');
  const [email, setEmail] = useState(target && !target.email.endsWith(NO_EMAIL_SUFFIX) ? target.email : '');
  const [mustChange, setMustChange] = useState(true);
  const [phone, setPhone] = useState(target?.phone ?? '');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [selected, setSelected] = useState<string[]>(target?.roles.map((r) => r.code) ?? ['CASHIER']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (target) {
        await api.updateUser(target.id, {
          name,
          username: username.trim().toLowerCase(),
          email: email.trim() || undefined,
          phone: phone || undefined,
          ...(password ? { password } : {}),
          ...(pin ? { pin } : {}),
        });
        await api.setUserRoles(target.id, selected);
      } else {
        await api.createUser({
          name,
          username: username.trim().toLowerCase(),
          email: email.trim() || undefined,
          password,
          pin: pin || undefined,
          phone: phone || undefined,
          roleCodes: selected,
          mustChangePassword: mustChange,
        });
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(status: 'ACTIVE' | 'SUSPENDED') {
    if (!target) return;
    setBusy(true);
    try {
      await api.updateUser(target.id, { status });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const invalid =
    name.trim().length < 2 ||
    selected.length === 0 ||
    !USERNAME_RE.test(username.trim().toLowerCase()) ||
    (!target && !validKey(password)) ||
    (email.trim().length > 0 && !email.includes('@')) ||
    (Boolean(target) && password.length > 0 && !validKey(password)) ||
    (pin.length > 0 && pin.length < 4);

  return (
    <Modal
      label="Usuario"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">{target ? target.name : 'Nuevo usuario'}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          {target && !self && (
            <Button variant={target.status === 'ACTIVE' ? 'danger' : 'secondary'} disabled={busy} onClick={() => toggle(target.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')}>
              {target.status === 'ACTIVE' ? 'Suspender acceso' : 'Reactivar'}
            </Button>
          )}
          <Button variant="primary" disabled={busy || invalid} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      }
    >
      <div className="form-grid">
        <Field label="Nombre" htmlFor="u-name">
          <TextInput id="u-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Usuario"
          htmlFor="u-username"
          hint="3 a 32 letras, números, punto, guion o guion bajo. Con él entra al sistema."
        >
          <TextInput
            id="u-username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
          />
        </Field>
        <Field label="Correo (opcional)" htmlFor="u-email" hint="Solo para contactarla; no sirve para entrar.">
          <TextInput id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Teléfono" htmlFor="u-phone">
          <TextInput id="u-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field
          label={target ? 'Nuevo PIN o contraseña (opcional)' : 'PIN o contraseña inicial'}
          htmlFor="u-pass"
          hint={
            target
              ? 'Déjala vacía para no cambiarla.'
              : 'PIN de 4 o más dígitos, o contraseña de 8 o más caracteres. Un PIN corto es más fácil de adivinar.'
          }
        >
          <TextInput id="u-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field
          label={target ? 'Nuevo PIN (opcional)' : 'PIN de autorización (opcional)'}
          htmlFor="u-pin"
          hint="4 a 8 dígitos, para autorizar en caja."
        >
          <TextInput id="u-pin" type="password" autoComplete="off" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <fieldset className="role-picker">
        <legend className="field__label">Roles</legend>
        {roles.map((r) => (
          <label key={r.code} className="check">
            <input
              type="checkbox"
              disabled={self && r.code === 'ADMIN'}
              checked={selected.includes(r.code)}
              onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.code] : s.filter((c) => c !== r.code)))}
            />
            {r.name}
          </label>
        ))}
      </fieldset>
      {!target && (
        <label className="check">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          Pedir que la cambie la primera vez que entre
        </label>
      )}
      {self && <p className="field__hint">No puedes quitarte el rol de administrador ni desactivarte a ti mismo.</p>}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
