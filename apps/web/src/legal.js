import { SITE } from './config.js';

// Las páginas legales toman nombre, contacto y datos del titular de la misma
// configuración que el inicio: un solo lugar para cambiarlos.
document.querySelectorAll('[data-brand]').forEach((el) => (el.textContent = SITE.brand));
document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = String(new Date().getFullYear())));

const contact = SITE.contact;
document.querySelectorAll('[data-contact]').forEach((el) => {
  const key = el.dataset.contact;
  el.textContent = contact[key] ?? '';
  if (key === 'email' && el.tagName === 'A') el.setAttribute('href', `mailto:${contact.email}`);
});

/** Datos del titular que faltan: se marcan en vez de inventarse. */
const PENDING = {
  ownerName: 'nombre completo del titular',
  address: 'domicilio para oír y recibir notificaciones',
  rfc: 'RFC del titular',
};

let missing = 0;
document.querySelectorAll('[data-legal]').forEach((el) => {
  const key = el.dataset.legal;
  const value = SITE.legal[key];
  if (value) {
    el.textContent = value;
  } else {
    missing += 1;
    el.innerHTML = `<mark class="pending">[${PENDING[key] ?? key}]</mark>`;
  }
});

// Aviso solo para quien edita el sitio: nunca aparece en la compilación publicada.
if (missing > 0 && import.meta.env.DEV) {
  const note = document.createElement('p');
  note.className = 'notice';
  note.innerHTML =
    '<b>Falta completar:</b> nombre completo y domicilio del titular en <code>apps/web/src/config.js</code> (<code>legal</code>). La ley los exige en el aviso de privacidad.';
  document.querySelector('.legal .wrap')?.prepend(note);
}
