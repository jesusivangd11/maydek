#!/usr/bin/env node
/**
 * Prepara lo que la app de escritorio sirve y ejecuta:
 *
 *   build/ui/pos     → POS compilado para servirse desde el propio API (/)
 *   build/ui/admin   → panel compilado con base /admin/
 *   build/seed.cjs   → semilla de primer uso en un solo archivo
 *
 * Las pantallas se compilan con `VITE_API_URL=/api/v1` (misma origen que el
 * API, sin CORS) y `VITE_TARGET=desktop` (sin service worker: la base está en
 * el mismo equipo y una caché vieja solo estorbaría tras una actualización).
 * El API se compila aparte con `pnpm --filter @pv/api build`.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const out = path.join(desktop, 'build');
const only = process.argv[2]; // 'ui' | 'seed' | undefined (todo)

function vite(app, outDir, base) {
  console.log(`→ Compilando ${app} para escritorio`);
  const r = spawnSync(
    'pnpm',
    ['--filter', `@pv/${app}`, 'exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir', '--base', base],
    {
      cwd: repo,
      stdio: 'inherit',
      shell: true,
      // VITE_POS_URL: el botón «Abrir punto de venta» del panel.
      env: { ...process.env, VITE_API_URL: '/api/v1', VITE_TARGET: 'desktop', VITE_POS_URL: '/' },
    },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (only !== 'seed') {
  rmSync(path.join(out, 'ui'), { recursive: true, force: true });
  vite('pos', path.join(out, 'ui', 'pos'), '/');
  vite('admin', path.join(out, 'ui', 'admin'), '/admin/');
}

if (only !== 'ui') {
  console.log('→ Empaquetando la semilla de primer uso');
  // esbuild llega como dependencia de tsx en el API (pnpm no lo expone suelto).
  const apiRequire = createRequire(path.join(repo, 'apps', 'api', 'package.json'));
  const tsxRequire = createRequire(apiRequire.resolve('tsx/package.json'));
  const esbuild = tsxRequire('esbuild');
  mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(repo, 'apps', 'api', 'prisma', 'seed', 'index.ts')],
    outfile: path.join(out, 'seed.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Nativos o con binarios propios: se cargan desde node_modules del API.
    external: ['@prisma/client', '.prisma/client', 'argon2'],
    logLevel: 'warning',
  });
}
console.log('✓ Listo');
