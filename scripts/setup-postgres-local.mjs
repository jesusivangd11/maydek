#!/usr/bin/env node
/**
 * PostgreSQL SIN Docker y SIN permisos de administrador.
 *
 *     node scripts/setup-postgres-local.mjs
 *
 * Docker Desktop necesita elevación (instala un servicio y WSL). En una máquina
 * donde no se puede elevar —o donde simplemente no se quiere Docker— este
 * script deja un PostgreSQL 17 REAL corriendo en espacio de usuario:
 *
 *   1. Descarga los binarios oficiales de PostgreSQL 17 (no el instalador)
 *   2. Los extrae en el directorio de datos del usuario
 *   3. Inicializa un clúster con la misma configuración que docker-compose.yml
 *   4. Lo arranca en el puerto 5433
 *   5. Crea las bases `punto_venta` y `punto_venta_test`
 *   6. Crea los DOS roles: pv_owner (dueño) y pv_app (restringido)
 *   7. Escribe el .env apuntando a este clúster
 *
 * Es el mismo resultado que `docker compose up -d postgres`: mismos roles,
 * mismos ajustes de `lock_timeout` y `statement_timeout`, misma separación de
 * privilegios que hace que el kardex sea append-only de verdad.
 *
 * Para detenerlo:   node scripts/setup-postgres-local.mjs --stop
 * Para el estado:   node scripts/setup-postgres-local.mjs --status
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * El clúster NO vive dentro del repositorio.
 *
 * Motivo concreto: es habitual tener el proyecto en una carpeta sincronizada
 * (OneDrive, Dropbox, Google Drive). Un directorio de datos de PostgreSQL
 * ACTIVO dentro de una carpeta que se sincroniza en caliente es una receta
 * para la corrupción: el sincronizador copia archivos que el motor está
 * escribiendo, y `.gitignore` no lo detiene porque OneDrive no lo lee.
 *
 * Por eso va a los datos de aplicación del usuario. Se puede cambiar con
 * PV_POSTGRES_HOME si se prefiere otra ubicación (un SSD distinto, por ejemplo).
 */
const DEFAULT_HOME = path.join(
  process.env.LOCALAPPDATA ??
    process.env.XDG_DATA_HOME ??
    path.join(process.env.HOME ?? ROOT, '.local', 'share'),
  'punto-venta',
  'postgres',
);

const BASE = process.env.PV_POSTGRES_HOME ?? DEFAULT_HOME;
const PG_DIR = path.join(BASE, 'pgsql');
const DATA_DIR = path.join(BASE, 'pgdata');

/**
 * El log del servidor va FUERA de PGDATA a propósito.
 *
 * Si vive dentro (`pgdata/server.log`), en cada recuperación tras un cierre
 * sucio PostgreSQL recorre el directorio de datos con fsync e intenta abrir
 * ese archivo mientras `pg_ctl` lo tiene abierto en escritura. En Windows eso
 * es un *sharing violation*: el arranque reintenta 30 s y, con `-w`, el
 * comando parece colgado. Fuera de PGDATA el motor ni lo mira.
 */
const LOG_FILE = path.join(BASE, 'server.log');
const BIN = path.join(PG_DIR, 'bin');
const PORT = Number(process.env.POSTGRES_PORT ?? 5433);

