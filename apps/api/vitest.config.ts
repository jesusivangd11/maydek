import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Configuración base. Los dos proyectos se definen en vitest.workspace.ts. */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
  },
});
