/**
 * Maydek — aplicación de escritorio.
 *
 * Todo corre en la computadora de la tienda: PostgreSQL local, el API y las
 * pantallas del punto de venta y de administración. Internet solo hace falta
 * para descargar actualizaciones y para el soporte en línea.
 *
 * Dos modos, elegidos en el asistente de primer uso:
 *   · principal: tiene la base de datos. Si se activa «red local», las demás
 *     cajas de la tienda se conectan a este equipo.
 *   · caja en red: no guarda datos; abre las pantallas del equipo principal.
 */
const os = require('node:os');
const path = require('node:path');
const { existsSync } = require('node:fs');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  dialog,
  ipcMain,
  shell,
} = require('electron');
const paths = require('./paths.cjs');
const store = require('./config.cjs');
const db = require('./database.cjs');
const services = require('./services.cjs');

/** Mismos datos que la página web (apps/web/src/config.js). */
const SUPPORT = {
  email: 'jesus.ivan.gd11@gmail.com',
  phone: '614 133 6763',
  whatsapp: '526141336763',
  hours: 'Lunes a sábado de 9:00 a 19:00 (hora del centro de México)',
};
const ICON = path.join(__dirname, 'assets', 'icon.png');

let config = null;
let baseUrl = null;
let posWindow = null;
let adminWindow = null;
let splash = null;
let quitting = false;

// El perfil de Electron (donde vive la llave de safeStorage) va junto a los
// datos y no en %APPDATA%\<nombre del producto>: si el nombre comercial
// cambia, la configuración cifrada se sigue pudiendo leer.
app.setPath('userData', path.join(paths.dataDir, 'electron'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = posWindow ?? splash;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(boot);
}

// ── Ventanas ─────────────────────────────────────────────────────────────────

let splashText = '';

function showSplash(text) {
  if (text) splashText = text;
  if (splash) {
    splash.webContents.send('progress', splashText);
  } else {
    splash = new BrowserWindow({
      width: 460,
      height: 300,
      frame: false,
      resizable: false,
      show: false,
      icon: ICON,
      backgroundColor: '#0f2a6b',
      webPreferences: { preload: path.join(__dirname, 'setup-preload.cjs') },
    });
    splash.loadFile(path.join(__dirname, 'splash.html'));
    // Lo que se reporta antes de que cargue la página se manda al terminar.
    splash.webContents.on('did-finish-load', () => splash?.webContents.send('progress', splashText));
    splash.once('ready-to-show', () => splash?.show());
    splash.on('closed', () => (splash = null));
  }
}

/** Ventana del asistente de primer uso. Resuelve con lo que eligió el dueño. */
function runSetupWizard(onlyBusiness) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 760,
      height: 720,
      minWidth: 640,
      title: 'Maydek — Configuración inicial',
      icon: ICON,
      backgroundColor: '#f4f6fb',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'setup-preload.cjs') },
    });
    win.loadFile(path.join(__dirname, 'setup.html'), {
      query: {
        onlyBusiness: onlyBusiness ? '1' : '0',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    splash?.close();

    const handler = async (_event, data) => {
      try {
        await (data.mode === 'client' ? setupClient(data, win) : setupServer(data, win, onlyBusiness));
        ipcMain.removeHandler('setup:submit');
        win.removeAllListeners('closed');
        resolve(win);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    ipcMain.handle('setup:submit', handler);
    win.on('closed', () => {
      ipcMain.removeHandler('setup:submit');
      if (!quitting) app.quit();
    });
  });
}

function openPos() {
  posWindow = new BrowserWindow({
    width: 1366,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Maydek — Caja',
    icon: ICON,
    backgroundColor: '#f4f6fb',
    webPreferences: { sandbox: true },
  });
  guard(posWindow);
  posWindow.loadURL(`${baseUrl}/`);
  posWindow.once('ready-to-show', () => {
    posWindow.maximize();
    posWindow.show();
    splash?.close();
  });
  posWindow.on('closed', () => {
    posWindow = null;
    if (!quitting) app.quit();
  });
}

function openAdmin() {
  if (adminWindow) return adminWindow.focus();
  adminWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    show: false,
    title: 'Maydek — Administración',
    icon: ICON,
    backgroundColor: '#f4f6fb',
    webPreferences: { sandbox: true },
  });
  guard(adminWindow);
  adminWindow.loadURL(`${baseUrl}/admin/`);
  adminWindow.once('ready-to-show', () => {
    adminWindow.maximize();
    adminWindow.show();
  });
  adminWindow.on('closed', () => (adminWindow = null));
}