const PG_VERSION = '17.2-1';
const DOWNLOAD_URL = `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip`;

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`);
const fail = (m) => console.log(`${c.red}✗${c.reset} ${m}`);
const step = (n, m) => console.log(`\n${c.bold}${c.cyan}[${n}/7]${c.reset} ${c.bold}${m}${c.reset}`);

const exe = (name) => path.join(BIN, process.platform === 'win32' ? `${name}.exe` : name);

function pgCtl(args, env = {}) {
  return spawnSync(exe('pg_ctl'), args, {
    stdio: 'pipe',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

/**
 * Arranca el servidor sin que el comando se quede colgado.
 *
 * `pg_ctl start` deja vivo un proceso `postgres` que HEREDA los descriptores
 * que le pasemos. Con `stdio: 'pipe'`, `spawnSync` no espera a que salga
 * `pg_ctl` sino a que los pipes den EOF, y el demonio mantiene abierto su
 * extremo para siempre: el comando nunca retorna aunque la base ya esté
 * lista en menos de un segundo. Con los descriptores en `ignore` no hay pipe
 * que drenar y `spawnSync` retorna en cuanto `pg_ctl` termina.
 *
 * La salida de `pg_ctl` se pierde a cambio, así que el diagnóstico sale de
 * `isRunning()` y del log del servidor (`-l LOG_FILE`).
 */
function pgCtlStart() {
  const r = spawnSync(exe('pg_ctl'), ['-D', DATA_DIR, '-l', LOG_FILE, '-w', 'start'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  });
  return r.status === 0 || isRunning();
}

function psql(database, sql, password) {
  return spawnSync(
    exe('psql'),
    ['-h', 'localhost', '-p', String(PORT), '-U', 'pv_owner', '-d', database, '-c', sql],
    {
      stdio: 'pipe',
      env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8' },
      encoding: 'utf8',
    },
  );
}

function isRunning() {
  if (!existsSync(DATA_DIR)) return false;
  return pgCtl(['-D', DATA_DIR, 'status']).status === 0;
}

// ── Subcomandos ──────────────────────────────────────────────────────────────
const arg = process.argv[2];

if (arg === '--status') {
  console.log(isRunning() ? `${c.green}PostgreSQL corriendo${c.reset} en localhost:${PORT}` : 'PostgreSQL detenido');
  process.exit(0);
}

if (arg === '--stop') {
  if (!isRunning()) { warn('No estaba corriendo.'); process.exit(0); }
  const r = pgCtl(['-D', DATA_DIR, '-m', 'fast', 'stop']);
  if (r.status === 0) ok('PostgreSQL detenido.');
  else { fail('No se pudo detener.'); console.log(r.stderr); process.exit(1); }
  process.exit(0);
}

if (arg === '--start') {
  if (isRunning()) { ok(`Ya estaba corriendo en localhost:${PORT}.`); process.exit(0); }
  if (pgCtlStart()) ok(`PostgreSQL arrancado en localhost:${PORT}.`);
  else { fail(`No arrancó. Revisa ${LOG_FILE}`); process.exit(1); }
  process.exit(0);
}

// ── Instalación completa ─────────────────────────────────────────────────────
console.log(`
${c.bold}PostgreSQL 17 local, sin Docker y sin administrador${c.reset}
${c.dim}Alternativa a docker-compose para máquinas donde no se puede elevar.${c.reset}
${c.dim}Ubicación: ${BASE}${c.reset}`);

if (process.platform !== 'win32') {
  fail('Este script está escrito para Windows.');
  console.log(`  En macOS:  ${c.cyan}brew install postgresql@17 && brew services start postgresql@17${c.reset}`);
  console.log(`  En Linux:  ${c.cyan}sudo apt install postgresql-17${c.reset}`);
  console.log('  Después ajusta DATABASE_URL y DATABASE_MIGRATION_URL en .env.');
  process.exit(1);
}

if (isRunning()) {
  ok(`Ya hay un clúster corriendo en localhost:${PORT}.`);
  console.log(`  Para reinstalarlo desde cero: ${c.cyan}node scripts/setup-postgres-local.mjs --stop${c.reset}`);
  console.log(`  y borra la carpeta ${c.dim}${BASE}${c.reset}`);
  process.exit(0);
}

// Contraseñas únicas por instalación.
const OWNER_PASSWORD = randomBytes(18).toString('base64url');
const APP_PASSWORD = randomBytes(18).toString('base64url');

// ── 1 · Descarga ─────────────────────────────────────────────────────────────
step(1, 'Descargando los binarios de PostgreSQL 17');
mkdirSync(BASE, { recursive: true });
const zipPath = path.join(BASE, 'postgresql.zip');

if (existsSync(exe('postgres'))) {
  ok('Los binarios ya estaban descargados.');
} else {
  if (!existsSync(zipPath)) {
    console.log(`  ${c.dim}≈300 MB, puede tardar unos minutos…${c.reset}`);
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command',
       `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${DOWNLOAD_URL}' -OutFile '${zipPath}' -UseBasicParsing`],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) {
      fail('La descarga falló. Revisa tu conexión.');
      console.log(`  URL: ${c.cyan}${DOWNLOAD_URL}${c.reset}`);
      process.exit(1);
    }
  }
  ok('Binarios descargados.');

  console.log(`  ${c.dim}Extrayendo…${c.reset}`);
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${BASE}' -Force`],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) { fail('La extracción falló.'); process.exit(1); }
  rmSync(zipPath, { force: true });
  ok('Binarios extraídos.');
}

