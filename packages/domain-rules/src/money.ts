import Decimal from 'decimal.js';

/**
 * Aritmética de dinero.
 *
 * Regla del proyecto: el dinero NUNCA pasa por `number`. Un centavo perdido por
 * redondeo binario se acumula durante años y termina descuadrando el arqueo.
 *
 * En la base: NUMERIC(14,4). En la aplicación: Decimal. En la API: string.
 */

// 28 dígitos significativos, redondeo bancario para operaciones intermedias.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export type MoneyInput = string | number | Decimal;

/** Escala de almacenamiento del dinero: NUMERIC(14,4). */
export const MONEY_SCALE = 4;
/** Escala de cantidades: NUMERIC(14,3) — admite media pieza, metros, kilos. */
export const QTY_SCALE = 3;

export function money(value: MoneyInput): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Valor monetario no finito: ${value}`);
    }
    // Se convierte vía string para no arrastrar el error del binario.
    return new Decimal(value.toString());
  }
  const trimmed = value.trim();
  if (trimmed === '') throw new TypeError('Valor monetario vacío');
  const d = new Decimal(trimmed);
  if (!d.isFinite()) throw new TypeError(`Valor monetario no finito: ${value}`);
  return d;
}

export function qty(value: MoneyInput): Decimal {
  return money(value);
}

/** Redondea a la escala de almacenamiento. Medio hacia arriba, como en comercio. */
export function toMoney(value: MoneyInput): Decimal {
  return money(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
}

export function toQty(value: MoneyInput): Decimal {
  return money(value).toDecimalPlaces(QTY_SCALE, Decimal.ROUND_HALF_UP);
}

/** Serializa para la API: siempre string con la escala fija. */
export function moneyToString(value: MoneyInput): string {
  return toMoney(value).toFixed(MONEY_SCALE);
}

export function qtyToString(value: MoneyInput): string {
  return toQty(value).toFixed(QTY_SCALE);
}

/** Importe presentable al usuario, a 2 decimales. */
export function toDisplay(value: MoneyInput): string {
  return money(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(money(v)), new Decimal(0));
}

export function isZero(value: MoneyInput): boolean {
  return money(value).isZero();
}

export function isNegative(value: MoneyInput): boolean {
  return money(value).isNegative();
}

/**
 * Costo promedio ponderado móvil.
 *
 *   (existencia × costo actual + entrada × costo entrada) / (existencia + entrada)
 *
 * Solo lo mueven las ENTRADAS. Una salida no altera el promedio: por eso una
 * venta jamás cambia la valuación del inventario restante.
 */
export function weightedAverageCost(params: {
  currentQty: MoneyInput;
  currentAvgCost: MoneyInput;
  incomingQty: MoneyInput;
  incomingUnitCost: MoneyInput;
}): Decimal {
  const currentQty = money(params.currentQty);
  const currentAvgCost = money(params.currentAvgCost);
  const incomingQty = money(params.incomingQty);
  const incomingUnitCost = money(params.incomingUnitCost);

  if (incomingQty.lte(0)) return toMoney(currentAvgCost);

  const totalQty = currentQty.plus(incomingQty);
  if (totalQty.lte(0)) return toMoney(incomingUnitCost);

  // Existencia en cero o negativa: el promedio pasa a ser el costo que entra.
  if (currentQty.lte(0)) return toMoney(incomingUnitCost);

  const totalValue = currentQty.times(currentAvgCost).plus(incomingQty.times(incomingUnitCost));
  return toMoney(totalValue.dividedBy(totalQty));
}

/**
 * Redondeo de efectivo (P8).
 *
 * En México el efectivo se paga con monedas de 50 centavos como mínimo
 * práctico. Un total de $1,499.30 no se puede cobrar exacto. El ajuste se
 * guarda aparte, aparece en el ticket y hace que el arqueo cuadre al centavo.
 */
export function roundCash(total: MoneyInput, step: MoneyInput = '0.50'): {
  rounded: Decimal;
  adjustment: Decimal;
} {
  const amount = toMoney(total);
  const increment = money(step);

  if (increment.lte(0)) {
    return { rounded: amount, adjustment: new Decimal(0) };
  }

  const rounded = amount
    .dividedBy(increment)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .times(increment);

  return {
    rounded: toMoney(rounded),
    adjustment: toMoney(rounded.minus(amount)),
  };
}

/**
 * Prorrateo de costos de importación (P5).
 *
 * Reparte flete, aduana y gastos entre las líneas de una recepción para obtener
 * el costo REAL puesto en bodega. Sin esto, todos los márgenes salen
 * sistemáticamente optimistas.
 *
 * El último renglón absorbe el residuo del redondeo, para que la suma de los
 * prorrateos sea exactamente el total repartido.
 */
export function allocateLandedCost(params: {
  lines: { qty: MoneyInput; unitCost: MoneyInput; weightGrams?: number | null }[];
  extraCost: MoneyInput;
  method?: 'BY_VALUE' | 'BY_WEIGHT' | 'BY_QTY';
}): Decimal[] {
  const { lines, method = 'BY_VALUE' } = params;
  const extra = toMoney(params.extraCost);

  if (lines.length === 0) return [];
  if (extra.isZero()) return lines.map(() => new Decimal(0));

  const weights = lines.map((line) => {
    const lineQty = money(line.qty);
    switch (method) {
      case 'BY_QTY':
        return lineQty;
      case 'BY_WEIGHT':
        return lineQty.times(money(line.weightGrams ?? 0));
      case 'BY_VALUE':
      default:
        return lineQty.times(money(line.unitCost));
    }
  });

  const totalWeight = sum(weights);

  // Sin base para repartir (todo en cero): se reparte en partes iguales.
  if (totalWeight.lte(0)) {
    const each = toMoney(extra.dividedBy(lines.length));
    const result = lines.map(() => each);
    const residual = extra.minus(sum(result));
    result[result.length - 1] = toMoney(result[result.length - 1]!.plus(residual));
    return result;
  }

  const allocations = weights.map((w) => toMoney(extra.times(w).dividedBy(totalWeight)));

  const residual = extra.minus(sum(allocations));
  if (!residual.isZero()) {
    allocations[allocations.length - 1] = toMoney(
      allocations[allocations.length - 1]!.plus(residual),
    );
  }

  return allocations;
}

/** Calcula el impuesto de una línea. `rate` es fracción: 0.16 = 16 %. */
export function calculateTax(params: {
  base: MoneyInput;
  rate: MoneyInput;
  priceIncludesTax: boolean;
}): { taxable: Decimal; tax: Decimal; total: Decimal } {
  const base = money(params.base);
  const rate = money(params.rate);

  if (rate.isZero()) {
    const b = toMoney(base);
    return { taxable: b, tax: new Decimal(0), total: b };
  }

  if (params.priceIncludesTax) {
    // El precio ya trae el impuesto: se desglosa hacia atrás.
    const taxable = toMoney(base.dividedBy(rate.plus(1)));
    const tax = toMoney(base.minus(taxable));
    return { taxable, tax, total: toMoney(base) };
  }

  const taxable = toMoney(base);
  const tax = toMoney(taxable.times(rate));
  return { taxable, tax, total: toMoney(taxable.plus(tax)) };
}
