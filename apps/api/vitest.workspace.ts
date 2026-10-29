import { defineWorkspace } from 'vitest/config';

/**
 * Dos proyectos, a propósito:
 *
 *   unit         no toca la base. Corre en cualquier máquina, siempre.
 *   integration  exige PostgreSQL real (Docker). Un mock no tiene bloqueos de
 *                fila y aprobaría código roto — ver docs/07-concurrencia.md.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
      setupFiles: ['./test/setup-unit.ts'],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['test/integration/**/*.spec.ts'],
      setupFiles: ['./test/setup-integration.ts'],
      testTimeout: 30_000,
      hookTimeout: 60_000,
      fileParallelism: false,
    },
  },
]);
