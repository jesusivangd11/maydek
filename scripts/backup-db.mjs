#!/usr/bin/env node
/**
 * RESPALDO DE LA BASE DE DATOS.
 *
 *   pnpm db:backup              → crea un respaldo y conserva los 14 más recientes
 *   pnpm db:backup -- --keep 30 → conserva 30
 *   pnpm db:backup -- --verify  → además comprueba que el archivo se puede leer
 *
 * Usa `pg_dump` en formato personalizado (-Fc): comprimido y restaurable por
 * tabla con `pg_restore`. Se conecta con el usuario dueño
 * (DATABASE_MIGRATION_URL), que puede leer todas las tablas.
 *
 * Los respaldos van FUERA del repositorio y fuera de OneDrive, en
 * %LOCALAPPDATA%\punto-venta\backups (o PV_BACKUP_DIR). Para tener una copia
 * fuera de la computadora, sincroniza ESA carpeta con tu nube o cópiala a un
 * disco externo: un respaldo en el mismo disco no sobrevive a que el disco
 * muera.
 *
 * Programarlo a diario en Windows: `pnpm db:backup:schedule` (crea la tarea
 * «PuntoVenta-Respaldo» a las 22:00; si el equipo estaba apagado, corre al
 * encenderlo). Si la base está apagada, este script la enciende y la apaga.
 *
 * Restaurar (sobre una base vacía):
 *   pg_restore --clean --if-exists -d <DATABASE_MIGRATION_URL> <archivo.dump>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, '')];
      }),
  );
}

const env = { ...loadEnv(), ...process.env };
const args = process.argv.slice(2);
const keep = Number(args[args.indexOf('--keep') + 1]) || 14;
const verify = args.includes('--verify');

const url = (env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL ?? '').replace(/\?.*$/, '');
if (!url) {
  console.error('✗ No hay DATABASE_MIGRATION_URL ni DATABASE_URL en .env');
  process.exit(1);
}

const dataHome =
  env.LOCALAPPDATA ?? env.XDG_DATA_HOME ?? path.join(env.HOME ?? ROOT, '.local', 'share');
const pgHome = env.PV_POSTGRES_HOME ?? path.join(dataHome, 'punto-venta', 'postgres');
const exe = process.platform === 'win32' ? '.exe' : '';
const localBin = path.join(pgHome, 'pgsql', 'bin');
const bin = (name) =>
  existsSync(path.join(localBin, name + exe)) ? path.join(localBin, name + exe) : name;

const dir = env.PV_BACKUP_DIR ?? path.join(dataHome, 'punto-venta', 'backups');
mkdirSync(dir, { recursive: true });

// La tarea programada corre aunque nadie haya abierto el sistema ese día. Si
// el clúster local está apagado, se enciende solo para respaldar y se vuelve a
// apagar al terminar, para dejar la máquina como estaba.
const dataDir = path.join(pgHome, 'pgdata');
let startedHere = false;
if (existsSync(path.join(localBin, 'pg_ctl' + exe)) && existsSync(dataDir)) {
  const status = spawnSync(bin('pg_ctl'), ['-D', dataDir, 'status'], { stdio: 'ignore' });
  if (status.status !== 0) {
    console.log('· La base estaba apagada; se enciende para respaldar');
    // Descriptores en `ignore`: el demonio los heredaría y spawnSync nunca
    // retornaría (ver setup-postgres-local.mjs).
    spawnSync(
      bin('pg_ctl'),
      ['-D', dataDir, '-l', path.join(pgHome, 'server.log'), '-w', 'start'],
      { stdio: 'ignore' },
    );
    startedHere = true;
  }
}
process.on('exit', () => {
  if (startedHere) {
    spawnSync(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'ignore' });
  }
});

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const file = path.join(dir, `punto-venta-${stamp}.dump`);

console.log(`→ Respaldando en ${file}`);
// stdio heredado: pg_dump termina y cierra sus descriptores, no hay riesgo de
// quedarse esperando un EOF que no llega.
const dump = spawnSync(bin('pg_dump'), ['-Fc', '--no-owner', '-f', file, url], {
  stdio: 'inherit',
});
if (dump.status !== 0) {
  console.error('✗ pg_dump falló. ¿Está encendida la base? (pnpm db:local:start)');
  process.exit(dump.status ?? 1);
}

const size = statSync(file).size;
if (size < 1024) {
  console.error(`✗ El respaldo pesa ${size} bytes: algo salió mal.`);
  process.exit(1);
}
console.log(`✓ Respaldo creado (${(size / 1024 / 1024).toFixed(2)} MB)`);

if (verify) {
  const list = spawnSync(bin('pg_restore'), ['--list', file], { encoding: 'utf8' });
  const tables = (list.stdout ?? '').split('\n').filter((l) => l.includes('TABLE DATA')).length;
  if (list.status !== 0 || tables === 0) {
    console.error('✗ El archivo no se puede leer con pg_restore');
    process.exit(1);
  }
  console.log(`✓ Verificado: ${tables} tablas con datos dentro del respaldo`);
}

// Rotación: se conservan los N más recientes.
const old = readdirSync(dir)
  .filter((f) => /^punto-venta-.*\.dump$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) unlinkSync(path.join(dir, f));
if (old.length > 0) console.log(`· ${old.length} respaldo(s) antiguo(s) eliminados (se conservan ${keep})`);
