import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

/**
 * Sitio estático de varias páginas: inicio, aviso de privacidad y términos.
 * El build deja HTML, CSS y JS planos que se suben a cualquier hosting.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..', '..'), 'VITE_');
  return {
    server: { port: 5175, strictPort: true },
    define: {
      // En Vercel no hay API (vive en la computadora de la tienda): sin
      // VITE_API_URL explícita, el formulario de soporte se envía por correo.
      'import.meta.env.VITE_API_URL': JSON.stringify(
        env.VITE_API_URL ?? (process.env.VERCEL ? '' : 'http://localhost:3100/api/v1'),
      ),
      'import.meta.env.VITE_POS_URL': JSON.stringify(env.VITE_POS_URL ?? 'http://localhost:5174'),
      'import.meta.env.VITE_ADMIN_URL': JSON.stringify(env.VITE_ADMIN_URL ?? 'http://localhost:5173'),
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
          privacidad: path.resolve(__dirname, 'privacidad.html'),
          terminos: path.resolve(__dirname, 'terminos.html'),
        },
      },
    },
  };
});
