/**
 * Graba el video tutorial usando el sistema REAL.
 *
 *   electron tools/tutorial/record.cjs --creds <asistente.json> --out <carpeta> [--url http://localhost:3210] [--capturas]
 *
 * Abre el punto de venta en una ventana fuera de pantalla (1280×720), ejecuta
 * el guion de `script.cjs` con clics y teclas de verdad, y en otra ventana
 * oculta compone cada cuadro con un cursor animado y subtítulos, le suma la
 * narración (voz de Windows) y lo graba con MediaRecorder. Salen:
 *
 *   tutorial.webm  · el video
 *   tutorial.vtt   · subtítulos
 *   tutorial.json  · capítulos (la página web los muestra como índice)
 *   tutorial.jpg   · portada
 *
 * Usar SIEMPRE contra una instalación de demostración (tools/demo-data.mjs):
 * el guion abre caja, vende y hace un corte.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawnSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { STEPS } = require('./script.cjs');

const W = 1280;
const H = 720;
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_BASE = opt('url', 'http://localhost:3210');
const OUT = path.resolve(opt('out', 'tutorial-out'));
const CREDS = JSON.parse(readFileSync(opt('creds'), 'utf8'));
// No `--debug`: Electron lo toma como opción de Node y se niega a arrancar.
const DEBUG = args.includes('--capturas');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Narración: un WAV por paso con la voz en español de Windows ─────────────
function synthesize(steps, dir) {
  mkdirSync(dir, { recursive: true });
  const lines = steps.map((s, i) => ({ file: path.join(dir, `voz-${String(i).padStart(2, '0')}.wav`), text: s.say }));
  const listFile = path.join(dir, 'lineas.json');
  writeFileSync(listFile, JSON.stringify(lines), 'utf8');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$lines = Get-Content -Raw -Encoding UTF8 '${listFile}' | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' } | Select-Object -First 1
if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
$s.Rate = 1
foreach ($l in $lines) {
  $s.SetOutputToWaveFile($l.file)
  $s.Speak($l.text)
}
$s.SetOutputToNull()
`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`No se pudo generar la narración: ${r.stderr}`);
  return lines.map((l) => {
    const buf = readFileSync(l.file);
    const byteRate = buf.readUInt32LE(28);
    // Busca el bloque "data" para medir la duración exacta.
    let offset = 12;
    let dataSize = buf.length - 44;
    while (offset < buf.length - 8) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'data') {
        dataSize = size;
        break;
      }
      offset += 8 + size;
    }
    return { file: l.file, seconds: dataSize / byteRate };
  });
}

/**
 * MediaRecorder escribe el WebM sin duración: el navegador lo muestra como
 * transmisión en vivo y no deja saltar a un capítulo. Se agrega el elemento
 * Duration (0x4489) dentro de Segment › Info y se reescribe el tamaño de Info.
 */
function withDuration(buf, durationMs) {
  const vint = (pos) => {
    const first = buf[pos];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let value = first & (0xff >> len);
    for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
    return { len, value };
  };
  const idLen = (pos) => vint(pos).len;

  let pos = 0;
  // Encabezado EBML.
  pos += idLen(pos);
  const ebmlSize = vint(pos);
  pos += ebmlSize.len + ebmlSize.value;
  // Segment (tamaño desconocido): sus hijos empiezan aquí.
  pos += idLen(pos);
  pos += vint(pos).len;

  while (pos < buf.length) {
    const id = buf.readUInt32BE(pos);
    const il = idLen(pos);
    const size = vint(pos + il);
    const dataStart = pos + il + size.len;
    if (id === 0x1549a966) {
      const info = buf.subarray(dataStart, dataStart + size.value);
      if (info.includes(Buffer.from([0x44, 0x89]))) return buf;
      const duration = Buffer.alloc(11);
      duration[0] = 0x44;
      duration[1] = 0x89;
      duration[2] = 0x88;
      duration.writeDoubleBE(durationMs, 3);
      const newSize = size.value + duration.length;
      const sizeField = Buffer.alloc(8);
      sizeField[0] = 0x01;
      sizeField.writeUIntBE(newSize, 2, 6);
      return Buffer.concat([
        buf.subarray(0, pos + il),
        sizeField,
        info,
        duration,
        buf.subarray(dataStart + size.value),
      ]);
    }
    pos = dataStart + size.value;
  }
  return buf;
}

