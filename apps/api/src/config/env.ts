import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

/**
 * Configuración validada al arrancar.
 *
 * Si falta una variable obligatoria o tiene un valor inválido, el proceso NO
 * inicia. Es deliberado: mejor fallar al desplegar, con un mensaje que dice
 * exactamente qué falta, que fallar a media operación con la caja abierta.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

/** Carga el `.env` de la raíz del monorepo. Un solo archivo, sin duplicados. */
export function loadEnvironment(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  for (const file of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env']) {
    loadEnv({ path: path.join(ROOT, file), override: false, quiet: true });
  }
}

const durationRegex = /^\d+(ms|s|m|h|d)$/;

/** Valores de ejemplo que jamás deben llegar a producción. */
const PLACEHOLDER_SECRETS = [
  'desarrollo_cambia_este_secreto_de_acceso_min_32_chars',
  'desarrollo_cambia_este_secreto_de_refresco_min_32_chars',
  'ZGVzYXJyb2xsby1jYW1iaWEtZXN0YS1jbGF2ZS0zMmI=',
];

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TZ: z.string().default('UTC'),

    DATABASE_URL: z.string().url('DATABASE_URL debe ser una URL de conexión válida'),
    DATABASE_MIGRATION_URL: z.string().url().optional(),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_PREFIX: z.string().default('api'),
    API_URL: z.string().url().default('http://localhost:3000'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET debe tener al menos 32 caracteres'),
    JWT_ACCESS_TTL: z.string().regex(durationRegex).default('15m'),
    JWT_REFRESH_TTL: z.string().regex(durationRegex).default('30d'),
    POS_SESSION_TTL: z.string().regex(durationRegex).default('12h'),

    AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(5),
    AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

    ENCRYPTION_KEY: z
      .string()
      .refine(
        (v) => Buffer.from(v, 'base64').length === 32,
        'ENCRYPTION_KEY debe ser 32 bytes en base64. Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      ),

    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),

    THROTTLE_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
    THROTTLE_LIMIT: z.coerce.number().int().min(1).default(300),
    THROTTLE_AUTH_LIMIT: z.coerce.number().int().min(1).default(5),

    OUTBOX_ENABLED: booleanish.default('true'),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanish.default('false'),

    /**
     * Aplicación de escritorio: el mismo proceso sirve el POS y el panel desde
     * esta carpeta (misma origen que el API, sin CORS). Vacío en servidor.
     */
    PV_STATIC_DIR: z.string().optional(),
    API_HOST: z.string().default('0.0.0.0'),
    /**
     * Cookie de refresco con `Secure`. Por omisión, solo en producción. La app
     * de escritorio la apaga: las cajas de la red local entran por http://IP,
     * y el navegador descarta una cookie `Secure` que llega sin https.
     */
    COOKIE_SECURE: booleanish.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // En producción, los secretos de ejemplo son un error fatal, no un aviso.
    for (const [key, value] of [
      ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
      ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
      ['ENCRYPTION_KEY', env.ENCRYPTION_KEY],
    ] as const) {
      if (PLACEHOLDER_SECRETS.includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} conserva el valor de ejemplo. Genera uno único antes de desplegar a producción.`,
        });
      }
    }

    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message:
          'Los secretos de acceso y de refresco deben ser distintos: si comparten valor, un token de acceso robado sirve como token de refresco.',
      });
    }

    if (env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS no puede estar vacío en producción.',
      });
    }

    if (env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS no admite "*": el API usa credenciales.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  · ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      'Configuración de entorno inválida. El API no puede arrancar.\n\n' +
        detail +
        '\n\nRevisa tu archivo .env (parte de .env.example).\n',
    );
  }

  return result.data;
}

export function env(): Env {
  if (!cached) {
    loadEnvironment();
    cached = validateEnv();
  }
  return cached;
}

/** Solo para pruebas: descarta la configuración memorizada. */
export function resetEnvCache(): void {
  cached = undefined;
}
