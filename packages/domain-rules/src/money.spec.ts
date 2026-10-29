import { describe, expect, it } from 'vitest';
import {
  Decimal,
  allocateLandedCost,
  calculateTax,
  money,
  moneyToString,
  roundCash,
  sum,
  toMoney,
  weightedAverageCost,
} from './money';

describe('money', () => {
  it('no arrastra el error del punto flotante', () => {
    // 0.1 + 0.2 === 0.30000000000000004 con number. Aquí no.
    expect(money('0.1').plus(money('0.2')).toString()).toBe('0.3');
    expect(moneyToString(money('0.1').plus('0.2'))).toBe('0.3000');
  });

  it('rechaza valores no finitos', () => {
    expect(() => money(Number.NaN)).toThrow(TypeError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => money('')).toThrow(TypeError);
  });

  it('serializa siempre con 4 decimales', () => {
    expect(moneyToString('1499.5')).toBe('1499.5000');
    expect(moneyToString(0)).toBe('0.0000');
  });

  it('suma listas largas sin desviarse', () => {
    const cien = Array.from({ length: 100 }, () => '0.01');
    expect(sum(cien).toString()).toBe('1');
  });
});

describe('weightedAverageCost — costeo promedio ponderado', () => {
  it('reproduce el ejemplo de la documentación', () => {
    // 10 piezas a $400 + 30 piezas a $450 → promedio $437.50
    const avg = weightedAverageCost({
      currentQty: 10,
      currentAvgCost: '400',
      incomingQty: 30,
      incomingUnitCost: '450',
    });
    expect(avg.toFixed(2)).toBe('437.50');
  });

  it('reproduce el segundo tramo del kardex documentado', () => {
    // 19 piezas a $400 + 30 a $450 → $430.6122...
    const avg = weightedAverageCost({
      currentQty: 19,
      currentAvgCost: '400',
      incomingQty: 30,
      incomingUnitCost: '450',
    });
    expect(avg.toFixed(2)).toBe('430.61');
  });

  it('una salida no altera el promedio (solo entran movimientos IN)', () => {
    const avg = weightedAverageCost({
      currentQty: 10,
      currentAvgCost: '400',
      incomingQty: 0,
      incomingUnitCost: '999',
    });
    expect(avg.toFixed(4)).toBe('400.0000');
  });

  it('con existencia en cero adopta el costo que entra', () => {
    const avg = weightedAverageCost({
      currentQty: 0,
      currentAvgCost: '0',
      incomingQty: 5,
      incomingUnitCost: '450',
    });
    expect(avg.toFixed(2)).toBe('450.00');
  });
});

describe('roundCash — redondeo de efectivo (P8)', () => {
  it('redondea a la moneda de 50 centavos y expone el ajuste', () => {
    const r = roundCash('1499.30');
    expect(r.rounded.toFixed(2)).toBe('1499.50');
    expect(r.adjustment.toFixed(2)).toBe('0.20');
  });

  it('redondea hacia abajo cuando corresponde', () => {
    const r = roundCash('1499.10');
    expect(r.rounded.toFixed(2)).toBe('1499.00');
    expect(r.adjustment.toFixed(2)).toBe('-0.10');
  });

  it('no ajusta un importe que ya cae en el escalón', () => {
    const r = roundCash('1499.50');
    expect(r.rounded.toFixed(2)).toBe('1499.50');
    expect(r.adjustment.isZero()).toBe(true);
  });

  it('con paso cero se desactiva el redondeo', () => {
    const r = roundCash('1499.37', '0');
    expect(r.rounded.toFixed(2)).toBe('1499.37');
    expect(r.adjustment.isZero()).toBe(true);
  });
});

describe('allocateLandedCost — prorrateo de costos de importación (P5)', () => {
  it('reparte por valor y la suma cuadra exactamente', () => {
    const alloc = allocateLandedCost({
      lines: [
        { qty: 10, unitCost: '400' }, // 4000 → 40 %
        { qty: 30, unitCost: '200' }, // 6000 → 60 %
      ],
      extraCost: '1000',
      method: 'BY_VALUE',
    });
    expect(alloc[0]!.toFixed(2)).toBe('400.00');
    expect(alloc[1]!.toFixed(2)).toBe('600.00');
    expect(sum(alloc).toFixed(4)).toBe('1000.0000');
  });

  it('el residuo del redondeo no se pierde: la suma es exacta', () => {
    const alloc = allocateLandedCost({
      lines: [
        { qty: 1, unitCost: '1' },
        { qty: 1, unitCost: '1' },
        { qty: 1, unitCost: '1' },
      ],
      extraCost: '10',
    });
    expect(sum(alloc).toFixed(4)).toBe('10.0000');
  });

  it('reparte por cantidad cuando se pide', () => {
    const alloc = allocateLandedCost({
      lines: [
        { qty: 25, unitCost: '400' },
        { qty: 75, unitCost: '1' },
      ],
      extraCost: '400',
      method: 'BY_QTY',
    });
    expect(alloc[0]!.toFixed(2)).toBe('100.00');
    expect(alloc[1]!.toFixed(2)).toBe('300.00');
  });

  it('sin gasto extra devuelve ceros', () => {
    const alloc = allocateLandedCost({
      lines: [{ qty: 1, unitCost: '10' }],
      extraCost: 0,
    });
    expect(alloc[0]!.isZero()).toBe(true);
  });
});

describe('calculateTax', () => {
  it('desglosa el IVA cuando el precio ya lo incluye', () => {
    const r = calculateTax({ base: '1160', rate: '0.16', priceIncludesTax: true });
    expect(r.taxable.toFixed(2)).toBe('1000.00');
    expect(r.tax.toFixed(2)).toBe('160.00');
    expect(r.total.toFixed(2)).toBe('1160.00');
  });

  it('agrega el IVA cuando el precio no lo incluye', () => {
    const r = calculateTax({ base: '1000', rate: '0.16', priceIncludesTax: false });
    expect(r.tax.toFixed(2)).toBe('160.00');
    expect(r.total.toFixed(2)).toBe('1160.00');
  });

  it('tasa cero no genera impuesto', () => {
    const r = calculateTax({ base: '1000', rate: '0', priceIncludesTax: false });
    expect(r.tax.isZero()).toBe(true);
    expect(r.total.toFixed(2)).toBe('1000.00');
  });
});

describe('toMoney', () => {
  it('redondea medio hacia arriba, como en comercio', () => {
    expect(toMoney('0.00005').toFixed(4)).toBe('0.0001');
    expect(toMoney(new Decimal('1.99995')).toFixed(4)).toBe('2.0000');
  });
});
