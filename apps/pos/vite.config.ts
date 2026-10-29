import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Las variables viven en la raíz del monorepo: un solo .env para todo.
  const env = loadEnv(mode, path.resolve(__dirname, '..', '..'), 'VITE_');

  /**
   * Credenciales de conveniencia para desarrollo.
   *
   * Se compilan a cadena VACÍA en cualquier compilación de producción, así que
   * es imposible que una contraseña acabe en el paquete que se despliega,
   * aunque alguien olvide quitarlas del `.env`. Y como `.env` está fuera del
   * repositorio, tampoco viajan en el código fuente.
   */
  const isProduction = mode === 'production';

  return {
    plugins: [react()],
    resolve: {
      /**
       * La caja abre en su misma ventana los módulos de la trastienda
       * (Clientes, Productos, Inventario, Reportes, Configuración…), que viven
       * en el panel. Esas pantallas importan el sistema de diseño como `@pos`,
       * así que aquí ese alias apunta a este mismo proyecto.
       */
      alias: {
        '@pos': path.resolve(__dirname, 'src'),
        '@admin': path.resolve(__dirname, '..', 'admin', 'src'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: { port: 5174, strictPort: true },
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(
        env.VITE_API_URL ?? 'http://localhost:3000/api/v1',
      ),
      // 'desktop' cuando lo compila la app de escritorio (apps/desktop).
      'import.meta.env.VITE_TARGET': JSON.stringify(env.VITE_TARGET ?? 'web'),
      'import.meta.env.VITE_DEV_EMAIL': JSON.stringify(
        isProduction ? '' : (env.VITE_DEV_EMAIL ?? ''),
      ),
      'import.meta.env.VITE_DEV_PASSWORD': JSON.stringify(
        isProduction ? '' : (env.VITE_DEV_PASSWORD ?? ''),
      ),
    },
  };
});
