import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Las variables viven en la raíz del monorepo: un solo .env para todo.
  const env = loadEnv(mode, path.resolve(__dirname, '..', '..'), 'VITE_');
  return {
    plugins: [react()],
    resolve: {
      /**
       * El panel reutiliza el sistema de diseño y el cliente del API del POS
       * en vez de copiarlos: una sola fuente para botones, tablas y llamadas.
       * `dedupe` asegura UNA sola copia de React aunque los archivos vengan
       * de otra aplicación del monorepo.
       */
      alias: { '@pos': path.resolve(__dirname, '..', 'pos', 'src') },
      dedupe: ['react', 'react-dom'],
    },
    server: { port: 5173, strictPort: true },
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(
        env.VITE_API_URL ?? 'http://localhost:3100/api/v1',
      ),
    },
  };
});