// ── 2 · Clúster ──────────────────────────────────────────────────────────────
step(2, 'Inicializando el clúster');
if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });

const pwFile = path.join(BASE, 'owner.pw');
writeFileSync(pwFile, OWNER_PASSWORD, 'ascii');

const init = spawnSync(
  exe('initdb'),
  ['-D', DATA_DIR, '-U', 'pv_owner', `--pwfile=${pwFile}`,
   '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256'],
  { stdio: 'pipe', encoding: 'utf8' },
);
rmSync(pwFile, { force: true });

if (init.status !== 0) { fail('initdb falló.'); console.log(init.stderr); process.exit(1); }
ok('Clúster inicializado.');

// ── 3 · Configuración (la misma de docker-compose.yml) ───────────────────────
step(3, 'Aplicando la configuración del proyecto');
appendFileSync(
  path.join(DATA_DIR, 'postgresql.conf'),
  `

# ── Ajustes del proyecto (equivalentes a docker-compose.yml) ──
port = ${PORT}
listen_addresses = 'localhost'
# Un bloqueo que no se obtiene en 3 s falla con error claro en vez de colgar
# la caja indefinidamente (docs/07-concurrencia.md).
lock_timeout = '3s'
statement_timeout = '10s'
idle_in_transaction_session_timeout = '30s'
log_min_duration_statement = 500
timezone = 'UTC'
max_connections = 100
shared_buffers = '256MB'
work_mem = '8MB'
`,
);
ok('Configuración aplicada.');

// ── 4 · Arranque ─────────────────────────────────────────────────────────────
step(4, 'Arrancando PostgreSQL');
if (!pgCtlStart()) { fail(`No arrancó. Revisa ${LOG_FILE}`); process.exit(1); }
ok(`Escuchando en localhost:${PORT}.`);

// ── 5 · Bases de datos ───────────────────────────────────────────────────────
step(5, 'Creando las bases de datos');
for (const db of ['punto_venta', 'punto_venta_test']) {
  const r = psql('postgres', `CREATE DATABASE ${db};`, OWNER_PASSWORD);
  const stderr = r.stderr ?? '';
  // psql traduce sus mensajes: "already exists" en inglés, "ya existe" en
  // español. Comparar por texto en un solo idioma hacía que el script abortara
  // en una máquina localizada. Se comprueba el código de error de PostgreSQL
  // (42P04 = duplicate_database), que no cambia con el idioma.
  const yaExistia = stderr.includes('42P04') ||
    /already exists|ya existe|existe d[eé]j[aà]/i.test(stderr);

  if (r.status === 0) ok(`${db} creada.`);
  else if (yaExistia) warn(`${db} ya existía.`);
  else { fail(`No se pudo crear ${db}.`); console.log(stderr); process.exit(1); }
}

// ── 6 · Rol restringido ──────────────────────────────────────────────────────
step(6, 'Creando el rol restringido de la aplicación');
console.log(`  ${c.dim}pv_owner migra; pv_app opera SIN poder modificar el kardex ni la auditoría.${c.reset}`);

