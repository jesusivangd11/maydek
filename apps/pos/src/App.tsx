import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CustomersScreen } from '@admin/screens/Customers';
import { InventoryScreen } from '@admin/screens/Inventory';
import { ProductsScreen } from '@admin/screens/Products';
import { ReportsScreen } from '@admin/screens/Reports';
import { SettingsScreen } from '@admin/screens/Settings';
import { UsersScreen } from '@admin/screens/Users';
import { CashPanel } from './components/CashPanel';
import { SalesHistory } from './components/SalesHistory';
import { VentaScreen } from './components/VentaScreen';
import { ApiError, api, setAccessToken, type CashSession, type SessionUser } from './lib/api';
import { formatMoney } from './lib/format';
import { loadSettings } from './lib/settings';
import { Alert, Button, Field, TextInput } from './ui';

/**
 * Punto de venta.
 *
 * Una sola ventana con la barra de módulos arriba, como la conoce cualquier
 * cajero: F1 Ventas, F2 Clientes, F3 Productos, F4 Inventario, y después
 * Reportes, Usuarios, Configuración y Corte. La venta en curso nunca se
 * pierde al cambiar de módulo: la pantalla de venta sigue montada debajo.
 *
 * Los permisos que se consultan aquí solo deciden qué se PINTA. Quien manda es
 * el servidor: cada endpoint verifica el permiso otra vez, así que ocultar un
 * botón es comodidad, no seguridad.
 */

type View =
  | 'venta'
  | 'clientes'
  | 'productos'
  | 'inventario'
  | 'reportes'
  | 'usuarios'
  | 'config'
  | 'corte'
  | 'historial';

interface ModuleDef {
  id: View;
  label: string;
  key?: string;
  visible: boolean;
}

const DESKTOP = import.meta.env.VITE_TARGET === 'desktop';

