#!/usr/bin/env node
/**
 * EMISOR DE LICENCIAS DE MAYDEK — herramienta de quien vende, no del cliente.
 *
 *   node scripts/licencias.mjs init
 *       Crea el par de llaves (una sola vez) y escribe la llave PÚBLICA en el
 *       API. Después de esto hay que publicar una versión nueva del programa.
 *
 *   node scripts/licencias.mjs emitir --cliente "Abarrotes López" --plan EMPRESARIAL \
 *        --tipo permanente [--instalacion ABCD-1234-EF56] [--vence 2027-10-30] \
 *        [--usuarios 5] [--productos 3000] [--cajas 2] [--nota "Pago en efectivo"]
 *       Firma una licencia, la guarda en el registro y la imprime para
 *       pegarla en Administración → Licencia.
 *
 *   node scripts/licencias.mjs listar
 *       Muestra el registro de licencias entregadas.
 *
 * La llave privada y el registro viven en ~/.maydek-licencias (fuera del
 * repositorio, que es público). Quien tenga esa llave puede emitir licencias:
 * respáldala en un lugar seguro y no la compartas. Si se pierde, no se pueden
 * emitir licencias nuevas compatibles con los programas ya instalados.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = join(homedir(), '.maydek-licencias');
const PRIVATE_KEY = join(HOME, 'llave-privada.pem');
const REGISTRY = join(HOME, 'registro.json');
const PUBLIC_KEY_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'api',
  'src',
  'modules',
  'license',
  'public-key.ts',
);

const PLANS = ['BASICO', 'PROFESIONAL', 'EMPRESARIAL'];

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith('--')) continue;
    out[list[i].slice(2)] = list[i + 1]?.startsWith('--') || list[i + 1] === undefined ? true : list[++i];
  }
  return out;
}

function writePublicKey(pem) {
  writeFileSync(
    PUBLIC_KEY_FILE,
    `/**\n * Llave pública con la que el programa comprueba las licencias.\n` +
      ` * La genera \`node scripts/licencias.mjs init\`. No es un secreto.\n */\n` +
      `export const LICENSE_PUBLIC_KEY = \`${pem.trim()}\n\`;\n`,
  );
}

function init() {
  if (existsSync(PRIVATE_KEY)) {
    fail(
      `Ya existe una llave en ${PRIVATE_KEY}.\n` +
        '  Crear otra invalidaría todas las licencias ya entregadas. Bórrala a mano solo si estás seguro.',
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(HOME, { recursive: true });
  writeFileSync(PRIVATE_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(REGISTRY, '[]\n');
  writePublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`\n✓ Llave privada guardada en ${PRIVATE_KEY}`);
  console.log(`✓ Llave pública escrita en ${PUBLIC_KEY_FILE}`);
  console.log('\nRESPALDA la llave privada (USB o gestor de contraseñas). No la subas a GitHub.');
  console.log('Falta publicar una versión nueva del programa para que traiga la llave pública.\n');
}

function readRegistry() {
  return existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf8')) : [];
}

function emitir(a) {
  if (!existsSync(PRIVATE_KEY)) fail('Aún no hay llaves. Corre primero: node scripts/licencias.mjs init');
  if (!a.cliente || a.cliente === true) fail('Falta --cliente "Nombre del negocio".');

  const plan = String(a.plan ?? '').toUpperCase();
  if (!PLANS.includes(plan)) fail(`--plan debe ser uno de: ${PLANS.join(', ')}.`);

  const tipo = String(a.tipo ?? 'permanente').toLowerCase();
  if (!['permanente', 'periodo'].includes(tipo)) fail('--tipo debe ser «permanente» o «periodo».');
  let expiresAt = null;
  if (tipo === 'periodo') {
    if (!a.vence || Number.isNaN(Date.parse(a.vence))) fail('Una licencia por periodo necesita --vence AAAA-MM-DD.');
    // El día indicado se cuenta completo: vence al terminar ese día.
    expiresAt = new Date(`${a.vence}T23:59:59`).toISOString();
  } else if (a.vence) {
    fail('Una licencia permanente no vence: quita --vence o usa --tipo periodo.');
  }

  const installation = a.instalacion && a.instalacion !== true ? String(a.instalacion).toUpperCase() : null;
  if (installation && !/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(installation)) {
    fail('--instalacion debe verse así: ABCD-1234-EF56 (se ve en Administración → Licencia).');
  }

  const limits = {};
  for (const [flag, key] of [['usuarios', 'users'], ['productos', 'products'], ['cajas', 'terminals']]) {
    if (a[flag] === undefined) continue;
    const n = Number(a[flag]);
    if (!Number.isInteger(n) || n < 1) fail(`--${flag} debe ser un número entero mayor que 0.`);
    limits[key] = n;
  }

  const registry = readRegistry();
  const year = new Date().getFullYear();
  const folio = `LIC-${year}-${String(registry.filter((r) => r.id.startsWith(`LIC-${year}-`)).length + 1).padStart(4, '0')}`;

  const payload = {
    v: 1,
    id: folio,
    licensee: String(a.cliente).trim(),
    plan,
    kind: tipo === 'permanente' ? 'PERMANENT' : 'TERM',
    issuedAt: new Date().toISOString(),
    expiresAt,
    installation,
    ...(Object.keys(limits).length ? { limits } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(body, 'utf8'), createPrivateKey(readFileSync(PRIVATE_KEY))).toString('base64url');
  const token = `MAYDEK1.${body}.${signature}`;

  registry.push({ ...payload, note: a.nota && a.nota !== true ? String(a.nota) : '', token });
  writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);

  console.log(`\n✓ Licencia ${folio} emitida para «${payload.licensee}»`);
  console.log(`  Plan ${plan} · ${tipo === 'permanente' ? 'permanente' : `vence ${a.vence}`}${installation ? ` · atada a ${installation}` : ' · sirve en cualquier equipo'}`);
  console.log('\nPega esto en Administración → Licencia:\n');
  console.log(token);
  console.log('');
}

function listar() {
  const rows = readRegistry();
  if (!rows.length) return console.log('\nAún no has emitido licencias.\n');
  console.log('');
  for (const r of rows) {
    const vigencia = r.expiresAt ? `vence ${r.expiresAt.slice(0, 10)}` : 'permanente';
    console.log(
      `${r.id}  ${r.issuedAt.slice(0, 10)}  ${r.plan.padEnd(11)}  ${vigencia.padEnd(17)}  ${r.licensee}` +
        `${r.installation ? `  [${r.installation}]` : ''}${r.note ? `  — ${r.note}` : ''}`,
    );
  }
  console.log('');
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') init();
else if (command === 'emitir') emitir(args(rest));
else if (command === 'listar') listar();
else console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
