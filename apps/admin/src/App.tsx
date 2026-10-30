import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, setAccessToken, type SessionUser } from '@pos/lib/api';
import { Alert, Button, Field, Icon, TextInput, type IconName } from '@pos/ui';
import { CashSessionsScreen } from './screens/CashSessions';
import { CustomersScreen } from './screens/Customers';
import { DashboardScreen } from './screens/Dashboard';
import { InventoryScreen } from './screens/Inventory';
import { PriceListsScreen } from './screens/PriceLists';
import { ProductsScreen } from './screens/Products';
import { PurchasesScreen } from './screens/Purchases';
import { ReportsScreen } from './screens/Reports';
import { SettingsScreen } from './screens/Settings';
import { SupportScreen } from './screens/Support';
import { UsersScreen } from './screens/Users';

/**
 * Panel de administración.
 *
 * La trastienda del sistema: catálogo, inventario, clientes, compras,
 * precios, cortes, usuarios, reportes y soporte. Comparte el sistema de
 * diseño y el cliente del API con el punto de venta: el mismo botón, la misma
 * tabla, el mismo error en español.
 *
 * El menú solo muestra lo que el usuario puede usar. Es comodidad, no
 * seguridad: cada endpoint vuelve a comprobar el permiso en el servidor.
 *
 * La sección vive en el hash de la URL (`#/productos`) para que recargar la
 * página o compartir el enlace deje a la persona donde estaba.
 */

export interface ScreenProps {
  user: SessionUser;
}

interface Section {
  id: string;
  label: string;
  icon: IconName;
  permission: string;
  render: (props: ScreenProps) => ReactNode;
}

const SECTIONS: Section[] = [
  { id: 'tablero', label: 'Tablero', icon: 'chart', permission: 'report.sales', render: (p) => <DashboardScreen {...p} /> },
  { id: 'productos', label: 'Productos', icon: 'box', permission: 'product.view', render: (p) => <ProductsScreen {...p} /> },
  { id: 'inventario', label: 'Inventario', icon: 'list', permission: 'inventory.view', render: (p) => <InventoryScreen {...p} /> },
  { id: 'clientes', label: 'Clientes', icon: 'users', permission: 'customer.view', render: (p) => <CustomersScreen {...p} /> },
  { id: 'compras', label: 'Compras', icon: 'truck', permission: 'purchase.view', render: (p) => <PurchasesScreen {...p} /> },
  { id: 'precios', label: 'Listas de precios', icon: 'tag', permission: 'pricing.view', render: (p) => <PriceListsScreen {...p} /> },
  { id: 'reportes', label: 'Reportes', icon: 'chart', permission: 'report.sales', render: (p) => <ReportsScreen {...p} /> },
  { id: 'cortes', label: 'Cortes de caja', icon: 'cash', permission: 'cash.report.z', render: (p) => <CashSessionsScreen {...p} /> },
  { id: 'usuarios', label: 'Usuarios', icon: 'user', permission: 'user.view', render: (p) => <UsersScreen {...p} /> },
  { id: 'configuracion', label: 'Configuración', icon: 'settings', permission: 'settings.view', render: (p) => <SettingsScreen {...p} /> },
  { id: 'soporte', label: 'Soporte', icon: 'help', permission: 'support.manage', render: (p) => <SupportScreen {...p} /> },
];

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrador',
  MANAGER: 'Gerente',
  CASHIER: 'Cajero',
  WAREHOUSE: 'Almacén',
  SALES: 'Ventas',
  READONLY: 'Solo lectura',
};

const POS_URL = import.meta.env.VITE_POS_URL ?? 'http://localhost:5174';

/** Logotipos de Maydek en `public/brand`, relativos a la base del panel. */
const BRAND_DIR = `${import.meta.env.BASE_URL}brand/`;

function currentHash(): string {
  return window.location.hash.replace(/^#\/?/, '');
}

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState(currentHash());

  useEffect(() => {
    api
      .refresh()
      .then((result) => {
        setAccessToken(result.accessToken);
        setUser(result.user);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    const onHash = () => setRoute(currentHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const result = await api.login(username, password);
      setAccessToken(result.accessToken);
      setUser(result.user);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor. ¿Está encendido?',
      );
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setAccessToken(null);
    setUser(null);
  }, []);

  if (loading) {
    return (
      <main className="loading-screen">
        <span className="spinner" />
        <p className="subtle">Cargando…</p>
      </main>
    );
  }

  if (!user) return <AdminLogin onSubmit={login} error={error} />;

  const visible = SECTIONS.filter((s) => user.permissions.includes(s.permission));
  const active = visible.find((s) => s.id === route) ?? visible[0];

  return (
    <div className="admin">
      <aside className="admin__nav on-navy">
        <div className="admin__brand">
          <img className="admin__logo" src={`${BRAND_DIR}maydek-lockup.png`} alt="Maydek" />
          <span className="brand__sub">Administración</span>
        </div>

        <nav aria-label="Secciones" className="admin__menu">
          {visible.map((section) => (
            <a
              key={section.id}
              href={`#/${section.id}`}
              className="admin__link"
              aria-current={active?.id === section.id ? 'page' : undefined}
            >
              <Icon name={section.icon} size={18} />
              {section.label}
            </a>
          ))}
        </nav>

        <div className="admin__foot">
          <a className="btn btn--secondary btn--block" href={POS_URL} target="_blank" rel="noreferrer">
            <Icon name="cash" size={18} /> Abrir punto de venta
          </a>
          <div className="who admin__who">
            <span className="who__name">{user.name}</span>
            <span className="who__role">
              {user.roles.map((role) => ROLE_LABELS[role] ?? role).join(' · ')}
            </span>
          </div>
          <Button variant="subtle" icon="logout" block onClick={logout}>
            Cerrar sesión
          </Button>
        </div>
      </aside>

      <main className="admin__content">
        {active ? (
          <div key={active.id}>{active.render({ user })}</div>
        ) : (
          <div className="page">
            <Alert tone="warning">
              Tu usuario no tiene acceso a ninguna sección del panel. Pide a un administrador que te
              asigne un rol.
            </Alert>
          </div>
        )}
      </main>
    </div>
  );
}

function AdminLogin({
  onSubmit,
  error,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
  error: string | null;
}) {
  // Se recuerda el último usuario en este equipo (nunca la clave).
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem('pv.admin.lastUser') ?? '';
    } catch {
      return '';
    }
  });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <main className="login-screen">
      <form
        className="login"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            localStorage.setItem('pv.admin.lastUser', username.trim().toLowerCase());
          } catch {
            // Sin almacenamiento: solo se pierde la comodidad.
          }
          setBusy(true);
          await onSubmit(username, password);
          setBusy(false);
        }}
      >
        <div className="login__brand on-navy">
          <img className="login__logo" src={`${BRAND_DIR}maydek-logo.png`} alt="Maydek · Punto de venta" />
        </div>
        <div className="login__head">
          <span className="login__title">Administración</span>
          <span className="login__hint">Inventario, precios, compras, clientes y reportes.</span>
        </div>

        <div className="login__form">
          <Field label="Usuario" htmlFor="username">
            <TextInput
              id="username"
              large
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              autoFocus={!username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="PIN o contraseña" htmlFor="password">
            <TextInput
              id="password"
              type="password"
              large
              autoFocus={Boolean(username)}
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" variant="primary" size="xl" disabled={!password || busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </Button>
        </div>
      </form>
    </main>
  );
}
