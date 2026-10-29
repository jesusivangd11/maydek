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

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activo',
  SUSPENDED: 'Suspendido',
  ARCHIVED: 'Archivado',
};

export function UsersScreen({ user }: ScreenProps) {
  const users = useLoad(() => api.listUsers(), []);
  const roles = useLoad(() => api.listRoles(), []);
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const canManage = can(user.permissions, 'user.manage');

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
                  <td className="muted">{u.email}</td>
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
    </div>
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
  const [email, setEmail] = useState(target?.email ?? '');
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
        await api.updateUser(target.id, { name, phone: phone || undefined });
        await api.setUserRoles(target.id, selected);
      } else {
        await api.createUser({
          name,
          email,
          password,
          pin: pin || undefined,
          phone: phone || undefined,
          roleCodes: selected,
          mustChangePassword: true,
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

  const invalid = name.trim().length < 2 || selected.length === 0 || (!target && (!email.includes('@') || password.length < 10));

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
        <Field label="Correo" htmlFor="u-email">
          <TextInput id="u-email" type="email" disabled={Boolean(target)} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Teléfono" htmlFor="u-phone">
          <TextInput id="u-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        {!target && (
          <>
            <Field label="Contraseña inicial" htmlFor="u-pass" hint="Mínimo 10 caracteres. Se le pedirá cambiarla al entrar.">
              <TextInput id="u-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="PIN de autorización (opcional)" htmlFor="u-pin" hint="4 a 8 dígitos, para supervisores.">
              <TextInput id="u-pin" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </>
        )}
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
      {self && <p className="field__hint">No puedes quitarte el rol de administrador ni desactivarte a ti mismo.</p>}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
