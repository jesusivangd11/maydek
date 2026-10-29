import { useCallback, useEffect, useState } from 'react';
import { CashPanel } from './components/CashPanel';
import { PosScreen } from './components/PosScreen';
import { SalesHistory } from './components/SalesHistory';
import { ApiError, api, setAccessToken, type CashSession, type SessionUser } from './lib/api';
import { formatMoney } from './lib/format';
import { Alert, Badge, Button, Field, TextInput } from './ui';

/**
 * Punto de venta.
 *
 * Tres vistas y nada más: vender, caja y ventas. Un POS con menús anidados es
 * un POS lento, y detrás de un mostrador la velocidad es la característica.
 *
 * Los permisos que se consultan aquí solo deciden qué se PINTA. Quien manda es
 * el servidor: cada endpoint verifica el permiso otra vez, así que ocultar un
 * botón es comodidad, no seguridad.
 */

type View = 'pos' | 'cash' | 'sales';

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
  const [view, setView] = useState<View>('pos');
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
        await refreshCash();
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
        await refreshCash();
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
    setView('pos');
  }, []);

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

  const sections: { id: View; label: string; visible: boolean }[] = [
    { id: 'pos', label: 'Vender', visible: true },
    { id: 'cash', label: 'Caja', visible: can('cash.open') || can('cash.report.x') },
    { id: 'sales', label: 'Ventas', visible: can('sale.view') },
  ];

  return (
    <div className="shell">
      {/* ── Navegación principal ──────────────────────────────────────────
          Identidad, secciones y contexto de trabajo. El estado de caja vive
          aquí, y no dentro de Caja, porque condiciona todo lo demás: sin
          sesión abierta no se puede cobrar, y eso hay que verlo desde
          cualquier pantalla sin cambiar de sección. */}
      <header className="topbar on-navy">
        <div className="topbar__left">
          <div className="brand">
            <img className="brand__logo" src={`${BRAND_DIR}maydek-lockup.png`} alt="Maydek" />
            <img className="brand__symbol" src={`${BRAND_DIR}maydek-mark.png`} alt="Maydek" />
            <span className="brand__name">
              <span className="brand__sub">Caja</span>
            </span>
          </div>

          <nav className="nav" aria-label="Secciones">
            {sections
              .filter((section) => section.visible)
              .map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="nav__item"
                  aria-current={view === section.id ? 'page' : undefined}
                  onClick={() => {
                    setView(section.id);
                    if (section.id === 'cash') void refreshCash();
                  }}
                >
                  {section.label}
                </button>
              ))}
          </nav>
        </div>

        <div className="topbar__right">
          {!online && (
            <Badge tone="warning" large title="Se muestra el último catálogo consultado. Para cobrar hace falta conexión.">
              Sin conexión
            </Badge>
          )}
          {cashSession ? (
            <Badge tone="positive" large title={`Sesión ${cashSession.folio}`}>
              Caja abierta
              {/* En pantallas estrechas el importe se retira antes que el
                  estado: saber si la caja está abierta importa más que saber
                  cuánto lleva, y el dato completo sigue en la sección Caja. */}
              <span className="badge__detail">· {formatMoney(cashSession.expectedCash)}</span>
            </Badge>
          ) : (
            <Badge tone="danger" large>
              Caja cerrada
            </Badge>
          )}

          <span className="topbar__divider" aria-hidden="true" />

          <span className="who">
            <span className="who__name">{user.name}</span>
            <span className="who__role">
              {user.roles.map((role) => ROLE_LABELS[role] ?? role).join(' · ')}
            </span>
          </span>

          <Button variant="subtle" icon="logout" onClick={logout}>
            Salir
          </Button>
        </div>
      </header>

      <main className="content">
        {view === 'pos' && (
          <PosScreen
            permissions={user.permissions}
            hasOpenCashSession={cashSession !== null}
            onSaleCompleted={() => void refreshCash()}
            onViewSale={(saleId) => {
              setFocusSaleId(saleId);
              setView('sales');
            }}
          />
        )}
        {view === 'cash' && (
          <CashPanel
            session={cashSession}
            canClose={can('cash.close')}
            onChanged={() => void refreshCash()}
          />
        )}
        {view === 'sales' && (
          <SalesHistory
            permissions={user.permissions}
            initialSaleId={focusSaleId}
            onOpened={() => setFocusSaleId(null)}
          />
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
