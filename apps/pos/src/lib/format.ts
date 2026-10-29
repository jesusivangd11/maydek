/**
 * Formato de presentación.
 *
 * El dinero llega del API como string con 4 decimales (`"580.0000"`) y se
 * muestra con 2. La conversión a `number` ocurre SOLO aquí, para pintar: los
 * cálculos que deciden cuánto cobra la tienda los hace el servidor con Decimal.
 */

const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return MXN.format(0);
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? MXN.format(amount) : MXN.format(0);
}

/** Cantidad sin ceros de relleno: "3.000" → "3", "1.500" → "1.5" */
export function formatQty(value: string | number): string {
  const qty = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(qty)) return '0';
  return String(Number(qty.toFixed(3)));
}

const TIME = new Intl.DateTimeFormat('es-MX', {
  hour: '2-digit',
  minute: '2-digit',
});

const DATE_TIME = new Intl.DateTimeFormat('es-MX', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTime(value: string | Date): string {
  return TIME.format(new Date(value));
}

export function formatDateTime(value: string | Date): string {
  return DATE_TIME.format(new Date(value));
}

/** Suma en string para no arrastrar el error del binario en la vista. */
export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
