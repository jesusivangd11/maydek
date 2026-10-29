#!/usr/bin/env node
/**
 * Instalación desde cero.
 *
 *     pnpm setup
 *
 * Deja el proyecto listo para `pnpm dev` en una máquina limpia:
 *   1. Verifica requisitos (Node, pnpm, Docker)
 *   2. Crea el .env con secretos ÚNICOS generados al vuelo
 *   3. Levanta PostgreSQL y espera a que responda
 *   4. Aplica migraciones y genera el cliente Prisma
 *   5. Siembra los datos iniciales
 *
 * Es idempotente: se puede volver a ejecutar sin romper nada.
 */
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`);
const fail = (m) => console.log(`${c.red}✗${c.reset} ${m}`);
const step = (n, m) =>
  console.log(`\n${c.bold}${c.cyan}[${n}/5]${c.reset} ${c.bold}${m}${c.reset}`);

function run(command, options = {}) {
  return spawnSync(command, {
    shell: true,
    stdio: options.quiet ? 'pipe' : 'inherit',
    cwd: ROOT,
    ...options,
  });
}

function has(command) {
  try {
    execSync(`${command} --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── 1 · Requisitos ───────────────────────────────────────────────────────────
step(1, 'Verificando requisitos');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  fail(`Node ${process.versions.node} — se necesita 22 o superior.`);
  console.log(`  Descarga: ${c.cyan}https://nodejs.org${c.reset}`);
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

if (!has('pnpm')) {
  fail('pnpm no está instalado.');
  console.log(`  Instálalo con: ${c.cyan}npm install -g pnpm${c.reset}`);
  process.exit(1);
}
ok('pnpm disponible');

const dockerOk = has('docker');
if (!dockerOk) {
  fail('Docker no está instalado o no está corriendo.');
  console.log('');
  console.log('  Tienes dos caminos:');
  console.log('');
  console.log(`  ${c.bold}A) Instalar Docker Desktop${c.reset} ${c.dim}(necesita permisos de administrador)${c.reset}`);
  console.log(`     ${c.cyan}https://www.docker.com/products/docker-desktop${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}B) PostgreSQL local, sin Docker ni administrador${c.reset}`);
  console.log(`     ${c.cyan}pnpm setup:local-db${c.reset}`);
  console.log(`     ${c.dim}Descarga los binarios oficiales de PostgreSQL 17, crea el clúster${c.reset}`);
  console.log(`     ${c.dim}con los mismos roles y ajustes que docker-compose, y escribe el .env.${c.reset}`);
  console.log(`     ${c.dim}Después:  pnpm db:deploy && pnpm db:seed && pnpm dev${c.reset}`);
  console.log('');
  process.exit(1);
}
ok('Docker disponible');

// ── 2 · Variables de entorno ─────────────────────────────────────────────────
step(2, 'Configurando variables de entorno');

if (existsSync(ENV_FILE)) {
  warn('.env ya existe — no se toca (tus secretos se conservan)');
} else {
  copyFileSync(ENV_EXAMPLE, ENV_FILE);

  // Secretos únicos por instalación. Los del .env.example son de ejemplo y
  // el API se niega a arrancar con ellos en producción.
  let content = readFileSync(ENV_FILE, 'utf8');

  const secrets = {
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    JWT_REFRESH_SECRET: randomBytes(48).toString('base64url'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
    APP_DB_PASSWORD: randomBytes(24).toString('base64url'),
  };

  for (const [key, value] of Object.entries(secrets)) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  }

  // Las cadenas de conexión deben reflejar las contraseñas nuevas.
  content = content.replace(
    /^DATABASE_URL=.*$/m,
    `DATABASE_URL="postgresql://pv_app:${secrets.APP_DB_PASSWORD}@localhost:5433/punto_venta?schema=public"`,
  );
  content = content.replace(
    /^DATABASE_MIGRATION_URL=.*$/m,
    `DATABASE_MIGRATION_URL="postgresql://pv_owner:${secrets.POSTGRES_PASSWORD}@localhost:5433/punto_venta?schema=public"`,
  );

  writeFileSync(ENV_FILE, content);
  ok('.env creado con secretos únicos generados para esta instalación');
}

// ── 3 · PostgreSQL ───────────────────────────────────────────────────────────
step(3, 'Levantando PostgreSQL');

const up = run('docker compose up -d postgres');
if (up.status !== 0) {
  fail('No se pudo levantar PostgreSQL.');
  console.log(`  Revisa:  ${c.cyan}docker compose logs postgres${c.reset}`);
  process.exit(1);
}

const wait = run('node scripts/wait-for-db.mjs');
if (wait.status !== 0) process.exit(1);

// ── 4 · Migraciones ──────────────────────────────────────────────────────────
step(4, 'Aplicando migraciones');

const generate = run('pnpm --filter @pv/api db:generate', { quiet: true });
if (generate.status !== 0) {
  fail('No se pudo generar el cliente de Prisma.');
  console.log(generate.stderr?.toString() ?? '');
  process.exit(1);
}
ok('Cliente de Prisma generado');

const deploy = run('pnpm --filter @pv/api db:deploy');
if (deploy.status !== 0) {
  fail('Las migraciones fallaron.');
  process.exit(1);
}
ok('Migraciones aplicadas');

// ── 5 · Semilla ──────────────────────────────────────────────────────────────
step(5, 'Sembrando datos iniciales');

const seed = run('pnpm --filter @pv/api db:seed');
if (seed.status !== 0) {
  fail('La semilla falló.');
  process.exit(1);
}

// ── Listo ────────────────────────────────────────────────────────────────────
const env = readFileSync(ENV_FILE, 'utf8');
const adminEmail = env.match(/^SEED_ADMIN_EMAIL=(.*)$/m)?.[1] ?? 'admin@distribuidora.local';
const adminPassword = env.match(/^SEED_ADMIN_PASSWORD=(.*)$/m)?.[1] ?? 'Admin.Cambiar123';

console.log(`
${c.green}${c.bold}╔══════════════════════════════════════════════════════════════╗
║  Todo listo                                                  ║
╚══════════════════════════════════════════════════════════════╝${c.reset}

  Arranca el sistema con:

      ${c.cyan}pnpm dev${c.reset}

  Y abre:

      API            ${c.cyan}http://localhost:3000/api/v1${c.reset}
      Documentación  ${c.cyan}http://localhost:3000/docs${c.reset}
      Administración ${c.cyan}http://localhost:5173${c.reset}
      Punto de venta ${c.cyan}http://localhost:5174${c.reset}

  Credenciales iniciales:

      Correo      ${c.bold}${adminEmail}${c.reset}
      Contraseña  ${c.bold}${adminPassword}${c.reset}
      PIN de POS  ${c.bold}1234${c.reset}

  ${c.yellow}Cámbialas en el primer acceso: están en el .env y las conoce
  cualquiera que lea el repositorio.${c.reset}
`);
