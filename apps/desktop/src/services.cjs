/**
 * Procesos hijos de la app: el API (NestJS) y la semilla de primer uso.
 *
 * Ambos corren con el propio ejecutable de Electron en modo Node
 * (ELECTRON_RUN_AS_NODE): no hace falta instalar Node.js en la caja.
 */
const { spawn } = require('node:child_process');
const { createWriteStream, mkdirSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const paths = require('./paths.cjs');

function dbUrl(config, user) {
  const password = user === 'pv_owner' ? config.secrets.ownerPassword : config.secrets.appPassword;
  return `postgresql://${user}:${password}@localhost:${config.pgPort}/punto_venta?schema=public`;
}

function nodeEnv(extra) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    TZ: 'UTC',
    // El API y la semilla resuelven @prisma/client y argon2 desde aquí.
    NODE_PATH: paths.resources().apiNodeModules,
    ...extra,
  };
}

/** Primer puerto libre desde `from` (en la interfaz donde se va a escuchar). */
function findFreePort(from, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = (port) => {
      if (port > from + 50) return reject(new Error('No hay puertos libres para el sistema.'));
      const server = net.createServer();
      server.once('error', () => probe(port + 1));
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(port)));
    };
    probe(from);
  });
}

/** Crea catálogos, permisos, empresa, sucursal y al administrador. */
function runSeed(config, owner) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(process.execPath, [paths.resources().seed], {
      env: nodeEnv({
        DATABASE_URL: dbUrl(config, 'pv_owner'),
        DATABASE_MIGRATION_URL: dbUrl(config, 'pv_owner'),
        SEED_COMPANY_NAME: owner.companyName,
        SEED_COMPANY_RFC: owner.rfc || '',
        SEED_BRANCH_NAME: owner.branchName,
        SEED_BRANCH_CODE: 'A',
        SEED_TIMEZONE: owner.timezone,
        SEED_ADMIN_NAME: owner.adminName,
        SEED_ADMIN_EMAIL: owner.adminEmail,
        SEED_ADMIN_PASSWORD: owner.adminPassword,
        SEED_ADMIN_PIN: owner.adminPin,
        SEED_ADMIN_MUST_CHANGE: 'false',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`La configuración inicial falló:\n${output.slice(-1500)}`)),
    );
  });
}

let apiChild = null;

/** Arranca el API y espera a que responda /health/ready. */
async function startApi(config) {
  mkdirSync(path.dirname(paths.apiLog), { recursive: true });
  const log = createWriteStream(paths.apiLog, { flags: 'a' });
  const host = config.lan ? '0.0.0.0' : '127.0.0.1';
  const origin = `http://localhost:${config.port}`;

  apiChild = spawn(process.execPath, [paths.resources().apiMain], {
    cwd: path.dirname(paths.resources().apiMain),
    env: nodeEnv({
      DATABASE_URL: dbUrl(config, 'pv_app'),
      DATABASE_MIGRATION_URL: dbUrl(config, 'pv_owner'),
      API_PORT: String(config.port),
      API_HOST: host,
      API_PREFIX: 'api',
      API_URL: origin,
      CORS_ORIGINS: origin,
      COOKIE_SECURE: 'false',
      JWT_ACCESS_SECRET: config.secrets.jwtAccess,
      JWT_REFRESH_SECRET: config.secrets.jwtRefresh,
      ENCRYPTION_KEY: config.secrets.encryptionKey,
      PV_STATIC_DIR: paths.resources().ui,
      LOG_LEVEL: 'warn',
      LOG_PRETTY: 'false',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let tail = '';
  const keep = (d) => {
    log.write(d);
    tail = (tail + d).slice(-2000);
  };
  apiChild.stdout.on('data', keep);
  apiChild.stderr.on('data', keep);

  let exited = null;
  apiChild.on('exit', (code) => {
    exited = code;
    apiChild = null;
  });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`El servidor interno se detuvo (código ${exited}).\n${tail}`);
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/v1/health/ready`);
      if (res.ok) return `http://localhost:${config.port}`;
    } catch {
      // Todavía no escucha.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`El servidor interno no respondió a tiempo.\n${tail}`);
}

function stopApi() {
  return new Promise((resolve) => {
    if (!apiChild) return resolve();
    const child = apiChild;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

module.exports = { findFreePort, runSeed, startApi, stopApi };
