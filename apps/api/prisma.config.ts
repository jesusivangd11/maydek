import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Las variables de entorno viven en UN SOLO archivo, en la raíz del monorepo.
 * Duplicar `.env` por paquete es la forma más rápida de que dos procesos
 * apunten a bases distintas sin que nadie se dé cuenta.
 *
 * Orden de precedencia (gana el primero que define cada variable):
 *   .env.<NODE_ENV>.local  →  .env.<NODE_ENV>  →  .env
 */
const ROOT = path.resolve(__dirname, '..', '..');
const NODE_ENV = process.env.NODE_ENV ?? 'development';

for (const file of [`.env.${NODE_ENV}.local`, `.env.${NODE_ENV}`, '.env']) {
  loadEnv({ path: path.join(ROOT, file), override: false, quiet: true });
}

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed/index.ts',
  },
});