/** Nombres de rol para la barra superior. Los códigos son del servidor. */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrador',
  MANAGER: 'Gerente',
  CASHIER: 'Cajero',
  WAREHOUSE: 'Almacén',
  SALES: 'Ventas',
  READONLY: 'Solo lectura',
};

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('venta');
  const [cashSession, setCashSession] = useState<CashSession | null>(null);
  /** Venta que el historial debe abrir al entrar, tras pulsar "Ver venta". */
  const [focusSaleId, setFocusSaleId] = useState<string | null>(null);
  // En la app de escritorio el servidor está en el mismo equipo (o en la red
  // de la tienda): quedarse sin internet no impide cobrar.
  const [online, setOnline] = useState(() => DESKTOP || navigator.onLine);

  useEffect(() => {
    if (DESKTOP) return;
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const refreshCash = useCallback(async () => {
    try {
      setCashSession(await api.currentCashSession());
    } catch {
      // Un cajero sin permiso de corte sigue pudiendo vender: no es un error
      // que deba interrumpir la pantalla.
      setCashSession(null);
    }
  }, []);

  useEffect(() => {
    api
      .refresh()
      .then(async (result) => {
        setAccessToken(result.accessToken);
        setUser(result.user);
        await Promise.all([refreshCash(), loadSettings()]);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [refreshCash]);

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const result = await api.login(email, password);
        setAccessToken(result.accessToken);
        setUser(result.user);
        await Promise.all([refreshCash(), loadSettings()]);
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'No se pudo conectar con el servidor. ¿Está corriendo el API?',
        );
      }
    },
    [refreshCash],
  );

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    setCashSession(null);
    setView('venta');
  }, []);

  // F1–F4: los módulos principales, desde cualquier pantalla.
  useEffect(() => {
    if (!user) return;
    const byKey: Record<string, View> = { F1: 'venta', F2: 'clientes', F3: 'productos', F4: 'inventario' };
    function onKey(event: KeyboardEvent) {
      const target = byKey[event.key];
      if (!target) return;
      event.preventDefault();
      // Con un diálogo abierto, la tecla no saca a nadie de lo que está haciendo.
      if (document.querySelector('.overlay')) return;
      setView(target);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);

  if (loading) {
    return (
      <main className="loading-screen">
        <span className="spinner" />
        <p className="subtle">Cargando…</p>
      </main>
    );
  }

  if (!user) return <PosLogin onSubmit={login} error={error} />;

  const can = (permission: string) => user.permissions.includes(permission);

  const modules: ModuleDef[] = [
    { id: 'venta', label: 'Ventas', key: 'F1', visible: true },
    { id: 'clientes', label: 'Clientes', key: 'F2', visible: can('customer.view') },
    { id: 'productos', label: 'Productos', key: 'F3', visible: can('product.view') },
    { id: 'inventario', label: 'Inventario', key: 'F4', visible: can('inventory.view') },
    { id: 'reportes', label: 'Reportes', visible: can('report.sales') || can('report.inventory') },
    { id: 'usuarios', label: 'Usuarios', visible: can('user.view') },
    { id: 'config', label: 'Configuración', visible: can('settings.view') || can('settings.manage') },
    { id: 'corte', label: 'Corte', visible: can('cash.open') || can('cash.report.x') },
  ];

  // Un módulo sin permiso no se abre aunque llegue por teclado.
  const allowed = (id: View) => id === 'historial' ? can('sale.view') : modules.find((m) => m.id === id)?.visible;
  const current: View = allowed(view) ? view : 'venta';

  const screens: Partial<Record<View, () => ReactNode>> = {
    clientes: () => <CustomersScreen user={user} />,
    productos: () => <ProductsScreen user={user} />,
    inventario: () => <InventoryScreen user={user} />,
    reportes: () => <ReportsScreen user={user} />,
    usuarios: () => <UsersScreen user={user} />,
    config: () => <SettingsScreen user={user} />,
    corte: () => (
      <CashPanel session={cashSession} canClose={can('cash.close')} onChanged={() => void refreshCash()} />
    ),
    historial: () => (
      <SalesHistory
        permissions={user.permissions}
        initialSaleId={focusSaleId}
        onOpened={() => setFocusSaleId(null)}
      />
    ),
  };

  return (
    <div className="shell">
      {/* ── Barra de módulos ──────────────────────────────────────────────
          Identidad, módulos y contexto de trabajo. El estado de caja vive
          aquí porque condiciona todo lo demás: sin caja abierta no se puede
          cobrar, y eso hay que verlo desde cualquier módulo. */}
      <header className="topbar on-navy">
        <div className="topbar__left">
          <div className="brand">
            <img className="brand__logo" src={`${BRAND_DIR}maydek-lockup.png`} alt="Maydek" />
            <img className="brand__symbol" src={`${BRAND_DIR}maydek-mark.png`} alt="Maydek" />
          </div>

          <nav className="modules" aria-label="Módulos">
            {modules
              .filter((m) => m.visible)
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="module"
                  aria-current={current === m.id ? 'page' : undefined}
                  onClick={() => {
                    setView(m.id);
                    if (m.id === 'corte') void refreshCash();
                  }}
                >
                  {m.key && <span className="module__key">{m.key}</span>}
                  {m.label}
                </button>
              ))}
            <button type="button" className="module module--exit" onClick={logout}>
              <span className="module__key">⏻</span>
              Salir
            </button>
          </nav>
        </div>

        <div className="topbar__right">
          {!online && (
            <span className="flag flag--accent" title="Se muestra el último catálogo consultado. Para cobrar hace falta conexión.">
              Sin conexión
            </span>
          )}
          {cashSession ? (
            <span className="flag flag--positive" title={`Sesión ${cashSession.folio}`}>
              Caja abierta
              <span className="badge__detail">· {formatMoney(cashSession.expectedCash)}</span>
            </span>
          ) : (
            <span className="flag flag--danger">Caja cerrada</span>
          )}

          <span className="topbar__divider" aria-hidden="true" />

          <span className="who">
            <span className="who__name">{user.name}</span>
            <span className="who__role">
              {user.roles.map((role) => ROLE_LABELS[role] ?? role).join(' · ')}
            </span>
          </span>
        </div>
      </header>

      <main className="content">
        {/* La venta queda montada aunque se abra otro módulo: el ticket a
            medias sigue ahí al volver con F1. */}
        <div hidden={current !== 'venta'} className="module-view">
          <VentaScreen
            permissions={user.permissions}
            cashSessionId={cashSession?.id ?? null}
            active={current === 'venta'}
            onSaleCompleted={() => void refreshCash()}
            onShowSales={() => setView('historial')}
          />
        </div>
        {current !== 'venta' && (
          <div key={current} className="module-view">
            {screens[current]?.()}
          </div>
        )}
      </main>
    </div>
  );
}