/**
 * Las pantallas solo navegan dentro del sistema. Cualquier enlace externo
 * (soporte, la página web) se abre en el navegador del equipo, nunca dentro
 * de la app con sus permisos.
 */
function guard(win) {
  const internal = (url) => url.startsWith(`${baseUrl}/`) || url === baseUrl;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${baseUrl}/admin`)) {
      openAdmin();
    } else if (internal(url)) {
      posWindow?.focus();
    } else if (/^https?:\/\//.test(url) && !internal(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!internal(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  // El título lo pone la app, no la página.
  win.on('page-title-updated', (event) => event.preventDefault());
}

// ── Arranque ─────────────────────────────────────────────────────────────────

async function boot() {
  trace(`inicio ${app.getVersion()}`);
  buildMenu();
  try {
    config = store.load();
    if (!config && !app.isPackaged && process.env.PV_AUTOSETUP) {
      // Solo en desarrollo: primer arranque sin asistente, para pruebas.
      const data = JSON.parse(require('node:fs').readFileSync(process.env.PV_AUTOSETUP, 'utf8'));
      showSplash('Configuración automática de prueba…');
      await setupServer(data, splash, false);
      finishBoot(null);
      return;
    }
    if (!config) {
      const wizard = await runSetupWizard(false);
      finishBoot(wizard);
      return;
    }

    if (config.mode === 'client') {
      showSplash('Conectando con la caja principal…');
      await waitForServer(config.serverUrl);
      baseUrl = config.serverUrl;
      openPos();
      return;
    }

    showSplash('Iniciando la base de datos…');
    await db.start();
    showSplash('Revisando actualizaciones de la base…');
    await db.migrate(config, showSplash);

    if (!(await db.hasUsers(config))) {
      // La base existe pero el asistente se cerró antes de terminar.
      const wizard = await runSetupWizard(true);
      finishBoot(wizard);
      return;
    }

    showSplash('Abriendo el punto de venta…');
    baseUrl = await services.startApi(config);
    openPos();
    scheduleBackups();
  } catch (error) {
    fatal(error);
  }
}

function finishBoot(wizard) {
  openPos();
  if (wizard) posWindow.once('ready-to-show', () => wizard.close());
  if (config.mode !== 'client') scheduleBackups();
}

async function setupServer(data, win, onlyBusiness) {
  const report = (text) => win.webContents.send('progress', text);
  if (!onlyBusiness) {
    if (!db.binariesPresent()) {
      throw new Error(
        'No se encontraron los archivos de la base de datos. Reinstala el programa.',
      );
    }
    const lan = Boolean(data.lan);
    config = {
      mode: 'server',
      lan,
      pgPort: await services.findFreePort(54329),
      port: await services.findFreePort(3210, lan ? '0.0.0.0' : '127.0.0.1'),
      createdAt: new Date().toISOString(),
      lastBackupAt: null,
      backupMirrorDir: null,
      secrets: store.freshSecrets(),
    };
    await db.initCluster(config, report);
    // Se guarda en cuanto existe el clúster: sin las contraseñas, la base
    // recién creada quedaría inaccesible si algo falla después.
    store.save(config);
    report('Creando las tablas…');
    await db.migrate(config, report);
  }
  report('Registrando tu negocio y tu usuario…');
  await services.runSeed(config, {
    companyName: data.companyName.trim(),
    rfc: data.rfc?.trim().toUpperCase(),
    branchName: data.branchName?.trim() || 'Tienda principal',
    timezone: data.timezone,
    adminName: data.adminName.trim(),
    adminEmail: data.adminEmail.trim().toLowerCase(),
    adminPassword: data.adminPassword,
    adminPin: data.adminPin,
  });
  report('Abriendo el punto de venta…');
  baseUrl = await services.startApi(config);
}

async function setupClient(data, win) {
  const url = normalizeServerUrl(data.serverUrl);
  win.webContents.send('progress', 'Buscando la caja principal…');
  await waitForServer(url, 8000);
  config = { mode: 'client', serverUrl: url, createdAt: new Date().toISOString(), secrets: {} };
  store.save(config);
  baseUrl = url;
}

function normalizeServerUrl(input) {
  let value = String(input ?? '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('Escribe la dirección de la caja principal.');
  if (!/^https?:\/\//.test(value)) value = `http://${value}`;
  if (!/:\d+$/.test(new URL(value).host)) value = `${value}:3210`;
  return value;
}

