import { describe, expect, it } from 'vitest';
import type { CatalogItem } from './api';
import {
  addCommonItem,
  applyGlobalDiscount,
  addToCart,
  cartTotals,
  lineTotal,
  overstockedLines,
  removeLine,
  reprice,
  setDiscount,
  setQty,
  syncAvailability,
  toSaleLines,
  type CartLine,
} from './cart';

/**
 * Reglas del ticket.
 *
 * Son funciones puras a propósito: las decisiones que un cajero repite cien
 * veces al día —volver a pasar el mismo artículo, bajar una cantidad a cero,
 * toparse con la existencia— tienen que poder comprobarse sin navegador.
 */

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    variantId: 'v1',
    productId: 'p1',
    sku: 'FJD-010',
    name: 'Faja deportiva',
    productName: 'Faja deportiva',
    barcode: '7501234500101',
    category: null,
    unit: 'PZA',
    imageUrl: null,
    unitPrice: '580.0000',
    priceIncludesTax: true,
    taxRate: '0.160000',
    trackStock: true,
    qtyAvailable: '10.000',
    isOut: false,
    minStock: null,
    isLow: false,
    ...overrides,
  };
}

describe('agregar al ticket', () => {
  it('crea el renglón con precio y existencia del servidor', () => {
    const lines = addToCart([], item());

    expect(lines).toHaveLength(1);
    expect(lines[0]!.unitPrice).toBe(580);
    expect(lines[0]!.qty).toBe(1);
    expect(lines[0]!.available).toBe(10);
  });

  // Prueba 2 del plan: el mismo producto dos veces NO abre otro renglón.
  it('sube la cantidad en vez de duplicar el renglón', () => {
    let lines = addToCart([], item());
    lines = addToCart(lines, item());
    lines = addToCart(lines, item());

    expect(lines).toHaveLength(1);
    expect(lines[0]!.qty).toBe(3);
  });

  it('distingue artículos distintos', () => {
    let lines = addToCart([], item());
    lines = addToCart(lines, item({ variantId: 'v2', sku: 'ACC-030' }));

    expect(lines).toHaveLength(2);
  });

  it('un artículo en cero SÍ se vende: el inventario queda en negativo', () => {
    const lines = addToCart([], item({ qtyAvailable: '0.000', isOut: true }));
    expect(lines).toHaveLength(1);
    expect(overstockedLines(lines)).toHaveLength(1);
  });

  it('el producto común abre un renglón por cada uno, con su precio', () => {
    const common = { variantId: 'comun', sku: 'COMUN', taxRate: '0.16' };
    let lines = addCommonItem([], common, { description: 'Bolsa', unitPrice: 5, qty: 2 });
    lines = addCommonItem(lines, common, { description: 'Hilo', unitPrice: 12, qty: 1 });

    expect(lines).toHaveLength(2);
    expect(cartTotals(lines).total).toBe(22);
    const payload = toSaleLines(lines);
    expect(payload[0]).toMatchObject({ variantId: 'comun', unitPrice: '5.00', description: 'Bolsa' });
  });

  it('un servicio sin existencia sí entra: no lleva inventario', () => {
    const lines = addToCart([], item({ trackStock: false, qtyAvailable: '0.000' }));
    expect(lines).toHaveLength(1);
  });
});

describe('cantidades', () => {
  // Prueba 3 del plan.
  it('cambia la cantidad', () => {
    const lines = setQty(addToCart([], item()), 'v1', 4);
    expect(lines[0]!.qty).toBe(4);
  });

  // Prueba 4 del plan: bajar a cero elimina el renglón.
  it('cero o menos elimina el renglón', () => {
    expect(setQty(addToCart([], item()), 'v1', 0)).toHaveLength(0);
    expect(setQty(addToCart([], item()), 'v1', -3)).toHaveLength(0);
  });

  it('elimina por identificador', () => {
    expect(removeLine(addToCart([], item()), 'v1')).toHaveLength(0);
  });

  it('la existencia no topa la cantidad, solo avisa', () => {
    const lines = setQty(addToCart([], item({ qtyAvailable: '3.000' })), 'v1', 99);

    expect(lines[0]!.qty).toBe(99);
    expect(overstockedLines(lines)).toHaveLength(1);
  });

  it('un servicio nunca se marca como faltante', () => {
    const lines = setQty(addToCart([], item({ trackStock: false })), 'v1', 500);
    expect(overstockedLines(lines)).toHaveLength(0);
  });
});