// Si el rol ya existe (reinstalación), se le actualiza la contraseña en vez de
// dejar el .env apuntando a una credencial que no sirve.
const rolCreado = psql(
  'postgres',
  `CREATE ROLE pv_app LOGIN PASSWORD '${APP_PASSWORD}';`,
  OWNER_PASSWORD,
);
if (rolCreado.status !== 0) {
  const r = psql('postgres', `ALTER ROLE pv_app PASSWORD '${APP_PASSWORD}';`, OWNER_PASSWORD);
  if (r.status !== 0) {
    fail('No se pudo crear ni actualizar el rol pv_app.');
    console.log(r.stderr);
    process.exit(1);
  }
  warn('pv_app ya existía; contraseña actualizada.');
}
for (const db of ['punto_venta', 'punto_venta_test']) {
  const r = psql(
    db,
    `GRANT CONNECT ON DATABASE ${db} TO pv_app;
     GRANT USAGE ON SCHEMA public TO pv_app;
     REVOKE CREATE ON SCHEMA public FROM pv_app;`,
    OWNER_PASSWORD,
  );
  if (r.status !== 0) { fail(`Permisos en ${db} fallaron.`); console.log(r.stderr); process.exit(1); }
}
ok('Roles pv_owner y pv_app listos.');

// ── 7 · .env ─────────────────────────────────────────────────────────────────
step(7, 'Escribiendo el archivo .env');
const envPath = path.join(ROOT, '.env');
if (!existsSync(envPath)) copyFileSync(path.join(ROOT, '.env.example'), envPath);

let env = readFileSync(envPath, 'utf8');
const set = (key, value) => {
  env = new RegExp(`^${key}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : `${env}\n${key}=${value}`;
};

set('POSTGRES_USER', 'pv_owner');
set('POSTGRES_PASSWORD', OWNER_PASSWORD);
set('APP_DB_USER', 'pv_app');
set('APP_DB_PASSWORD', APP_PASSWORD);
set('POSTGRES_PORT', String(PORT));
set('DATABASE_URL', `"postgresql://pv_app:${APP_PASSWORD}@localhost:${PORT}/punto_venta?schema=public"`);
set('DATABASE_MIGRATION_URL', `"postgresql://pv_owner:${OWNER_PASSWORD}@localhost:${PORT}/punto_venta?schema=public"`);

// Secretos únicos si todavía tienen el valor de ejemplo.
if (env.includes('desarrollo_cambia_este_secreto_de_acceso')) {
  set('JWT_ACCESS_SECRET', randomBytes(48).toString('base64url'));
  set('JWT_REFRESH_SECRET', randomBytes(48).toString('base64url'));
  set('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
}

writeFileSync(envPath, env);
ok('.env apuntando al clúster local.');

// Y el de pruebas.
const envTestPath = path.join(ROOT, '.env.test');
if (existsSync(envTestPath)) {
  let envTest = readFileSync(envTestPath, 'utf8');
  envTest = envTest
    .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL="postgresql://pv_app:${APP_PASSWORD}@localhost:${PORT}/punto_venta_test?schema=public"`)
    .replace(/^DATABASE_MIGRATION_URL=.*$/m, `DATABASE_MIGRATION_URL="postgresql://pv_owner:${OWNER_PASSWORD}@localhost:${PORT}/punto_venta_test?schema=public"`)
    .replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${OWNER_PASSWORD}`)
    .replace(/^APP_DB_PASSWORD=.*$/m, `APP_DB_PASSWORD=${APP_PASSWORD}`);
  writeFileSync(envTestPath, envTest);
  ok('.env.test apuntando a punto_venta_test.');
}

console.log(`
${c.green}${c.bold}╔══════════════════════════════════════════════════════════════╗
║  PostgreSQL 17 listo, sin Docker                             ║
╚══════════════════════════════════════════════════════════════╝${c.reset}

  Continúa con:

      ${c.cyan}pnpm --filter @pv/api db:deploy${c.reset}
      ${c.cyan}pnpm --filter @pv/api db:seed${c.reset}
      ${c.cyan}pnpm dev${c.reset}

  Control del servidor:

      ${c.cyan}node scripts/setup-postgres-local.mjs --status${c.reset}
      ${c.cyan}node scripts/setup-postgres-local.mjs --stop${c.reset}
      ${c.cyan}node scripts/setup-postgres-local.mjs --start${c.reset}

  ${c.dim}Datos en ${BASE}${c.reset}
  ${c.dim}Fuera del repositorio a propósito: un clúster activo dentro de una${c.reset}
  ${c.dim}carpeta sincronizada (OneDrive, Dropbox) puede corromperse.${c.reset}
`);
