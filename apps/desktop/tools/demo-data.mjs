#!/usr/bin/env node
/**
 * Datos de demostración para una instalación NUEVA de escritorio: catálogo,
 * existencias con costo, un cliente de mayoreo y un turno anterior con ventas
 * (para que el tablero y los reportes no salgan vacíos en la demostración o en
 * el video tutorial).
 *
 *   node tools/demo-data.mjs <archivo-de-credenciales.json> [http://localhost:3210]
 *
 * El archivo es el mismo JSON del asistente (adminEmail y adminPassword).
 * Nunca correrlo contra la base de un cliente.
 */
import { readFileSync } from 'node:fs';

const creds = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const API = `${process.argv[3] ?? 'http://localhost:3210'}/api/v1`;
let token = null;

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

token = (await call('POST', '/auth/login', { email: creds.adminEmail, password: creds.adminPassword })).accessToken;

const categories = {};
for (const name of ['Bebidas', 'Abarrotes', 'Papelería', 'Ropa']) {
  categories[name] = (await call('POST', '/categories', { name })).id;
}

// [nombre, categoría, precio, costo, existencia, código, variantes?]
const catalog = [
  ['Refresco de cola 600 ml', 'Bebidas', '22', '14.50', 48, '7501055300075'],
  ['Agua natural 1 L', 'Bebidas', '15', '8.20', 60, '7501086801046'],
  ['Jugo de naranja 1 L', 'Bebidas', '32', '21.00', 24, '7501000611218'],
  ['Galletas María 170 g', 'Abarrotes', '18', '11.30', 40, '7501000123456'],
  ['Café soluble 100 g', 'Abarrotes', '89', '58.00', 18, '7501059224216'],
  ['Arroz 1 kg', 'Abarrotes', '34', '22.50', 30, '7501052410012'],
  ['Cuaderno profesional 100 hojas', 'Papelería', '45', '26.00', 35, '7501001234567'],
  ['Pluma tinta azul', 'Papelería', '9', '4.10', 120, '7501002345678'],
  ['Playera básica', 'Ropa', '150', '82.00', 6, null, [
    ['BLANCO-M', 'Blanco / M'], ['BLANCO-G', 'Blanco / G'], ['NEGRO-M', 'Negro / M'], ['NEGRO-G', 'Negro / G'],
  ]],
];

const variants = [];
let skuSeq = 1000;
for (const [name, category, price, cost, qty, barcode, combos] of catalog) {
  const sku = `SKU-${skuSeq++}`;
  const product = await call('POST', '/products', {
    name,
    categoryId: categories[category],
    basePrice: price,
    minStock: '5',
    ...(combos
      ? { variants: combos.map(([code, suffix]) => ({ sku: `${sku}-${code}`, nameSuffix: suffix, basePrice: price, minStock: '2' })) }
      : { sku, barcode }),
  });
  for (const v of product.variants) variants.push({ id: v.id, cost, qty, price: Number(price), name });
}

const supplier = await call('POST', '/suppliers', {
  businessName: 'Distribuidora del Norte',
  contactName: 'Ricardo Salas',
  phone: '6144100000',
  paymentTerms: '30 días',
});
await call('POST', '/purchase-receipts', {
  supplierId: supplier.id,
  items: variants.map((v) => ({ variantId: v.id, qty: String(v.qty), unitCost: v.cost })),
  supplierInvoiceNumber: 'DN-2041',
  notes: 'Inventario inicial',
});

const lists = await call('GET', '/price-lists');
const mayoreo = lists.find((l) => l.code === 'MAYOREO');
for (const v of variants.filter((x) => x.price < 100)) {
  await call('PUT', `/price-lists/${mayoreo.id}/items`, { variantId: v.id, price: (v.price * 0.88).toFixed(2) });
}
await call('POST', '/customers', {
  firstName: 'Abarrotes',
  lastName: 'Don Pepe',
  phone: '6141112233',
  priceListId: mayoreo.id,
  creditLimit: '5000',
  creditDays: 15,
});
await call('POST', '/customers', { firstName: 'María', lastName: 'González', phone: '6142223344' });

// Un turno anterior ya cerrado, con ventas, para que haya historia.
await call('POST', '/cash/open', { openingFloat: '500' });
const picks = [[0, 3], [3, 2], [6, 1], [1, 4], [4, 1], [7, 5], [8, 1], [2, 2], [5, 1], [0, 2]];
let cash = 500;
for (const [i, n] of picks) {
  const v = variants[i];
  const amount = (v.price * n).toFixed(2);
  cash += Number(amount);
  await call('POST', '/sales', {
    items: [{ variantId: v.id, qty: String(n) }],
    payments: [{ methodCode: 'CASH', amount }],
    cashReceived: amount,
    idempotencyKey: `demo-${Date.now()}-${i}-${n}`,
  });
}
const current = await call('GET', '/cash/current');
await call('POST', '/cash/close', {
  cashSessionId: current.id,
  countedCash: String(current.expectedCash ?? cash),
});

console.log(`✓ ${variants.length} artículos, proveedor, cliente de mayoreo y ${picks.length} ventas de un turno cerrado`);