// ── Escenario: la app real fuera de pantalla ────────────────────────────────
function makeStage() {
  const stage = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    // Sesión en memoria: cada grabación empieza sin el correo recordado ni
    // cookies de la anterior, y el guion teclea siempre sobre campos vacíos.
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: `tutorial-${Date.now()}` },
  });
  stage.webContents.setFrameRate(30);
  return stage;
}

/** Utilidades que se inyectan en la página para encontrar cosas por su texto. */
const HELPERS = `
window.__pv = {
  visible(el) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  },
  norm(t) { return (t || '').replace(/\\s+/g, ' ').trim().toLowerCase(); },
  byText(text, selector) {
    const want = this.norm(text);
    const all = [...document.querySelectorAll(selector || 'button, a, [role=tab], [role=button], summary, tr, li')]
      .filter((el) => this.visible(el));
    const exact = all.filter((el) => this.norm(el.innerText) === want);
    const partial = all.filter((el) => this.norm(el.innerText).includes(want));
    const pick = (exact.length ? exact : partial).sort(
      (a, b) => a.innerText.length - b.innerText.length,
    )[0];
    return pick || null;
  },
  field(labelText) {
    const want = this.norm(labelText);
    const labels = [...document.querySelectorAll('label')].filter((l) => this.visible(l) && this.norm(l.innerText).startsWith(want));
    for (const l of labels) {
      const c = l.control || l.querySelector('input, select, textarea') ||
        (l.htmlFor && document.getElementById(l.htmlFor)) ||
        l.parentElement?.querySelector('input, select, textarea');
      if (c && this.visible(c)) return c;
    }
    const byAria = [...document.querySelectorAll('input, select, textarea')].find(
      (el) => this.visible(el) && (this.norm(el.getAttribute('aria-label')).startsWith(want) || this.norm(el.placeholder).startsWith(want)),
    );
    return byAria || null;
  },
  center(el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  },
};
true;
`;

