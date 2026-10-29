/**
 * PostgreSQL local de la aplicación de escritorio.
 *
 * Un clúster propio por instalación, solo escuchando en localhost: el único
 * cliente es el API que arranca esta misma app. Mismos roles y ajustes que el
 * servidor (scripts/setup-postgres-local.mjs): `pv_owner` migra y respalda,
 * `pv_app` opera sin poder reescribir el kardex ni la auditoría.
 */
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
} = require('node:fs');
const path = require('node:path');
const paths = require('./paths.cjs');

const DB_NAME = 'punto_venta';

const exe = (name) => path.join(paths.resources().pgBin, `${name}.exe`);

/**
 * Ejecuta un binario y espera a que TERMINE el proceso (evento `exit`).
 *
 * `pg_ctl start` deja vivo un `postgres` que hereda los descriptores: con
 * pipes, esperar el EOF colgaría para siempre. Por eso, salvo que se pida la
 * salida, los descriptores van en `ignore`.
 */
function run(file, args, { env = {}, capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: { ...process.env, PGCLIENTENCODING: 'UTF8', ...env },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function binariesPresent() {
  return existsSync(exe('postgres')) && existsSync(exe('pg_ctl'));
}

async function isRunning() {
  if (!existsSync(paths.pgData)) return false;
  return (await run(exe('pg_ctl'), ['-D', paths.pgData, 'status'])).code === 0;
}

async function start() {
  if (await isRunning()) return;
  mkdirSync(path.dirname(paths.pgLog), { recursive: true });
  const r = await run(exe('pg_ctl'), ['-D', paths.pgData, '-l', paths.pgLog, '-w', '-t', '60', 'start']);
  if (r.code !== 0 && !(await isRunning())) {
    throw new Error(`La base de datos no arrancó. Revisa ${paths.pgLog}`);
  }
}

async function stop() {
  if (!(await isRunning())) return;
  await run(exe('pg_ctl'), ['-D', paths.pgData, '-m', 'fast', '-w', 'stop']);
}

function psql(config, sql, { database = DB_NAME, file } = {}) {
  const args = ['-h', 'localhost', '-p', String(config.pgPort), '-U', 'pv_owner', '-d', database];
  args.push('-X', '-q', '-v', 'ON_ERROR_STOP=1', '-t', '-A');
  if (file) args.push('-f', file);
  else args.push('-c', sql);
  return run(exe('psql'), args, { env: { PGPASSWORD: config.secrets.ownerPassword }, capture: true });
}

async function mustPsql(config, sql, options) {
  const r = await psql(config, sql, options);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `psql terminó con código ${r.code}`);
  return r.stdout.trim();
}

/** Primer arranque: crea el clúster, la base y los dos roles. */
async function initCluster(config, report) {
  if (existsSync(paths.pgData)) rmSync(paths.pgData, { recursive: true, force: true });
  mkdirSync(paths.dataDir, { recursive: true });

  report('Creando la base de datos…');
  const pwFile = path.join(paths.dataDir, 'owner.pw');
  writeFileSync(pwFile, config.secrets.ownerPassword, 'ascii');
  const init = await run(
    exe('initdb'),
    [
      '-D', paths.pgData, '-U', 'pv_owner', `--pwfile=${pwFile}`,
      '--encoding=UTF8', '--locale=C', '--auth-local=scram-sha-256', '--auth-host=scram-sha-256',
    ],
    { capture: true },
  );
  rmSync(pwFile, { force: true });
  if (init.code !== 0) throw new Error(`No se pudo crear la base de datos.\n${init.stderr}`);

  appendFileSync(
    path.join(paths.pgData, 'postgresql.conf'),
    `
# ── Maydek (escritorio) ──
port = ${config.pgPort}
listen_addresses = 'localhost'
lock_timeout = '3s'
statement_timeout = '30s'
idle_in_transaction_session_timeout = '30s'
timezone = 'UTC'
max_connections = 40
shared_buffers = '128MB'
work_mem = '8MB'
`,
  );

  await start();
  report('Preparando la base…');
  await mustPsql(config, `CREATE DATABASE ${DB_NAME};`, { database: 'postgres' });
  await mustPsql(
    config,
    `CREATE ROLE pv_app LOGIN PASSWORD '${config.secrets.appPassword}';`,
    { database: 'postgres' },
  );
  await mustPsql(
    config,
    `GRANT CONNECT ON DATABASE ${DB_NAME} TO pv_app;
     GRANT USAGE ON SCHEMA public TO pv_app;
     REVOKE CREATE ON SCHEMA public FROM pv_app;`,
  );
}

/**
 * Aplica las migraciones pendientes, compatible con `prisma migrate deploy`.
 *
 * Usa la misma tabla `_prisma_migrations` y el mismo checksum (sha256 del
 * archivo), así una base creada por la app se puede seguir migrando con las
 * herramientas de Prisma y viceversa. Se hace con `psql` para no cargar el
 * motor de migraciones de Prisma (decenas de MB) dentro del instalador.
 */
async function migrate(config, report) {
  await mustPsql(
    config,
    `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
       "id" VARCHAR(36) PRIMARY KEY NOT NULL,
       "checksum" VARCHAR(64) NOT NULL,
       "finished_at" TIMESTAMPTZ,
       "migration_name" VARCHAR(255) NOT NULL,
       "logs" TEXT,
       "rolled_back_at" TIMESTAMPTZ,
       "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
       "applied_steps_count" INTEGER NOT NULL DEFAULT 0
     );`,
  );
  const applied = new Set(
    (await mustPsql(
      config,
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;',
    ))
      .split(/\r?\n/)
      .filter(Boolean),
  );

  const dir = paths.resources().migrations;
  const pending = readdirSync(dir)
    .filter((name) => existsSync(path.join(dir, name, 'migration.sql')) && !applied.has(name))
    .sort();

  for (const [i, name] of pending.entries()) {
    report(`Actualizando la base (${i + 1} de ${pending.length})…`);
    const file = path.join(dir, name, 'migration.sql');
    const checksum = createHash('sha256').update(readFileSync(file)).digest('hex');
    const r = await psql(config, null, { file });
    if (r.code !== 0) {
      throw new Error(`La migración ${name} falló:\n${r.stderr.trim()}`);
    }
    await mustPsql(
      config,
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
       VALUES ('${randomUUID()}', '${checksum}', now(), '${name}', 1);`,
    );
  }
  return pending.length;
}

/** ¿Ya hay al menos un usuario? Decide si se muestra el asistente de primer uso. */
async function hasUsers(config) {
  const out = await psql(config, 'SELECT count(*) FROM users;');
  return out.code === 0 && Number(out.stdout.trim()) > 0;
}

/**
 * Respaldo con pg_dump (formato personalizado, comprimido). Verifica que el
 * archivo se pueda leer, conserva los `keep` más recientes y, si hay carpeta
 * espejo (USB, nube), deja ahí también una copia.
 */
async function backup(config, { keep = 30 } = {}) {
  mkdirSync(paths.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(paths.backupDir, `respaldo-${stamp}.dump`);
  const url = `postgresql://pv_owner@localhost:${config.pgPort}/${DB_NAME}`;
  const env = { PGPASSWORD: config.secrets.ownerPassword };

  const dump = await run(exe('pg_dump'), ['-Fc', '--no-owner', '-f', file, url], { env, capture: true });
  if (dump.code !== 0) throw new Error(`El respaldo falló: ${dump.stderr.trim()}`);

  const list = await run(exe('pg_restore'), ['--list', file], { capture: true });
  if (list.code !== 0 || !list.stdout.includes('TABLE DATA')) {
    unlinkSync(file);
    throw new Error('El respaldo se creó pero no se puede leer; se descartó.');
  }

  const old = readdirSync(paths.backupDir)
    .filter((f) => /^respaldo-.*\.dump$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) unlinkSync(path.join(paths.backupDir, f));

  let mirrored = null;
  if (config.backupMirrorDir && existsSync(config.backupMirrorDir)) {
    mirrored = path.join(config.backupMirrorDir, path.basename(file));
    copyFileSync(file, mirrored);
  }
  return { file, size: statSync(file).size, mirrored };
}

/**
 * Restaura un respaldo sobre la base actual. Antes hace un respaldo de lo que
 * hay, para que restaurar el archivo equivocado tenga regreso.
 */
async function restore(config, file) {
  const safety = await backup(config);
  const url = `postgresql://pv_owner@localhost:${config.pgPort}/${DB_NAME}`;
  const r = await run(
    exe('pg_restore'),
    ['--clean', '--if-exists', '--no-owner', '--single-transaction', '-d', url, file],
    { env: { PGPASSWORD: config.secrets.ownerPassword }, capture: true },
  );
  if (r.code !== 0) throw new Error(`No se pudo restaurar: ${r.stderr.trim()}`);
  return safety;
}

module.exports = {
  DB_NAME,
  binariesPresent,
  isRunning,
  start,
  stop,
  initCluster,
  migrate,
  hasUsers,
  backup,
  restore,
  run,
};
