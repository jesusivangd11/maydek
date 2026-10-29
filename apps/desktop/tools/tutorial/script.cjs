/**
 * Guion del video tutorial. Cada paso tiene lo que se narra (`say`, también
 * es el subtítulo) y lo que se hace en pantalla (`do`) al mismo tiempo; el
 * paso dura lo que dure lo más largo de los dos. `chapter` abre un capítulo
 * del índice de la página web.
 */
const BARCODE = '7501055300075'; // Refresco de cola 600 ml (tools/demo-data.mjs)

/** Módulos de la barra superior (F1 Ventas, F2 Clientes… Corte). */
async function nav(ui, label) {
  await ui.click(label, 'nav.modules button');
  await ui.sleep(700);
}

async function scan(ui, code) {
  await ui.field('Código del producto');
  await ui.type(code, 25);
  await ui.key('Enter');
}

/** Escribe un nombre en el código; si hay varios parecidos, toma el primero. */
async function byName(ui, name) {
  await ui.field('Código del producto');
  await ui.type(name, 110);
  await ui.key('Enter');
  await ui.sleep(1100);
  if (await ui.eval('Boolean(document.querySelector(".overlay"))')) {
    await ui.key('Enter');
    await ui.sleep(500);
  }
}

async function charge(ui, received) {
  await ui.key('F12');
  await ui.waitText('Efectivo recibido');
  await ui.field('Efectivo recibido');
  await ui.selectAll();
  await ui.type(received, 120);
  await ui.sleep(900);
  await ui.key('Enter');
  await ui.waitText('Pagó con', 10000);
}

