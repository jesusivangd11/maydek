/**
 * Configuración del equipo: puertos, modo (principal o caja en red) y los
 * secretos generados en el primer arranque.
 *
 * Los secretos (contraseñas de la base y llaves de sesión) se cifran con
 * `safeStorage`, que en Windows usa DPAPI: el archivo copiado a otra
 * computadora u otro usuario de Windows no sirve para abrir la base.
 */
const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { configFile } = require('./paths.cjs');

const SECRET_KEYS = ['ownerPassword', 'appPassword', 'jwtAccess', 'jwtRefresh', 'encryptionKey'];

function load() {
  if (!existsSync(configFile)) return null;
  const raw = JSON.parse(readFileSync(configFile, 'utf8'));
  const secrets = raw.secrets ?? {};
  const out = { ...raw, secrets: {} };
  for (const key of SECRET_KEYS) {
    const value = secrets[key];
    if (!value) continue;
    out.secrets[key] = raw.encrypted
      ? safeStorage.decryptString(Buffer.from(value, 'base64'))
      : value;
  }
  return out;
}

function save(config) {
  mkdirSync(path.dirname(configFile), { recursive: true });
  const encrypted = safeStorage.isEncryptionAvailable();
  const secrets = {};
  for (const key of SECRET_KEYS) {
    const value = config.secrets?.[key];
    if (!value) continue;
    secrets[key] = encrypted ? safeStorage.encryptString(value).toString('base64') : value;
  }
  // Escritura atómica: un apagón a media escritura no deja un JSON truncado.
  const tmp = `${configFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...config, encrypted, secrets }, null, 2));
  renameSync(tmp, configFile);
}

function freshSecrets() {
  const token = (n) => randomBytes(n).toString('base64url');
  return {
    ownerPassword: token(24),
    appPassword: token(24),
    jwtAccess: token(48),
    jwtRefresh: token(48),
    encryptionKey: randomBytes(32).toString('base64'),
  };
}

module.exports = { load, save, freshSecrets };
