import { SITE } from './config.js';

/**
 * Comportamiento del sitio público.
 *
 * Sin framework a propósito: es una página de presentación y tiene que cargar
 * rápido en un celular con datos limitados. Lo único que habla con el sistema
 * es el formulario de soporte, contra el endpoint público de tickets.
 */

const API = import.meta.env.VITE_API_URL;

// Sin servidor de tickets (sitio publicado solo como página), la consulta de
// folios no tiene a quién preguntar: se retira en vez de fallar.
if (!API) {
  document.querySelectorAll('[data-tab="track"], [data-goto-tab="track"]').forEach((el) => el.remove());
}
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ── Datos de configuración en la página ─────────────────────────────────────
$$('[data-brand]').forEach((el) => (el.textContent = SITE.brand));
$$('[data-tagline]').forEach((el) => (el.textContent = SITE.tagline));
$$('[data-year]').forEach((el) => (el.textContent = String(new Date().getFullYear())));

// ── Descarga: si hay instalador publicado, el botón lo descarga; si no, abre
// el formulario para pedirlo junto con la licencia. ────────────────────────
const download = $('[data-download]');
if (download && SITE.download.url) {
  download.setAttribute('href', SITE.download.url);
  download.removeAttribute('data-open-form');
  download.setAttribute('download', '');
  const meta = $('[data-download-meta]');
  if (meta) meta.textContent = [`Versión ${SITE.download.version}`, SITE.download.size].filter(Boolean).join(' · ');
  $('[data-download-note]')?.remove();
}

// ── Video tutorial: capítulos desde el índice que genera la grabación ───────
const video = $('[data-tutorial]');
const chapters = $('[data-chapters]');
if (video && chapters) {
  fetch('/video/tutorial.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((index) => {
      if (!index?.chapters?.length) return;
      const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      chapters.innerHTML = index.chapters
        .map(
          (c, i) => `<li><button type="button" data-seek="${c.start}">
            <span class="tutorial__num">${i + 1}</span>
            <span class="tutorial__title">${escapeHtml(c.title)}</span>
            <span class="tutorial__time">${clock(c.start)}</span></button></li>`,
        )
        .join('');
      const buttons = $$('[data-seek]', chapters);
      buttons.forEach((b) =>
        b.addEventListener('click', () => {
          video.currentTime = Number(b.dataset.seek);
          void video.play();
        }),
      );
      // Marca el capítulo que se está viendo.
      video.addEventListener('timeupdate', () => {
        let current = 0;
        index.chapters.forEach((c, i) => {
          if (video.currentTime >= c.start) current = i;
        });
        buttons.forEach((b, i) => b.classList.toggle('is-current', i === current));
      });
    })
    .catch(() => undefined);
}

const hours = $('[data-hours]');
if (hours) {
  hours.textContent = `Abre un ticket a cualquier hora y te respondemos por correo. Atención: ${SITE.contact.hours}.`;
}

// ── Menú en celular ─────────────────────────────────────────────────────────
const toggle = $('.menu-toggle');
const nav = $('#menu');
toggle?.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  toggle.setAttribute('aria-expanded', String(open));
});
$$('#menu a').forEach((a) =>
  a.addEventListener('click', () => {
    nav.classList.remove('is-open');
    toggle?.setAttribute('aria-expanded', 'false');
  }),
);

// ── Precios ─────────────────────────────────────────────────────────────────
let billing = 'monthly';
const plansRoot = $('[data-plans]');
const saveLabel = $('[data-save]');
if (saveLabel) {
  const free = 12 - SITE.annualMonthsCharged;
  saveLabel.textContent = `${free} meses gratis`;
}

function renderPlans() {
  if (!plansRoot) return;
  plansRoot.innerHTML = SITE.plans
    .map((plan) => {
      const annual = billing === 'annual';
      const perMonth = annual ? (plan.monthly * SITE.annualMonthsCharged) / 12 : plan.monthly;
      const note = annual
        ? `${money.format(plan.monthly * SITE.annualMonthsCharged)} al año`
        : 'Pago mes a mes';
      return `
        <article class="plan ${plan.highlighted ? 'plan--highlight' : ''}">
          ${plan.highlighted ? '<span class="plan__tag">El más elegido</span>' : ''}
          <h3>${plan.name}</h3>
          <p class="plan__audience">${plan.audience}</p>
          <div class="plan__price">
            <span class="plan__amount">${money.format(Math.round(perMonth))}</span>
            <span class="plan__per">/ mes</span>
          </div>
          <p class="plan__note">${note}</p>
          <div class="plan__limits">${plan.limits.map((l) => `<span>${l}</span>`).join('')}</div>
          <ul>${plan.features.map((f) => `<li>${f}</li>`).join('')}</ul>
          <a class="btn ${plan.highlighted ? 'btn--primary' : 'btn--ghost'} btn--lg" href="#soporte"
             data-open-form="SALES" data-plan="${plan.id}">Contratar ${plan.name}</a>
        </article>`;
    })
    .join('');
}
renderPlans();

