import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

/**
 * El panel usa el MISMO sistema de diseño que el punto de venta: tipografía,
 * tokens, componentes y pantallas compartidas. Encima, solo lo propio del
 * panel (menú lateral, tablas de administración, gráficas).
 */
import '@pos/styles/fonts';
import '@pos/styles/tokens.css';
import '@pos/styles/base.css';
import '@pos/styles/ui.css';
import '@pos/styles/screens.css';
import './admin.css';
import '@pos/styles/venta.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