/**
 * Credenciales precargadas MIENTRAS SE DESARROLLA.
 *
 * Salen de `VITE_DEV_EMAIL` y `VITE_DEV_PASSWORD` del `.env` de la raíz, que
 * está fuera del repositorio. En cualquier compilación de producción vite las
 * sustituye por cadena vacía, así que estos campos salen en blanco pase lo que
 * pase: no hay forma de que una contraseña llegue a una tienda real por aquí.
 */
const DEV_EMAIL = import.meta.env.DEV ? (import.meta.env.VITE_DEV_EMAIL ?? '') : '';
const DEV_PASSWORD = import.meta.env.DEV ? (import.meta.env.VITE_DEV_PASSWORD ?? '') : '';

const LAST_EMAIL_KEY = 'pv.pos.lastEmail';

/** Logotipos de Maydek en `public/brand`, relativos a la base de la app. */
const BRAND_DIR = `${import.meta.env.BASE_URL}brand/`;

function readLastEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberEmail(email: string): void {
  try {
    localStorage.setItem(LAST_EMAIL_KEY, email.trim());
  } catch {
    // Sin almacenamiento (modo privado): solo se pierde la comodidad.
  }
}

function PosLogin({
  onSubmit,
  error,
}: {
  onSubmit: (email: string, password: string) => Promise<void>;
  error: string | null;
}) {
  // En una caja suele entrar siempre la misma persona: se recuerda el último
  // correo usado en ESTE equipo (nunca la contraseña).
  const [email, setEmail] = useState(() => DEV_EMAIL || readLastEmail());
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [busy, setBusy] = useState(false);

  return (
    <main className="login-screen">
      <form
        className="login"
        onSubmit={async (event) => {
          event.preventDefault();
          rememberEmail(email);
          setBusy(true);
          await onSubmit(email, password);
          setBusy(false);
        }}
        onKeyDown={(event) => {
          // Primero teclado: Escape limpia sin tocar el ratón.
          if (event.key === 'Escape') setPassword('');
        }}
      >
        <div className="login__brand on-navy">
          <img className="login__logo" src={`${BRAND_DIR}maydek-logo.png`} alt="Maydek · Punto de venta" />
        </div>
        <div className="login__head">
          <span className="login__title">Iniciar sesión</span>
          <span className="login__hint">Entra con tu correo y contraseña para empezar a vender.</span>
        </div>

        <div className="login__form">
          <Field label="Correo" htmlFor="email">
            <TextInput
              id="email"
              type="email"
              large
              value={email}
              autoComplete="username"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Contraseña" htmlFor="password">
            <TextInput
              id="password"
              type="password"
              large
              value={password}
              autoComplete="current-password"
              required
              // Con la contraseña ya puesta el foco sobra aquí: va al botón,
              // para que entrar sea un Enter y nada más.
              autoFocus={!DEV_PASSWORD}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {error && <Alert>{error}</Alert>}

          <Button
            type="submit"
            variant="primary"
            size="xl"
            disabled={!password || busy}
            autoFocus={Boolean(DEV_PASSWORD)}
          >
            {busy ? 'Entrando…' : 'Entrar'}
          </Button>

          {DEV_PASSWORD && (
            <p className="field__hint center">
              Credenciales de desarrollo precargadas desde <code>.env</code>. No se
              compilan en producción.
            </p>
          )}
        </div>
      </form>
    </main>
  );
}