$$('[data-billing]').forEach((button) =>
  button.addEventListener('click', () => {
    billing = button.dataset.billing;
    $$('[data-billing]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    renderPlans();
  }),
);

// ── Pestañas de soporte ─────────────────────────────────────────────────────
function showTab(name) {
  $$('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
}
$$('[data-tab]').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
$$('[data-goto-tab]').forEach((a) => a.addEventListener('click', () => showTab(a.dataset.gotoTab)));

// ── Formulario de ticket ────────────────────────────────────────────────────
const form = $('[data-panel="ticket"]');
const kind = form?.elements.namedItem('kind');
const planField = $('[data-plan-field]');
const planSelect = $('[data-plan-select]');
if (planSelect) {
  planSelect.innerHTML =
    '<option value="">Aún no lo sé</option>' +
    SITE.plans.map((p) => `<option value="${p.id}">${p.name} · ${money.format(p.monthly)}/mes</option>`).join('');
}

function syncKind() {
  if (planField) planField.hidden = kind?.value !== 'SALES';
}
kind?.addEventListener('change', syncKind);

// Cualquier botón "Solicitar demostración" o "Contratar" abre el formulario
// ya preparado: tipo ventas y, si viene de un plan, con ese plan elegido.
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-open-form]');
  if (!trigger || !form) return;
  showTab('ticket');
  kind.value = trigger.dataset.openForm;
  syncKind();
  if (trigger.dataset.plan) planSelect.value = trigger.dataset.plan;
  const subject = form.elements.namedItem('subject');
  if (!subject.value && trigger.dataset.openForm === 'SALES') {
    subject.value = trigger.dataset.plan
      ? `Quiero contratar el plan ${SITE.plans.find((p) => p.id === trigger.dataset.plan)?.name ?? ''}`
      : 'Quiero una demostración';
  }
  setTimeout(() => form.elements.namedItem('name').focus({ preventScroll: true }), 400);
});