async function waitForServer(url, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/v1/health/ready`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `No se pudo conectar con la caja principal en ${url}. ` +
      'Verifica que esté encendida, con el sistema abierto y en la misma red.' +
      (lastError instanceof Error ? `\n(${lastError.message})` : ''),
  );
}

function fatal(error) {
  trace(`error fatal: ${error instanceof Error ? error.stack : String(error)}`);
  splash?.close();
  dialog.showErrorBox(
    'Maydek no pudo iniciar',
    `${error instanceof Error ? error.message : String(error)}\n\n` +
      `Registros: ${path.dirname(paths.apiLog)}\n` +
      'Si el problema sigue, abre un ticket de soporte y adjunta esos archivos.',
  );
  shutdown().finally(() => app.exit(1));
}

// ── Respaldos automáticos ────────────────────────────────────────────────────

const BACKUP_EVERY_MS = 20 * 3_600_000;

function scheduleBackups() {
  const check = () => {
    const last = config.lastBackupAt ? Date.parse(config.lastBackupAt) : 0;
    if (Date.now() - last >= BACKUP_EVERY_MS) void backupNow(false);
  };
  // Un minuto después de abrir, para no competir con el arranque.
  setTimeout(check, 60_000);
  setInterval(check, 3_600_000);
}

async function backupNow(interactive) {
  try {
    const result = await db.backup(config);
    config.lastBackupAt = new Date().toISOString();
    store.save(config);
    if (interactive) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Respaldo',
        message: 'Respaldo creado y verificado.',
        detail: `${result.file}\n${(result.size / 1024 / 1024).toFixed(2)} MB` +
          (result.mirrored ? `\nCopia extra: ${result.mirrored}` : ''),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interactive) dialog.showErrorBox('El respaldo falló', message);
    else new Notification({ title: 'El respaldo automático falló', body: message }).show();
  }
}

async function chooseMirror() {
  const r = await dialog.showOpenDialog({
    title: 'Carpeta para una copia extra de cada respaldo',
    message: 'Elige una memoria USB, un disco externo o una carpeta de tu nube.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  config.backupMirrorDir = r.filePaths[0];
  store.save(config);
  await backupNow(true);
}

async function restoreBackup() {
  const r = await dialog.showOpenDialog({
    title: 'Restaurar un respaldo',
    defaultPath: paths.backupDir,
    filters: [{ name: 'Respaldos', extensions: ['dump'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancelar', 'Restaurar'],
    defaultId: 0,
    cancelId: 0,
    title: 'Restaurar un respaldo',
    message: '¿Reemplazar toda la información actual por la del respaldo?',
    detail:
      `${path.basename(r.filePaths[0])}\n\nAntes se hará un respaldo de lo que hay ahora, ` +
      'por si necesitas regresar. Cierra la caja en las demás computadoras antes de continuar.',
  });
  if (confirm.response !== 1) return;
  try {
    await services.stopApi();
    const safety = await db.restore(config, r.filePaths[0]);
    baseUrl = await services.startApi(config);
    posWindow?.reload();
    adminWindow?.reload();
    dialog.showMessageBox({
      type: 'info',
      title: 'Respaldo restaurado',
      message: 'La información se restauró.',
      detail: `Lo que había antes quedó guardado en:\n${safety.file}`,
    });
  } catch (error) {
    dialog.showErrorBox('No se pudo restaurar', error instanceof Error ? error.message : String(error));
    baseUrl = await services.startApi(config).catch(() => baseUrl);
  }
}

// ── Menú ─────────────────────────────────────────────────────────────────────

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function showConnectInfo() {
  if (config?.mode !== 'server') {
    dialog.showMessageBox({
      type: 'info',
      title: 'Caja en red',
      message: 'Este equipo es una caja conectada.',
      detail: `Caja principal: ${config?.serverUrl ?? '—'}`,
    });
    return;
  }
  if (!config.lan) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Conectar otra caja',
      message: 'La red local está desactivada en este equipo.',
      detail:
        'Para que otras computadoras de la tienda usen este sistema, vuelve a instalar ' +
        'eligiendo «Otras cajas se conectarán a este equipo», o pide ayuda a soporte.',
    });
    return;
  }
  const ips = lanAddresses();
  dialog.showMessageBox({
    type: 'info',
    title: 'Conectar otra caja',
    message: 'En la otra computadora instala Maydek, elige «Caja en red» y escribe:',
    detail:
      (ips.length ? ips.map((ip) => `${ip}:${config.port}`).join('\n') : 'Este equipo no está en ninguna red.') +
      '\n\nSi Windows pregunta, permite el acceso en redes privadas.',
  });
}

async function showSupport() {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Soporte técnico',
    message: 'Te ayudamos en español, por personas.',
    detail:
      `Correo: ${SUPPORT.email}\nTeléfono: ${SUPPORT.phone}\n${SUPPORT.hours}\n\n` +
      `Ten a la mano la versión: ${app.getVersion()}.`,
    buttons: ['Cerrar', 'Escribir por WhatsApp', 'Enviar correo'],
    cancelId: 0,
  });
  if (response === 1) shell.openExternal(`https://wa.me/${SUPPORT.whatsapp}`);
  if (response === 2) {
    shell.openExternal(
      `mailto:${SUPPORT.email}?subject=${encodeURIComponent(`Soporte Maydek ${app.getVersion()}`)}`,
    );
  }
}

