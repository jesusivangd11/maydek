#!/usr/bin/env node
/**
 * Espera a que PostgreSQL acepte conexiones antes de continuar.
 * Evita la carrera clásica: `docker compose up -d` devuelve el control
 * antes de que la base esté lista para recibir migraciones.
 */
import { execSync } from 'node:child_process';

const MAX_ATTEMPTS = 40;
const DELAY_MS = 1500;
const user = process.env.POSTGRES_USER || 'pv_app';
const db = process.env.POSTGRES_DB || 'punto_venta';

process.stdout.write('Esperando a PostgreSQL');

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    execSync(`docker compose exec -T postgres pg_isready -U ${user} -d ${db}`, {
      stdio: 'pipe',
    });
    console.log('\n✓ PostgreSQL está listo.');
    process.exit(0);
  } catch {
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}

console.error(
  '\n✗ PostgreSQL no respondió tras ' +
    Math.round((MAX_ATTEMPTS * DELAY_MS) / 1000) +
    ' segundos.\n' +
    '  Revisa:  docker compose logs postgres',
);
process.exit(1);