describe('totales', () => {
  it('suma cantidad por precio', () => {
    const lines = setQty(addToCart([], item()), 'v1', 2);
    expect(cartTotals(lines).total).toBe(1160);
  });

  it('el ejemplo del plan: faja de 750 por 2 son 1500', () => {
    const lines = setQty(addToCart([], item({ unitPrice: '750.0000' })), 'v1', 2);

    expect(lineTotal(lines[0]!)).toBe(1500);
    expect(cartTotals(lines).total).toBe(1500);
  });

  it('suma varios renglones y cuenta artículos', () => {
    let lines = addToCart([], item());
    lines = addToCart(lines, item({ variantId: 'v2', unitPrice: '180.0000' }));
    lines = setQty(lines, 'v2', 2);

    const totals = cartTotals(lines);
    expect(totals.lineCount).toBe(2);
    expect(totals.itemCount).toBe(3);
    expect(totals.total).toBe(580 + 360);
  });

  it('el descuento baja el total y nunca deja el renglón en negativo', () => {
    let lines = addToCart([], item());
    lines = setDiscount(lines, 'v1', 100);
    expect(cartTotals(lines).total).toBe(480);

    lines = setDiscount(lines, 'v1', 99999);
    expect(cartTotals(lines).total).toBe(0);
  });

  it('un ticket vacío suma cero', () => {
    expect(cartTotals([]).total).toBe(0);
  });
});

describe('sincronizar con el servidor', () => {
  it('actualiza la existencia sin tocar la cantidad capturada', () => {
    const lines = setQty(addToCart([], item({ qtyAvailable: '10.000' })), 'v1', 8);
    const synced = syncAvailability(lines, [item({ qtyAvailable: '3.000' })]);

    expect(synced[0]!.available).toBe(3);
    expect(synced[0]!.qty).toBe(8);
  });

  it('el mayoreo cambia el precio de los renglones del catálogo', () => {
    const lines = addToCart([], item());
    const repriced = reprice(lines, [item({ unitPrice: '500.0000' })]);
    expect(repriced[0]!.unitPrice).toBe(500);
  });

  it('deja intactos los renglones que no vienen en la respuesta', () => {
    const lines = addToCart([], item());
    const synced = syncAvailability(lines, [item({ variantId: 'otro' })]);

    expect(synced[0]!.qty).toBe(1);
    expect(synced[0]!.available).toBe(10);
  });
});

describe('contrato con el API', () => {
  it('manda cantidades como texto, nunca como número', () => {
    const lines: CartLine[] = setQty(addToCart([], item()), 'v1', 2);
    const payload = toSaleLines(lines);

    expect(payload[0]!.qty).toBe('2');
    expect(typeof payload[0]!.qty).toBe('string');
    expect(payload[0]!.discountAmount).toBeUndefined();
  });

  it('incluye el descuento con motivo cuando lo hay', () => {
    const lines = setDiscount(addToCart([], item()), 'v1', 50);
    const payload = toSaleLines(lines);

    expect(payload[0]!.discountAmount).toBe('50.00');
    expect(payload[0]!.discountReason).toBeTruthy();
  });
});

describe('applyGlobalDiscount', () => {
  const base = (variantId: string, unitPrice: number, qty: number) => ({
    key: variantId,
    variantId,
    sku: variantId,
    name: variantId,
    unitPrice,
    qty,
    discount: 0,
    available: 99,
    trackStock: true,
    unit: 'PZA',
  });

  it('reparte en proporción y cuadra al centavo', () => {
    const lines = applyGlobalDiscount([base('a', 100, 1), base('b', 33.33, 3)], 10);
    const total = lines.reduce((acc, l) => acc + l.discount, 0);
    expect(Math.round(total * 100) / 100).toBe(10);
    expect(lines[0]!.discount).toBeCloseTo(5, 1);
  });

  it('nunca descuenta más que el importe del ticket', () => {
    const lines = applyGlobalDiscount([base('a', 50, 1)], 80);
    expect(lines[0]!.discount).toBe(50);
  });

  it('reemplaza el descuento anterior en vez de acumularlo', () => {
    const once = applyGlobalDiscount([base('a', 100, 1)], 10);
    const twice = applyGlobalDiscount(once, 10);
    expect(twice[0]!.discount).toBe(10);
  });
});
