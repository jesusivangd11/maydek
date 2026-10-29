import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Reglas del proyecto.
 *
 * Además del conjunto recomendado, aquí viven las reglas que hacen cumplir los
 * límites arquitectónicos que la documentación promete. Una regla de linter
 * que falla en CI vale más que un párrafo en un documento que nadie relee.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/generated/**',
      'apps/api/prisma/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
    },
  },

  // ── REGLAS ARQUITECTÓNICAS DEL PROYECTO ──────────────────────────────────
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      /**
       * El dinero NUNCA es un número de punto flotante.
       *
       * `parseFloat` sobre un importe es el origen de los descuadres de un
       * centavo que se acumulan durante años. Se usa Decimal (@pv/domain-rules).
       */
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'El dinero no pasa por punto flotante. Usa money() de @pv/domain-rules.',
        },
      ],

      /**
       * Un solo escritor de existencias.
       *
       * Ningún módulo fuera de `inventory` puede importar el repositorio de
       * stock: todo pasa por StockService.apply(), que bloquea, valida, escribe
       * el asiento y emite el evento en una sola transacción.
       * Ver docs/01-arquitectura.md §3.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/inventory/ledger.repository',
                '**/inventory/stock.repository',
                '**/inventory/*/ledger.repository',
              ],
              message:
                'El inventario tiene UN SOLO escritor. Usa StockService.apply() en vez de tocar el repositorio directamente (docs/01-arquitectura.md §3).',
            },
          ],
        },
      ],
    },
  },

  // Los scripts de línea de comandos sí imprimen en consola: es su interfaz.
  {
    files: [
      'apps/api/prisma/seed/**/*.ts',
      'apps/api/scripts/**/*.{ts,mjs}',
      'scripts/**/*.mjs',
    ],
    rules: { 'no-console': 'off' },
  },

  // Las pruebas necesitan libertad para construir dobles y casos límite.
  {
    files: ['**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
