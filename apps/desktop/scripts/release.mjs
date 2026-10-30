#!/usr/bin/env node
/**
 * Arma el instalador oficial de Windows (NSIS) de Maydek.
 *
 *   pnpm --filter @pv/desktop release            → instalador en la carpeta de salida
 *   pnpm --filter @pv/desktop release -- --skip-build   (reusa compilaciones)
 *
 * Todo lo pesado se prepara FUERA de OneDrive (en %LOCALAPPDATA%\punto-venta\
 * release): cientos de MB sincronizándose solo estorban. Dentro del
 * instalador, en resources/, viajan:
 *
 *   api/      el API con sus dependencias de producción (pnpm deploy) y el
 *             cliente de Prisma ya generado, con su motor para Windows
 *   pgsql/    PostgreSQL recortado: bin, lib y share (sin pgAdmin ni docs)
 *   ui/       POS y panel compilados        seed.cjs  semilla de primer uso
 *
 * Para publicar una versión: subir `version` en package.json, correr esto y
 * subir a la publicación de GitHub el .exe, el .blockmap y latest.yml.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const LOCAL = process.env.LOCALAPPDATA;
const stage = path.join(LOCAL, 'punto-venta', 'release');
const pgSource = process.env.PV_PG_HOME ?? path.join(LOCAL, 'punto-venta', 'postgres', 'pgsql');
const skipBuild = process.argv.includes('--skip-build');
// Reusa api/ y pgsql/ ya preparados (solo para reintentar el empaquetado).
const reuseStage = process.argv.includes('--reuse-stage');

function run(cmd, args, cwd = repo) {
  console.log(`→ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function sizeMb(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return Math.round(total / 1024 / 1024);
}

// ── 1. Compilaciones ─────────────────────────────────────────────────────────
if (!skipBuild) {
  run('pnpm', ['--filter', '@pv/shared-types', '--filter', '@pv/domain-rules', 'build']);
  run('pnpm', ['--filter', '@pv/api', 'build']);
  run('node', [path.join(here, 'build-ui.mjs')]);
}

// ── 2. API autónomo ──────────────────────────────────────────────────────────
const apiOut = path.join(stage, 'api');
const pgOut = path.join(stage, 'pgsql');

function stageApi() {
  rmSync(apiOut, { recursive: true, force: true });
  // hoisted: un node_modules plano, sin enlaces simbólicos que el instalador no sabe copiar.
  run('pnpm', ['--filter', '@pv/api', 'deploy', '--legacy', '--prod', '--config.node-linker=hoisted', `"${apiOut}"`]);

  // El deploy deja el cliente de Prisma sin generar (el CLI es de desarrollo):
  // se copia el que ya está generado, con el motor de Windows.
  const apiRequire = createRequire(path.join(repo, 'apps', 'api', 'package.json'));
  const prismaClientDir = path.dirname(apiRequire.resolve('@prisma/client/package.json'));
  const generated = path.resolve(prismaClientDir, '..', '..', '.prisma', 'client');
  if (!existsSync(path.join(generated, 'query_engine-windows.dll.node'))) {
    console.error(`✗ No está generado el cliente de Prisma en ${generated}. Corre: pnpm --filter @pv/api exec prisma generate`);
    process.exit(1);
  }
  const generatedOut = path.join(apiOut, 'node_modules', '.prisma', 'client');
  rmSync(generatedOut, { recursive: true, force: true });
  cpSync(generated, generatedOut, { recursive: true, filter: (src) => !/\.tmp\d*$/.test(src) });

  // Fuera lo que solo sirve para compilar o probar.
  const prune = [
    'src', 'test', 'scripts', '.turbo', 'nest-cli.json', 'prisma.config.ts', 'tsconfig.json',
    'tsconfig.build.json', 'vitest.config.ts', 'vitest.workspace.ts', 'prisma/seed',
    'node_modules/prisma', 'node_modules/typescript', 'node_modules/effect', 'node_modules/fast-check',
    'node_modules/@prisma/engines', 'node_modules/@prisma/fetch-engine', 'node_modules/@prisma/get-platform',
    'node_modules/.cache',
  ];
  for (const p of prune) rmSync(path.join(apiOut, p), { recursive: true, force: true });
  for (const name of readdirSync(apiOut)) {
    if (name.startsWith('.env')) rmSync(path.join(apiOut, name), { force: true });
  }
  console.log(`✓ API: ${sizeMb(apiOut)} MB`);
}

// ── 3. PostgreSQL recortado ──────────────────────────────────────────────────
function stagePostgres() {
  if (!existsSync(path.join(pgSource, 'bin', 'postgres.exe'))) {
    console.error(`✗ No encuentro PostgreSQL en ${pgSource} (define PV_PG_HOME).`);
    process.exit(1);
  }
  rmSync(pgOut, { recursive: true, force: true });
  for (const dir of ['bin', 'lib', 'share']) {
    cpSync(path.join(pgSource, dir), path.join(pgOut, dir), {
      recursive: true,
      // Bibliotecas de enlace y símbolos de depuración no hacen falta para correr.
      filter: (src) => !/\.(lib|pdb)$/i.test(src),
    });
  }
  console.log(`✓ PostgreSQL: ${sizeMb(pgOut)} MB`);
}

if (!reuseStage) {
  stageApi();
  stagePostgres();
}

// ── 4. Instalador ────────────────────────────────────────────────────────────
const desktopRequire = createRequire(path.join(desktop, 'package.json'));
const builder = desktopRequire('electron-builder');
const build = path.join(desktop, 'build');

console.log('→ Empaquetando el instalador');
const result = await builder.build({
  projectDir: desktop,
  targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
  publish: 'never',
  config: {
    appId: 'mx.maydek.pos',
    productName: 'Maydek',
    copyright: 'Maydek',
    directories: { output: path.join(stage, 'dist'), buildResources: path.join(desktop, 'src', 'assets') },
    files: ['src/**/*', 'package.json'],
    // El API va en afterPack: extraResources descarta cualquier node_modules.
    extraResources: [
      { from: pgOut, to: 'pgsql' },
      { from: path.join(build, 'ui'), to: 'ui' },
      { from: path.join(build, 'seed.cjs'), to: 'seed.cjs' },
    ],
    npmRebuild: false,
    nodeGypRebuild: false,
    afterPack: async ({ appOutDir }) => {
      const target = path.join(appOutDir, 'resources', 'api');
      rmSync(target, { recursive: true, force: true });
      cpSync(apiOut, target, { recursive: true });
      // Lo mínimo para que el API arranque; si falta, mejor no generar el instalador.
      for (const required of [
        'dist/main.js',
        'prisma/migrations',
        'node_modules/@nestjs/core',
        'node_modules/@prisma/client',
        'node_modules/.prisma/client/query_engine-windows.dll.node',
        'node_modules/argon2',
        'node_modules/@pv/shared-types/dist/index.js',
      ]) {
        if (!existsSync(path.join(target, required))) throw new Error(`Falta en el paquete: api/${required}`);
      }
      console.log(`  • API copiado al paquete (${sizeMb(target)} MB)`);
    },
    win: {
      icon: path.join(desktop, 'src', 'assets', 'maydek.ico'),
      // Nombre fijo: el enlace de la web (…/releases/latest/download/Maydek-Setup.exe)
      // siempre apunta a la versión más reciente sin tocar la página.
      artifactName: 'Maydek-Setup.${ext}',
      // Sin certificado de firma por ahora: Windows SmartScreen avisará la
      // primera vez («Más información» → «Ejecutar de todas formas»).
      signAndEditExecutable: true,
    },
    nsis: {
      oneClick: false,
      perMachine: false, // por usuario: las actualizaciones no piden permisos de administrador
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      shortcutName: 'Maydek',
      uninstallDisplayName: 'Maydek',
      installerIcon: path.join(desktop, 'src', 'assets', 'maydek.ico'),
      uninstallerIcon: path.join(desktop, 'src', 'assets', 'maydek.ico'),
      installerLanguages: ['es_ES'],
      language: '3082',
      // Los datos (base, respaldos) viven en %LOCALAPPDATA%\Maydek y NUNCA se borran al desinstalar.
      deleteAppDataOnUninstall: false,
    },
    // De aquí lee electron-updater dónde buscar versiones nuevas.
    publish: [{ provider: 'github', owner: 'jesusivangd11', repo: 'maydek-releases', releaseType: 'release' }],
  },
});

console.log('✓ Listo:');
for (const file of result) console.log(`   ${file}`);

// La web muestra la versión y el tamaño del instalador: se actualizan aquí para
// que nunca queden atrás de lo publicado. (Después hay que desplegar la web.)
{
  const webConfig = path.join(desktop, '..', 'web', 'src', 'config.js');
  const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
  const installer = path.join(stage, 'dist', 'Maydek-Setup.exe');
  if (existsSync(webConfig) && existsSync(installer)) {
    const size = `${Math.round(statSync(installer).size / 1024 / 1024)} MB`;
    const next = readFileSync(webConfig, 'utf8')
      .replace(/version: '[^']*',/, `version: '${version}',`)
      .replace(/size: '[^']*',/, `size: '${size}',`);
    writeFileSync(webConfig, next);
    console.log(`✓ Web: versión ${version} · ${size} (falta desplegar apps/web)`);
  }
}
