/**
 * Actualizaciones automáticas.
 *
 * Al abrir, si hay internet, se busca una versión nueva y se descarga en
 * segundo plano sin interrumpir la venta. Se instala al CERRAR el programa,
 * después de detener PostgreSQL (nunca con la base encendida), y al volver a
 * abrir ya corre la versión nueva, que aplica sola sus migraciones.
 *
 * Sin internet no pasa nada: el error se anota en el registro y la caja sigue
 * funcionando igual. Solo aplica instalado; en desarrollo no hace nada.
 */
const { app, Notification } = require('electron');

let updater = null;
let ready = null; // versión descargada y lista para instalar
let log = () => {};

function start(trace) {
  log = trace;
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (error) {
    log(`actualizaciones: no se pudo cargar el actualizador (${error.message})`);
    return;
  }
  updater.autoDownload = true;
  // La instalación la dispara `installIfReady` cuando la base ya se detuvo:
  // el cierre normal termina con app.exit() y no pasa por el evento `quit`.
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: () => {}, warn: (m) => log(`actualizaciones: ${m}`), error: (m) => log(`actualizaciones: ${m}`), debug: () => {} };

  updater.on('update-downloaded', (info) => {
    ready = info.version;
    log(`actualizaciones: ${info.version} descargada; se instala al cerrar`);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Actualización lista',
        body: `Maydek ${info.version} se instalará la próxima vez que cierres el programa.`,
      }).show();
    }
  });
  updater.on('error', (error) => log(`actualizaciones: ${error?.message ?? error}`));

  const check = () => updater.checkForUpdates().catch(() => {});
  // Unos segundos después de abrir, para no competir con el arranque, y
  // luego cada 6 horas para las cajas que nunca se cierran.
  setTimeout(check, 15_000);
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

/** Lanza el instalador si hay una versión descargada. Devuelve si lo hizo. */
function installIfReady() {
  if (!updater || !ready) return false;
  log(`actualizaciones: instalando ${ready}`);
  // Silenciosa y sin volver a abrir: quien cerró el programa no lo espera abierto.
  updater.quitAndInstall(true, false);
  return true;
}

module.exports = { start, installIfReady, pending: () => ready };