const STEPS = [
  {
    card: { title: 'Video tutorial', subtitle: 'Del primer cobro al corte del día' },
    say: 'Bienvenido a Maydek. En unos minutos verás cómo vender, cobrar, hacer devoluciones y el corte de caja, y cómo administrar tu negocio.',
  },
  {
    card: null,
    chapter: 'Iniciar sesión',
    say: 'Cada persona entra con su propio correo y contraseña. Así el sistema sabe quién hizo cada venta.',
    async do(ui) {
      await ui.sleep(600);
      await ui.field('Correo');
      await ui.type(ui.creds.adminEmail, 55);
      await ui.field('Contraseña');
      await ui.type(ui.creds.adminPassword, 35);
      await ui.key('Enter');
      await ui.waitText('Código del producto');
    },
  },
  {
    chapter: 'Abrir la caja',
    say: 'Antes de vender, abre la caja. Ve a Corte, escribe el efectivo con el que empiezas el día y pulsa Abrir caja.',
    async do(ui) {
      await nav(ui, 'Corte');
      await ui.field('Fondo inicial');
      await ui.type('500', 160);
      await ui.click('Abrir caja', 'button');
      await ui.sleep(800);
    },
  },
  {
    chapter: 'Vender',
    say: 'Con F1 vuelves a Ventas. Escanea el código de barras con el lector y el artículo se agrega solo al ticket.',
    async do(ui) {
      await ui.key('F1');
      await ui.sleep(600);
      await scan(ui, BARCODE);
      await ui.sleep(700);
      await scan(ui, BARCODE);
    },
  },
  {
    say: 'Si el artículo no tiene código, escribe su nombre y pulsa Enter, o búscalo con F10. Aunque no haya existencia, se vende y el inventario queda en negativo.',
    async do(ui) {
      await byName(ui, 'galletas');
      await byName(ui, 'cuaderno');
    },
  },
  {
    say: 'Para algo que no está en el catálogo usa Control más P, artículo común: escribes la descripción y el precio.',
    async do(ui) {
      await ui.key('Control+P');
      await ui.waitText('Artículo común');
      await ui.field('Descripción');
      await ui.type('Bolsa de regalo', 90);
      await ui.field('Precio');
      await ui.type('15', 160);
      await ui.sleep(500);
      await ui.key('Enter');
    },
  },
  {
    chapter: 'Cobrar',
    say: 'Para cobrar pulsa F12. Escribe con cuánto te pagan y el sistema calcula el cambio. Confirma con Enter.',
    do: (ui) => charge(ui, '300'),
  },
  {
    say: 'La venta queda registrada, el inventario se descuenta solo y abajo ves el total, con cuánto pagó y el cambio. Desde ahí reimprimes el último ticket.',
    do: (ui) => ui.sleep(2500),
  },
  {
    chapter: 'Mayoreo y varios tickets',
    say: 'Con F11 activas el precio de mayoreo con un solo clic. Con F6 dejas la cuenta pendiente para atender a otra persona, y con F5 regresas a ella.',
    async do(ui) {
      await ui.key('F11');
      await ui.sleep(600);
      await scan(ui, BARCODE);
      await ui.sleep(500);
      await scan(ui, BARCODE);
      await ui.sleep(1200);
      await ui.key('F6');
      await ui.sleep(1500);
      await ui.key('F5');
      await ui.sleep(900);
    },
  },
  {
    say: 'Cobras igual que antes: F12, el efectivo recibido y Enter.',
    do: (ui) => charge(ui, '100'),
  },
  {
    chapter: 'Ventas y devoluciones',
    say: 'En Ventas del día encuentras todo lo vendido. Abre un ticket para reimprimirlo, hacer una devolución parcial o total, o cancelarlo si fue en el mismo turno.',
    async do(ui) {
      await ui.click('Ventas del día', 'button');
      await ui.sleep(900);
      await ui.clickSelector('tbody tr');
      await ui.sleep(1200);
    },
  },
  {
    say: 'Si el cajero no tiene permiso, un supervisor autoriza con su PIN. El dinero se devuelve en efectivo o como nota de crédito, y lo dañado se manda a mermas.',
    async do(ui) {
      await ui.click('Devolución', 'button');
      await ui.sleep(3500);
      await ui.key('Escape');
    },
  },
  {
    chapter: 'Corte de caja',
    say: 'Al final del día ve a Corte. El sistema te dice cuánto efectivo debe haber. Cuéntalo, escríbelo y cierra la caja. Si hay diferencia, te pide el motivo.',
    async do(ui) {
      await nav(ui, 'Corte');
      await ui.sleep(1000);
      const expected = await ui.eval(`(() => {
        const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && /efectivo esperado/i.test(el.textContent));
        const box = label?.closest('div')?.parentElement ?? document.body;
        const m = box.innerText.replace(/,/g, '').match(/\\$\\s*([0-9]+(?:\\.[0-9]+)?)/);
        return m ? m[1] : null;
      })()`);
      await ui.field('Efectivo contado');
      await ui.type(expected ?? '500', 140);
      await ui.sleep(600);
      await ui.click('Cerrar caja', 'button');
      await ui.sleep(1500);
    },
  },
  {
    chapter: 'Administración',
    say: 'Todo se administra desde la misma pantalla. Con F3, Productos, das de alta artículos con su costo, su precio, su precio de mayoreo y la existencia inicial.',
    async do(ui) {
      await ui.key('F3');
      await ui.sleep(2000);
    },
  },
  {
    say: 'Con F4 consultas el inventario y el kardex de cada artículo, y en Reportes ves las ventas, el mayoreo y los productos en negativo o por agotarse.',
    async do(ui) {
      await ui.key('F4');
      await ui.sleep(2600);
      await nav(ui, 'Reportes');
    },
  },
  {
    say: 'Con F2 llevas a tus clientes, su crédito y sus abonos. En Usuarios das de alta a tu equipo y, con Privilegios, eliges qué puede hacer cada persona.',
    async do(ui) {
      await ui.key('F2');
      await ui.sleep(2600);
      await nav(ui, 'Usuarios');
    },
  },
  {
    say: 'En Configuración pones los datos de tu negocio y diseñas el ticket: encabezado, pie, ancho del papel y si se imprime solo al cobrar.',
    do: (ui) => nav(ui, 'Configuración'),
  },
  {
    chapter: 'Respaldos y soporte',
    say: 'El sistema funciona sin internet y se respalda solo todos los días. En el menú Respaldos puedes guardar una copia en una memoria USB. Y si necesitas ayuda, en Ayuda, Soporte técnico, están nuestros datos.',
    do: (ui) => ui.key('F1'),
  },
  {
    card: { title: '¡Listo para vender!', subtitle: 'Soporte: 614 133 6763 · jesus.ivan.gd11@gmail.com' },
    say: 'Gracias por elegir Maydek. ¡Mucho éxito en tu negocio!',
  },
];

module.exports = { STEPS };