async function main() {
  await app.whenReady();
  mkdirSync(OUT, { recursive: true });

  console.log('→ Generando la narración');
  const voices = synthesize(STEPS, path.join(OUT, 'voz'));

  const recorder = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  await recorder.loadFile(path.join(__dirname, 'recorder.html'));

  const stage = makeStage();
  stage.webContents.on('paint', (_e, _dirty, image) => {
    recorder.webContents.send('frame', image.toJPEG(88));
  });
  stage.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [página] ${message}`);
  });

  const cursor = { x: W / 2, y: H / 2 };
  const pageReady = async () => {
    for (let i = 0; i < 50; i++) {
      const ok = await stage.webContents
        .executeJavaScript('document.readyState === "complete"')
        .catch(() => false);
      if (ok) break;
      await sleep(100);
    }
    await stage.webContents.executeJavaScript(HELPERS);
  };

  /** Acciones que usa el guion. */
  const ui = {
    creds: CREDS,
    sleep,
    async goto(url) {
      await stage.loadURL(url.startsWith('http') ? url : URL_BASE + url);
      await pageReady();
      await sleep(600);
    },
    async locate(js, what) {
      for (let i = 0; i < 40; i++) {
        if (!(await stage.webContents.executeJavaScript('Boolean(window.__pv)').catch(() => false))) {
          await stage.webContents.executeJavaScript(HELPERS).catch(() => undefined);
        }
        const point = await stage.webContents.executeJavaScript(
          `(() => { const el = ${js}; return el ? window.__pv.center(el) : null; })()`,
        );
        if (point) return point;
        await sleep(150);
      }
      await shot(`falla-${Date.now()}`);
      throw new Error(`No se encontró: ${what}`);
    },
    async moveTo(point) {
      recorder.webContents.send('cursor', { ...point, ms: 450 });
      cursor.x = point.x;
      cursor.y = point.y;
      await sleep(480);
    },
    async clickAt(point) {
      await ui.moveTo(point);
      recorder.webContents.send('click');
      const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
      stage.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      stage.webContents.sendInputEvent({ ...base, type: 'mouseDown' });
      await sleep(60);
      stage.webContents.sendInputEvent({ ...base, type: 'mouseUp' });
      await sleep(350);
    },
    async click(text, selector) {
      const point = await ui.locate(
        `window.__pv.byText(${JSON.stringify(text)}, ${JSON.stringify(selector ?? null)})`,
        `«${text}»`,
      );
      await ui.clickAt(point);
    },
    async clickSelector(selector) {
      const point = await ui.locate(`document.querySelector(${JSON.stringify(selector)})`, selector);
      await ui.clickAt(point);
    },
    async field(label) {
      const point = await ui.locate(`window.__pv.field(${JSON.stringify(label)})`, `campo «${label}»`);
      await ui.clickAt(point);
      // Lo que se escriba reemplaza lo que hubiera en el campo.
      await ui.selectAll();
    },
    async type(text, perChar = 70) {
      for (const ch of String(text)) {
        stage.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        await sleep(perChar);
      }
      await sleep(200);
    },
    async key(name) {
      stage.webContents.sendInputEvent({ type: 'keyDown', keyCode: name });
      // El envío implícito de un formulario sale del `keypress`, no del keydown.
      if (name === 'Enter') stage.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      stage.webContents.sendInputEvent({ type: 'keyUp', keyCode: name });
      await sleep(450);
    },
    async selectAll() {
      stage.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      stage.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await sleep(100);
    },
    eval(js) {
      return stage.webContents.executeJavaScript(js);
    },
    async waitFor(js, what, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await stage.webContents.executeJavaScript(`Boolean(${js})`).catch(() => false)) return;
        await sleep(150);
      }
      await shot(`falla-${Date.now()}`);
      throw new Error(`No apareció: ${what}`);
    },
    async waitText(text, timeout) {
      await ui.waitFor(`document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`, `«${text}»`, timeout);
    },
  };

  async function shot(name) {
    const img = await stage.webContents.capturePage();
    writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
  }

  // Primer cuadro antes de empezar a grabar.
  await ui.goto('/');
  await sleep(800);

  recorder.webContents.send('start');
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const cues = [];
  const chapters = [];

  for (const [i, step] of STEPS.entries()) {
    console.log(`→ ${i + 1}/${STEPS.length} ${step.chapter ?? ''} ${step.say.slice(0, 50)}`);
    if (step.chapter) {
      chapters.push({ title: step.chapter, start: Math.max(0, Math.floor(now() * 10) / 10) });
      recorder.webContents.send('chapter', step.chapter);
    }
    if ('card' in step) recorder.webContents.send('card', step.card);
    const start = now();
    recorder.webContents.send('say', { file: voices[i].file, text: step.say });
    const speech = sleep(voices[i].seconds * 1000 + 350);
    await Promise.all([speech, step.do ? step.do(ui) : Promise.resolve()]);
    if (step.pause) await sleep(step.pause);
    cues.push({ start, end: now(), text: step.say });
    if (DEBUG) await shot(`paso-${String(i).padStart(2, '0')}`);
  }
  await sleep(800);

  // Portada: el tablero o la pantalla final.
  await shot('tutorial-portada');

  const done = new Promise((resolve) => ipcMain.once('video', (_e, data) => resolve(Buffer.from(data))));
  recorder.webContents.send('stop');
  const video = withDuration(await done, now() * 1000);
  writeFileSync(path.join(OUT, 'tutorial.webm'), video);

  const stamp = (s) => {
    const ms = Math.round(s * 1000);
    const hh = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const mm = String(Math.floor(ms / 60_000) % 60).padStart(2, '0');
    const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
  };
  writeFileSync(
    path.join(OUT, 'tutorial.vtt'),
    'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(OUT, 'tutorial.json'),
    JSON.stringify({ duration: Math.round(now()), chapters }, null, 2),
    'utf8',
  );
  console.log(`✓ Video de ${Math.round(now())} s · ${(video.length / 1024 / 1024).toFixed(1)} MB → ${OUT}`);
  app.exit(0);
}

main().catch((error) => {
  console.error('✗', error);
  app.exit(1);
});
