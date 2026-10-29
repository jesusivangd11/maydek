import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

/**
 * Tipografía autohospedada.
 *
 * Se empaqueta con la aplicación en vez de pedirla a un CDN: una tienda puede
 * quedarse sin internet en mitad de un turno, y la caja no puede quedarse sin
 * tipografía ni esperar a una petición externa para pintar el primer precio.
 *
 * Plex trae cifras tabulares de verdad, que es lo que hace que una columna de
 * importes no baile al cambiar de dígito.
 */
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';

/**
 * Hojas en cascada, de lo general a lo concreto:
 *   tokens  → los valores del diseño, y nada más.
 *   base    → reinicio y elementos de documento.
 *   ui      → componentes reutilizables.
 *   screens → composición de Vender, Caja y Ventas.
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/screens.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * Instalable y con modo sin conexión de lectura (ver `public/sw.js`).
 *
 * Solo en la compilación de producción: en desarrollo el service worker
 * guardaría en caché los módulos de Vite y escondería los cambios recientes.
 * Tampoco en la app de escritorio: ahí la base está en el mismo equipo, y una
 * caché vieja solo escondería la versión nueva después de actualizar.
 */
if (import.meta.env.PROD && import.meta.env.VITE_TARGET !== 'desktop' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
