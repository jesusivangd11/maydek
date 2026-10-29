import path from 'node:path';
import { config as loadEnv } from 'dotenv';

/**
 * Pruebas de integración: PostgreSQL REAL.
 *
 * Requieren `docker compose up -d postgres` y la base `punto_venta_test`
 * migrada. Si no hay conexión, las pruebas fallan con un mensaje que lo dice
 * en vez de pasar en silencio contra un simulador.
 */
process.env.NODE_ENV = 'test';
const ROOT = path.resolve(__dirname, '..', '..', '..');
loadEnv({ path: path.join(ROOT, '.env.test'), override: true, quiet: true });
