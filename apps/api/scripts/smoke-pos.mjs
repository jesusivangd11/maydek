/**
 * Prueba de humo del flujo de venta, contra el API REAL.
 *
 *     node apps/api/scripts/smoke-pos.mjs
 *
 * Recorre el camino completo de un cajero y comprueba lo que de verdad
 * importa: que la venta quede escrita, que el inventario baje, que el kardex
 * tenga su asiento, que la caja cuadre y que un doble clic NO cobre dos veces.
 * Sin dobles ni simulaciones: si esto pasa, el sistema funciona.
 *
 * Cada bloque corresponde a una de las pruebas acordadas.
 */

const API = process.env.API_URL ?? 'http://localhost:3100/api/v1';
const EMAIL = process.env.SMOKE_EMAIL ?? 'cajero@distribuidora.local';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Cajero.Demo123';

const BARCODE_FAJA = '7501234500101';
const BARCODE_ACC = '7501234500309';

let token = null;
let cookie = '';
let failures = 0;

const money = (v) => Number(v).toFixed(2);
const num = (v) => Number(v ?? 0);

function step(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`   ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await response.text();
  return { status: response.status, ok: response.ok, payload: text ? JSON.parse(text) : null };
}

async function findByBarcode(code) {
  const response = await call(`/pos/search?q=${code}`);
  if (!response.ok) throw new Error(`Búsqueda ${code}: ${response.status}`);
  return response.payload.data[0];
}

/** Cobra un ticket de una sola línea con el método indicado. */
async function sell(variant, qty, methodCode, extra = {}) {
  const total = num(variant.unitPrice) * qty;
  return call('/sales', {
    method: 'POST',
    body: {
      items: [{ variantId: variant.variantId, qty: String(qty) }],
      payments: [
        {
          methodCode,
          amount: money(total),
          ...(extra.reference ? { reference: extra.reference } : {}),
        },
      ],
      ...(extra.cashReceived !== undefined ? { cashReceived: extra.cashReceived } : {}),
      ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
    },
  });
}

async function main() {
  console.log('\n╔' + '═'.repeat(58) + '╗');
  console.log('║  Flujo de venta de punta a punta                         ║');
  console.log('╚' + '═'.repeat(58) + '╝');

  // ══ Sesión ══
  step('Iniciar sesión');
  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok) {
    console.error(`\n✗ No se pudo entrar (${login.status}):`, login.payload?.error?.message);
    process.exit(1);
  }
  token = login.payload.accessToken;
  check('Sesión iniciada', true, `${login.payload.user.name} · ${login.payload.user.roles}`);

  // ══ Caja abierta ══
  step('Caja del turno');
  let session = (await call('/cash/current')).payload;
  if (!session) {
    const opened = await call('/cash/open', { method: 'POST', body: { openingFloat: '500.00' } });
    if (!opened.ok) {
      console.error('✗ No se pudo abrir la caja:', JSON.stringify(opened.payload));
      process.exit(1);
    }
    session = opened.payload;
    check('Caja abierta', true, session.folio);
  } else {
    check('Caja ya abierta', true, session.folio);
  }
  const cashAtStart = num(session.expectedCash);
  const salesAtStart = session.sales.count;

  // ══ PRUEBA 5 · Cobro en efectivo ══
  step('PRUEBA 5 · Cobro en efectivo');
  const faja = await findByBarcode(BARCODE_FAJA);
  const stockBefore = num(faja.qtyAvailable);
  const price = num(faja.unitPrice);
  const received = Math.ceil(price / 100) * 100 + 100;

  const cashSale = await sell(faja, 1, 'CASH', { cashReceived: money(received) });
  if (!cashSale.ok) {
    console.error('✗ La venta en efectivo falló:', JSON.stringify(cashSale.payload, null, 2));
    process.exit(1);
  }
  const ticket = cashSale.payload;
  check('Venta registrada', true, `folio ${ticket.folio}`);
  check('Folio generado por el servidor', /^[A-Z0-9]+-\d{3}-\d{6}$/.test(ticket.folio), ticket.folio);
  check('Total correcto', money(ticket.total) === money(price));
  check('Subtotal + IVA = total',
    money(num(ticket.subtotal) + num(ticket.taxTotal)) === money(ticket.total),
    `${money(ticket.subtotal)} + ${money(ticket.taxTotal)}`);
  check('Cambio calculado', money(ticket.changeGiven) === money(received - price),
    `recibido ${money(received)} → cambio ${money(ticket.changeGiven)}`);
  check('Detalle de venta creado', ticket.items.length === 1, `${ticket.items.length} renglón`);

  // ══ PRUEBA 6 · Efectivo insuficiente ══
  step('PRUEBA 6 · Efectivo insuficiente');
  const short = await sell(faja, 1, 'CASH', { cashReceived: money(price - 50) });
  check('El API lo rechaza', !short.ok, `${short.payload?.error?.code}`);
  check('Explica cuánto falta', /menor que/i.test(short.payload?.error?.message ?? ''),
    short.payload?.error?.message);

  // ══ PRUEBA 7 · Tarjeta ══
  step('PRUEBA 7 · Cobro con tarjeta');
  const cardSale = await sell(faja, 1, 'CARD_DEBIT', { reference: 'AUTH-778812' });
  check('Venta con tarjeta registrada', cardSale.ok,
    cardSale.ok ? cardSale.payload.folio : JSON.stringify(cardSale.payload?.error));
  if (cardSale.ok) {
    check('Método guardado como tarjeta', cardSale.payload.payments[0]?.methodCode === 'CARD_DEBIT',
      cardSale.payload.payments[0]?.methodName);
    check('Sin cambio en tarjeta', money(cardSale.payload.changeGiven) === '0.00');
  }

  // ══ PRUEBA 8 · Transferencia ══
  step('PRUEBA 8 · Cobro con transferencia');
  const transferSale = await sell(faja, 1, 'TRANSFER', { reference: 'SPEI-4410299' });
  check('Venta con transferencia registrada', transferSale.ok,
    transferSale.ok ? transferSale.payload.folio : JSON.stringify(transferSale.payload?.error));
  if (transferSale.ok) {
    check('Método guardado como transferencia',
      transferSale.payload.payments[0]?.methodCode === 'TRANSFER');
  }

  // ══ PRUEBA 10 · Inventario ══
  step('PRUEBA 10 · El inventario bajó');
  const fajaAfter = await findByBarcode(BARCODE_FAJA);
  const sold = 1 + (cardSale.ok ? 1 : 0) + (transferSale.ok ? 1 : 0);
  check('Se descontó una pieza por venta',
    num(fajaAfter.qtyAvailable) === stockBefore - sold,
    `${stockBefore} → ${fajaAfter.qtyAvailable} (${sold} vendidas)`);

  // ══ Kardex ══
  step('Trazabilidad en el kardex');
  const kardex = await call(`/inventory/kardex/${faja.variantId}`);
  if (kardex.ok) {
    const last = kardex.payload.movements[0];
    check('Hay asiento de la venta', last?.referenceType === 'SALE',
      `${last?.movementType} ${last?.qtyBefore} → ${last?.qtyAfter} ref ${last?.reference}`);
  } else {
    check('El permiso protege el kardex', kardex.status === 403,
      `el rol Cajero no puede verlo (${kardex.status})`);
  }

  // ══ PRUEBA 11 · Caja ══
  step('PRUEBA 11 · Movimiento de caja y desglose');
  const cut = (await call('/cash/current')).payload;

  check('El efectivo esperado subió SOLO por la venta en efectivo',
    money(cut.expectedCash) === money(cashAtStart + price),
    `${money(cashAtStart)} → ${money(cut.expectedCash)}`);

  const movement = cut.movements.find((m) => m.reference === ticket.folio);
  check('Existe el movimiento de caja de la venta en efectivo', Boolean(movement),
    movement ? `${movement.type} ${money(movement.amount)}` : 'no aparece');

  const cardMovement = cardSale.ok
    ? cut.movements.find((m) => m.reference === cardSale.payload.folio)
    : undefined;
  check('La venta con tarjeta NO genera movimiento de cajón', !cardMovement,
    'venta y movimiento de caja son cosas distintas');

  const byMethod = Object.fromEntries(cut.totalsByMethod.map((m) => [m.code, num(m.total)]));
  check('El corte desglosa EFECTIVO', byMethod.CASH > 0, `$${money(byMethod.CASH ?? 0)}`);
  check('El corte desglosa TARJETA', !cardSale.ok || byMethod.CARD_DEBIT > 0,
    `$${money(byMethod.CARD_DEBIT ?? 0)}`);
  check('El corte desglosa TRANSFERENCIA', !transferSale.ok || byMethod.TRANSFER > 0,
    `$${money(byMethod.TRANSFER ?? 0)}`);
  check('Total vendido del turno cuenta las tres',
    cut.sales.count === salesAtStart + sold,
    `${salesAtStart} → ${cut.sales.count} ventas · $${money(cut.sales.total)}`);

  // ══ PRUEBA 9 · Historial ══
  step('PRUEBA 9 · La venta aparece en Ventas');
  const list = await call('/sales?limit=10');
  const found = list.payload.data.find((s) => s.folio === ticket.folio);
  check('Aparece en el listado', Boolean(found), ticket.folio);
  check('Trae método de pago y cajero',
    Boolean(found?.paymentMethods?.length) && Boolean(found?.cashier),
    `${found?.paymentMethods?.join(', ')} · ${found?.cashier?.name}`);

  const detail = await call(`/sales/${ticket.id}`);
  check('El detalle trae renglones y pagos',
    detail.payload.items.length === 1 && detail.payload.payments.length === 1);

  // ══ PRUEBA 12 · Vender más de lo disponible ══
  step('PRUEBA 12 · Más piezas de las que hay');
  const over = await sell(faja, 9999, 'CASH', { cashReceived: money(9999 * price) });
  check('El API lo rechaza', over.payload?.error?.code === 'INSUFFICIENT_STOCK',
    over.payload?.error?.message);
  check('Dice cuánto queda y cuánto se pidió',
    Array.isArray(over.payload?.error?.details) && over.payload.error.details.length > 0,
    JSON.stringify(over.payload?.error?.details?.[0] ?? {}));

  // ══ PRUEBA 13 · Doble confirmación ══
  step('PRUEBA 13 · Doble clic en cobrar');
  const acc = await findByBarcode(BARCODE_ACC);
  const accStock = num(acc.qtyAvailable);
  const key = `doble-${Date.now()}`;

  // CUATRO peticiones a la vez, no dos: un doble clic nervioso dispara más de
  // una repetición, y lo que se comprueba aquí es que la restricción de la
  // base aguante la carrera, no que tengamos suerte con los tiempos.
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      sell(acc, 1, 'CASH', { cashReceived: money(num(acc.unitPrice)), idempotencyKey: key }),
    ),
  );

  const folios = attempts.filter((r) => r.ok).map((r) => r.payload.folio);
  const unique = new Set(folios);

  check('Las cuatro peticiones apuntan a UNA sola venta', unique.size === 1,
    `${attempts.length} intentos → ${unique.size} folio(s): ${[...unique].join(' , ') || 'ninguno'}`);
  check('Ninguna petición quedó en error inesperado',
    attempts.every((r) => r.ok || r.payload?.error?.code === 'IDEMPOTENCY_IN_PROGRESS'),
    attempts.map((r) => (r.ok ? 'ok' : r.payload?.error?.code)).join(', '));

  const accAfter = await findByBarcode(BARCODE_ACC);
  check('El inventario bajó UNA sola vez',
    num(accAfter.qtyAvailable) === accStock - 1,
    `${accStock} → ${accAfter.qtyAvailable}`);

  // ══ PRUEBA 14 · Persistencia ══
  step('PRUEBA 14 · Sobrevive a recargar');
  token = null;
  cookie = '';
  const relogin = await call('/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  token = relogin.payload.accessToken;

  const afterReload = await call(`/sales?search=${ticket.folio}`);
  check('La venta sigue ahí tras volver a entrar',
    afterReload.payload.data.some((s) => s.folio === ticket.folio),
    ticket.folio);

  // ══ Resultado ══
  console.log('\n' + '─'.repeat(60));
  if (failures === 0) {
    console.log('✓ El flujo de venta funciona de punta a punta.\n');
  } else {
    console.log(`✗ ${failures} comprobaciones fallaron.\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n✗ La prueba reventó:', error);
  process.exit(1);
});
