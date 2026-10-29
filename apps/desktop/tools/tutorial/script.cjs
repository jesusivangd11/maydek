/**
 * Guion del video tutorial. Cada paso tiene lo que se narra (`say`, también
 * es el subtítulo) y lo que se hace en pantalla (`do`) al mismo tiempo; el
 * paso dura lo que dure lo más largo de los dos. `chapter` abre un capítulo
 * del índice de la página web.
 */
const BARCODE = '7501055300075'; // Refresco de cola 600 ml (tools/demo-data.mjs)

async function nav(ui, label) {
  await ui.click(label, '.nav__item, nav a, nav button');
  await ui.sleep(700);
}

async function charge(ui, received) {
  await ui.key('F2');
  await ui.waitText('Efectivo recibido');
  await ui.field('Efectivo recibido');
  await ui.selectAll();
  await ui.type(received, 120);
  await ui.sleep(900);
  await ui.key('Enter');
  await ui.waitText('Nueva venta', 10000);
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
      await ui.waitText('Caja');
    },
  },
  {
    chapter: 'Abrir la caja',
    say: 'Antes de vender, abre la caja. Ve a Caja, escribe el efectivo con el que empiezas el día y pulsa Abrir caja.',
    async do(ui) {
      await nav(ui, 'Caja');
      await ui.field('Fondo inicial');
      await ui.type('500', 160);
      await ui.click('Abrir caja', 'button');
      await ui.sleep(800);
    },
  },
  {
    chapter: 'Vender',
    say: 'Para vender, escanea el código de barras con el lector. El artículo se agrega solo al ticket.',
    async do(ui) {
      await nav(ui, 'Vender');
      await ui.field('Buscar');
      await ui.type(BARCODE, 25);
      await ui.key('Enter');
      await ui.sleep(700);
      await ui.type(BARCODE, 25);
      await ui.key('Enter');
    },
  },
  {
    say: 'Si el artículo no tiene código, búscalo por su nombre y pulsa Enter.',
    async do(ui) {
      await ui.type('galletas', 110);
      await ui.sleep(1100);
      await ui.key('Enter');
      await ui.type('cuaderno', 110);
      await ui.sleep(1100);
      await ui.key('Enter');
    },
  },
  {
    chapter: 'Cobrar',
    say: 'Para cobrar pulsa F2. Escribe con cuánto te pagan y el sistema calcula el cambio. Confirma con Enter.',
    do: (ui) => charge(ui, '200'),
  },
  {
    say: 'La venta queda registrada, el inventario se descuenta solo, y con F9 imprimes el ticket en tu impresora térmica. Con Enter empiezas la siguiente venta.',
    async do(ui) {
      await ui.sleep(2500);
      await ui.key('Enter');
    },
  },
  {
    chapter: 'Cliente de mayoreo',
    say: 'Con F4 eliges al cliente. Si tiene precio de mayoreo, los precios del ticket cambian solos. También puedes venderle a crédito, respetando su límite.',
    async do(ui) {
      await ui.key('F4');
      await ui.sleep(600);
      await ui.type('pepe', 140);
      await ui.sleep(1200);
      await ui.key('Enter');
      await ui.sleep(900);
      await ui.field('Buscar');
      await ui.type(BARCODE, 25);
      await ui.key('Enter');
      await ui.sleep(500);
      await ui.type(BARCODE, 25);
      await ui.key('Enter');
    },
  },
  {
    say: 'Cobras igual que antes: F2, el efectivo recibido y Enter.',
    async do(ui) {
      await charge(ui, '100');
      await ui.sleep(1200);
      await ui.key('Enter');
    },
  },
  {
    chapter: 'Ventas y devoluciones',
    say: 'En Ventas encuentras todo lo vendido. Abre un ticket para reimprimirlo, hacer una devolución parcial o total, o cancelarlo si fue en el mismo turno.',
    async do(ui) {
      await nav(ui, 'Ventas');
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
    say: 'Al final del día ve a Caja. El sistema te dice cuánto efectivo debe haber. Cuéntalo, escríbelo y cierra la caja. Si hay diferencia, te pide el motivo.',
    async do(ui) {
      await nav(ui, 'Caja');
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
    say: 'La administración se abre desde el menú Sistema, o con Control más 2. En el tablero ves las ventas del día, la utilidad y lo más vendido.',
    async do(ui) {
      await ui.goto('/admin/');
      const needsLogin = await ui.eval('Boolean(window.__pv.field("Correo"))');
      if (needsLogin) {
        await ui.field('Correo');
        await ui.type(ui.creds.adminEmail, 30);
        await ui.field('Contraseña');
        await ui.type(ui.creds.adminPassword, 25);
        await ui.key('Enter');
      }
      await ui.waitText('Tablero');
      await ui.sleep(1500);
    },
  },
  {
    say: 'En Productos das de alta artículos con sus tallas y colores, sus precios y sus códigos de barras.',
    do: (ui) => nav(ui, 'Productos'),
  },
  {
    say: 'En Inventario consultas existencias y el kardex de cada artículo. En Compras registras lo que te llega del proveedor, con su costo.',
    async do(ui) {
      await nav(ui, 'Inventario');
      await ui.sleep(2600);
      await nav(ui, 'Compras');
    },
  },
  {
    say: 'En Clientes llevas el crédito y los abonos, y en Usuarios das de alta a tu equipo, cada quien con sus permisos.',
    async do(ui) {
      await nav(ui, 'Clientes');
      await ui.sleep(2600);
      await nav(ui, 'Usuarios');
    },
  },
  {
    chapter: 'Respaldos y soporte',
    say: 'El sistema funciona sin internet y se respalda solo todos los días. En el menú Respaldos puedes guardar una copia en una memoria USB. Y si necesitas ayuda, en Ayuda, Soporte técnico, están nuestros datos.',
    do: (ui) => nav(ui, 'Tablero'),
  },
  {
    card: { title: '¡Listo para vender!', subtitle: 'Soporte: 614 133 6763 · jesus.ivan.gd11@gmail.com' },
    say: 'Gracias por elegir Maydek. ¡Mucho éxito en tu negocio!',
  },
];

module.exports = { STEPS };
