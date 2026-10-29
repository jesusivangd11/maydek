/**
 * Dónde está cada pieza, en desarrollo y ya instalado.
 *
 * En desarrollo se usan las compilaciones del monorepo y los binarios de
 * PostgreSQL que descargó `pnpm setup:local-db`. Instalado, todo viaja dentro
 * de `resources/` (lo arma el instalador). Los DATOS nunca van junto al
 * programa: viven en %LOCALAPPDATA%\Maydek, fuera de Archivos de
 * programa (que no se puede escribir) y fuera de OneDrive (un clúster activo
 * dentro de una carpeta sincronizada se corrompe).
 */
const path = require('node:path');
const { app } = require('electron');

const LOCAL = process.env.LOCALAPPDATA ?? path.join(require('node:os').homedir(), 'AppData', 'Local');
const dataDir = process.env.PV_DESKTOP_DATA ?? path.join(LOCAL, 'Maydek');

function resources() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      apiMain: path.join(res, 'api', 'dist', 'main.js'),
      apiNodeModules: path.join(res, 'api', 'node_modules'),
      migrations: path.join(res, 'api', 'prisma', 'migrations'),
      seed: path.join(res, 'seed.cjs'),
      ui: path.join(res, 'ui'),
      pgBin: path.join(res, 'pgsql', 'bin'),
    };
  }
  const repo = path.resolve(__dirname, '..', '..', '..');
  return {
    apiMain: path.join(repo, 'apps', 'api', 'dist', 'main.js'),
    apiNodeModules: path.join(repo, 'apps', 'api', 'node_modules'),
    migrations: path.join(repo, 'apps', 'api', 'prisma', 'migrations'),
    seed: path.join(__dirname, '..', 'build', 'seed.cjs'),
    ui: path.join(__dirname, '..', 'build', 'ui'),
    pgBin:
      process.env.PV_PG_BIN ?? path.join(LOCAL, 'punto-venta', 'postgres', 'pgsql', 'bin'),
  };
}

module.exports = {
  dataDir,
  pgData: path.join(dataDir, 'pgdata'),
  pgLog: path.join(dataDir, 'logs', 'postgres.log'),
  apiLog: path.join(dataDir, 'logs', 'api.log'),
  backupDir: path.join(dataDir, 'respaldos'),
  configFile: path.join(dataDir, 'config.json'),
  resources,
};
