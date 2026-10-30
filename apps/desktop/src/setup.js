// Asistente de primer uso. Valida aquí lo que se puede validar y le pasa el
// resto al proceso principal (window.setup, expuesto por setup-preload.cjs).
const params = new URLSearchParams(location.search);
const form = document.getElementById('form');
const errorBox = document.getElementById('error');
const working = document.getElementById('working');
const progress = document.getElementById('progress');
const serverFields = document.getElementById('server-fields');
const clientFields = document.getElementById('client-fields');

// La base ya existe (el asistente se cerró a medias): solo faltan negocio y usuario.
if (params.get('onlyBusiness') === '1') {
  document.getElementById('mode-section').hidden = true;
  form.elements.namedItem('lan').closest('section').hidden = true;
}

const tz = form.elements.namedItem('timezone');
if ([...tz.options].some((o) => o.value === params.get('timezone'))) tz.value = params.get('timezone');

function syncMode() {
  const client = form.elements.namedItem('mode').value === 'client';
  serverFields.hidden = client;
  clientFields.hidden = !client;
  for (const el of serverFields.querySelectorAll('input')) el.disabled = client;
  form.elements.namedItem('serverUrl').disabled = !client;
}
form.addEventListener('change', (e) => {
  if (e.target.name === 'mode') syncMode();
});
syncMode();

window.setup.onProgress((text) => (progress.textContent = text));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.textContent = '';
  const data = Object.fromEntries(new FormData(form).entries());
  data.lan = form.elements.namedItem('lan').checked;

  form.querySelectorAll('input').forEach((el) => el.setAttribute('data-touched', ''));
  if (!form.checkValidity()) {
    const first = [...form.querySelectorAll('input, select')].find((el) => !el.disabled && !el.checkValidity());
    errorBox.textContent = messageFor(first);
    first?.focus();
    return;
  }
  if (data.mode === 'server' && data.adminPassword !== data.adminPassword2) {
    errorBox.textContent = 'Las dos claves no coinciden.';
    form.elements.namedItem('adminPassword2').focus();
    return;
  }
  if (data.mode === 'client' && !data.serverUrl?.trim()) {
    errorBox.textContent = 'Escribe la dirección de la caja principal.';
    return;
  }

  form.hidden = true;
  working.hidden = false;
  const result = await window.setup.submit(data);
  if (!result.ok) {
    working.hidden = true;
    form.hidden = false;
    errorBox.textContent = result.error;
  }
});

function messageFor(el) {
  if (!el) return 'Revisa los datos.';
  switch (el.name) {
    case 'terms': return 'Para continuar acepta el contrato de licencia.';
    case 'rfc': return 'El RFC no tiene un formato válido (12 o 13 caracteres).';
    case 'adminEmail': return 'Escribe un correo válido o déjalo vacío.';
    case 'adminUsername': return 'El usuario lleva de 3 a 32 letras, números, punto, guion o guion bajo.';
    case 'adminPassword':
    case 'adminPassword2': return 'La clave es un PIN de 4 o más dígitos, o una contraseña de 8 o más caracteres.';
    case 'adminPin': return 'El PIN debe tener de 4 a 6 dígitos.';
    default: return `Completa el campo «${el.closest('label')?.querySelector('span')?.firstChild?.textContent?.trim() ?? el.name}».`;
  }
}