function buildMenu() {
  const server = () => config?.mode === 'server';
  const template = [
    {
      label: 'Sistema',
      submenu: [
        { label: 'Caja', accelerator: 'CmdOrCtrl+1', click: () => posWindow?.focus() },
        { label: 'Administración', accelerator: 'CmdOrCtrl+2', click: () => baseUrl && openAdmin() },
        { type: 'separator' },
        {
          label: 'Recargar pantalla',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, win) => win?.webContents.reload(),
        },
        // F11 es «Mayoreo» en la caja: la pantalla completa no puede quedárselo.
        { label: 'Pantalla completa', role: 'togglefullscreen', accelerator: 'CmdOrCtrl+Shift+F' },
        { label: 'Acercar', role: 'zoomIn' },
        { label: 'Alejar', role: 'zoomOut' },
        { label: 'Tamaño normal', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' },
      ],
    },
    {
      label: 'Respaldos',
      submenu: [
        { label: 'Respaldar ahora', click: () => server() && backupNow(true) },
        {
          label: 'Abrir carpeta de respaldos',
          click: () => shell.openPath(paths.backupDir),
        },
        { label: 'Guardar también una copia en…', click: () => server() && chooseMirror() },
        { type: 'separator' },
        { label: 'Restaurar un respaldo…', click: () => server() && restoreBackup() },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Conectar otra caja', click: showConnectInfo },
        { label: 'Soporte técnico', click: showSupport },
        { label: 'Abrir registros', click: () => shell.openPath(path.dirname(paths.apiLog)) },
        ...(!app.isPackaged
          ? [{ label: 'Herramientas de desarrollo', role: 'toggleDevTools' }]
          : []),
        { type: 'separator' },
        {
          label: 'Acerca de Maydek',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'Acerca de',
              message: `Maydek ${app.getVersion()}`,
              detail:
                `Punto de venta, inventario y administración.\n` +
                `Datos: ${paths.dataDir}\n` +
                (config?.mode === 'client' ? `Caja principal: ${config.serverUrl}` : ''),
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Cierre ───────────────────────────────────────────────────────────────────

function trace(message) {
  try {
    require('node:fs').mkdirSync(path.dirname(paths.apiLog), { recursive: true });
    require('node:fs').appendFileSync(
      path.join(path.dirname(paths.apiLog), 'app.log'),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    // El registro nunca debe impedir cerrar.
  }
}

async function shutdown() {
  trace('cerrando: deteniendo el servidor interno');
  await services.stopApi();
  if (config?.mode === 'server' && existsSync(paths.pgData)) {
    trace('cerrando: deteniendo la base de datos');
    await db.stop();
  }
  trace('cerrado');
}

// Cerrar la última ventana dispara `quit` más de una vez (la ventana y
// `window-all-closed`). Todas se frenan hasta que la base quede detenida; si
// una sola pasara, el proceso saldría con PostgreSQL todavía encendido.
let shutdownPromise = null;
app.on('before-quit', (event) => {
  event.preventDefault();
  quitting = true;
  shutdownPromise ??= shutdown().finally(() => app.exit(0));
});

// Apagado o reinicio de Windows con la app abierta: se detiene la base a
// tiempo en vez de dejar que el sistema mate el proceso a medias.
app.on('session-end', () => {
  trace('fin de sesión de Windows');
  quitting = true;
  shutdownPromise ??= shutdown();
});

app.on('window-all-closed', () => app.quit());