function setMessage(target, text, tone) {
  target.textContent = text;
  target.className = `form-msg ${tone ? `form-msg--${tone}` : ''}`;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('.form-msg', form);
  $$('input, textarea', form).forEach((el) => el.setAttribute('data-touched', ''));

  if (!form.checkValidity()) {
    const first = $$('input, textarea, select', form).find((el) => !el.checkValidity());
    setMessage(msg, first?.name === 'consent' ? 'Acepta el aviso de privacidad para continuar.' : 'Revisa los campos marcados.', 'error');
    first?.focus();
    return;
  }

  const data = Object.fromEntries(new FormData(form).entries());
  if (data.website) return; // Bot: el campo trampa vino lleno.
  if (!API) {
    sendByEmail(data);
    return;
  }
  const button = $('button[type="submit"]', form);
  button.disabled = true;
  setMessage(msg, 'Enviando…');

  try {
    const response = await fetch(`${API}/public/support-tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: data.kind,
        name: data.name,
        email: data.email,
        phone: data.phone || undefined,
        company: data.company || undefined,
        plan: data.kind === 'SALES' && data.plan ? data.plan : undefined,
        subject: data.subject,
        message: data.message,
        website: data.website || undefined,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? 'Enviaste varias solicitudes seguidas. Espera un minuto e inténtalo de nuevo.'
          : (body?.error?.message ?? 'No se pudo enviar la solicitud.'),
      );
    }

    form.innerHTML = `
      <div class="success-box">
        <h3>¡Recibimos tu solicitud!</h3>
        <p style="margin:10px 0">Tu folio es <strong>${body.folio}</strong>. Guárdalo: con él y tu correo
        puedes consultar la respuesta en «Consultar mi ticket».</p>
        <p class="muted">Te escribiremos a <b>${escapeHtml(data.email)}</b>.</p>
      </div>`;
  } catch (error) {
    setMessage(
      msg,
      error instanceof TypeError
        ? 'No pudimos conectar con el servidor. Revisa tu conexión o escríbenos por otro canal.'
        : error.message,
      'error',
    );
    button.disabled = false;
  }
});

/**
 * Sin servidor de tickets: la solicitud se arma como correo (y como mensaje
 * de WhatsApp, por si la persona no tiene correo configurado en el equipo).
 */
function sendByEmail(data) {
  const KIND = { SUPPORT: 'Soporte', SALES: 'Ventas', CONTACT: 'Contacto' };
  const plan = data.kind === 'SALES' && data.plan ? SITE.plans.find((p) => p.id === data.plan)?.name : '';
  const details = [
    `Nombre: ${data.name}`,
    `Correo: ${data.email}`,
    data.phone && `Teléfono: ${data.phone}`,
    data.company && `Negocio: ${data.company}`,
    plan && `Plan de interés: ${plan}`,
  ].filter(Boolean);
  const body = `${data.message}\n\n${details.join('\n')}`;
  const subject = `[${KIND[data.kind] ?? 'Contacto'}] ${data.subject}`;
  const c = SITE.contact;
  const mail = `mailto:${c.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const wa = c.whatsapp ? `https://wa.me/${c.whatsapp}?text=${encodeURIComponent(`${subject}\n\n${body}`)}` : '';

  form.innerHTML = `
    <div class="success-box">
      <h3>Tu solicitud está lista para enviarse</h3>
      <p style="margin:10px 0">Se abrió tu programa de correo con el mensaje escrito: solo pulsa <b>Enviar</b>.
      Si no se abrió, elige cómo mandarla:</p>
      <div class="form-foot">
        <a class="btn btn--primary" href="${mail}">Enviar por correo</a>
        ${wa ? `<a class="btn btn--ghost" href="${wa}" target="_blank" rel="noreferrer">Enviar por WhatsApp</a>` : ''}
      </div>
      <p class="muted" style="margin-top:12px">Te responderemos a <b>${escapeHtml(data.email)}</b>.</p>
    </div>`;
  window.location.href = mail;
}

// ── Consultar ticket ────────────────────────────────────────────────────────
const STATUS = {
  OPEN: 'Recibido, en espera de atención',
  IN_PROGRESS: 'En proceso',
  ANSWERED: 'Respondido',
  CLOSED: 'Cerrado',
};

const track = $('[data-panel="track"]');
track?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const msg = $('.form-msg', track);
  const result = $('.track-result', track);
  const folio = track.elements.namedItem('folio').value.trim().toUpperCase();
  const email = track.elements.namedItem('email').value.trim();
  result.hidden = true;
  if (!folio || !email) {
    setMessage(msg, 'Escribe tu folio y tu correo.', 'error');
    return;
  }
  setMessage(msg, 'Consultando…');
  try {
    const response = await fetch(
      `${API}/public/support-tickets/${encodeURIComponent(folio)}?email=${encodeURIComponent(email)}`,
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(response.status === 404 ? 'No encontramos un ticket con ese folio y correo.' : (body?.error?.message ?? 'No se pudo consultar.'));
    }
    setMessage(msg, '');
    result.hidden = false;
    result.innerHTML = `
      <h4>${escapeHtml(body.subject)}</h4>
      <p><span class="status">${STATUS[body.status] ?? body.status}</span>
      <span class="fine"> · abierto el ${new Date(body.createdAt).toLocaleDateString('es-MX')}</span></p>
      ${
        body.answer
          ? `<p style="margin-top:14px"><b>Respuesta del equipo:</b></p><p style="white-space:pre-wrap">${escapeHtml(body.answer)}</p>`
          : '<p class="muted" style="margin-top:12px">Todavía no hay respuesta. Te avisaremos por correo.</p>'
      }`;
  } catch (error) {
    setMessage(msg, error instanceof TypeError ? 'No pudimos conectar con el servidor.' : error.message, 'error');
  }
});

// ── Canales de contacto: solo los que están configurados ───────────────────
const channels = $('[data-channels]');
if (channels) {
  const c = SITE.contact;
  const items = [
    c.whatsapp && `<li><span>WhatsApp</span><a href="https://wa.me/${c.whatsapp}" target="_blank" rel="noreferrer">Escríbenos por WhatsApp</a></li>`,
    c.phone && `<li><span>Teléfono</span><a href="tel:${c.phone.replace(/\s/g, '')}">${c.phone}</a></li>`,
    c.email && `<li><span>Correo</span><a href="mailto:${c.email}">${c.email}</a></li>`,
    c.hours && `<li><span>Horario</span>${c.hours}</li>`,
    c.city && `<li><span>Ubicación</span>${c.city}</li>`,
  ].filter(Boolean);
  channels.innerHTML = items.join('') || '<li>Usa el formulario de tickets.</li>';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
