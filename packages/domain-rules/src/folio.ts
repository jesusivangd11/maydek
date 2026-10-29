/**
 * Folios legibles: `A-001-000123`
 *
 *   A       código de sucursal
 *   001     serie del tipo de documento
 *   000123  consecutivo con relleno de ceros
 *
 * El UUID es la llave interna; el folio es lo que el cliente lee en su ticket y
 * lo que el cajero teclea para localizar una venta. Son cosas distintas y por
 * eso viven en columnas distintas.
 */

export const DOC_TYPES = {
  SALE: 'SALE',
  RETURN: 'RETURN',
  CASH_SESSION: 'CASH_SESSION',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  PURCHASE_RECEIPT: 'PURCHASE_RECEIPT',
  STOCK_COUNT: 'STOCK_COUNT',
  STOCK_TRANSFER: 'STOCK_TRANSFER',
  ADJUSTMENT: 'ADJUSTMENT',
  CREDIT_NOTE: 'CREDIT_NOTE',
  INVOICE: 'INVOICE',
} as const;

export type DocType = (typeof DOC_TYPES)[keyof typeof DOC_TYPES];

/** Serie por tipo de documento. Estable: no se cambia una vez en producción. */
export const DOC_SERIES: Record<DocType, string> = {
  SALE: '001',
  RETURN: 'DEV',
  CASH_SESSION: 'CS',
  PURCHASE_ORDER: 'PO',
  PURCHASE_RECEIPT: 'REC',
  STOCK_COUNT: 'CNT',
  STOCK_TRANSFER: 'TR',
  ADJUSTMENT: 'AJU',
  CREDIT_NOTE: 'NC',
  INVOICE: 'F',
};

export interface FolioParts {
  branchCode?: string | null;
  series: string;
  value: bigint | number;
  padding?: number;
}

export function formatFolio({ branchCode, series, value, padding = 6 }: FolioParts): string {
  const consecutive = value.toString().padStart(padding, '0');
  const segments = [branchCode, series, consecutive].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return segments.join('-');
}

/**
 * Interpreta lo que teclea el cajero.
 *
 * Acepta el folio completo (`A-001-000045`), el consecutivo suelto (`45`) o el
 * fragmento final (`000045`). Devolver `partial: true` permite que la búsqueda
 * ofrezca coincidencias recientes de la sucursal en vez de fallar.
 */
export function parseFolioInput(input: string): {
  branchCode?: string;
  series?: string;
  consecutive?: string;
  partial: boolean;
} {
  const clean = input.trim().toUpperCase();
  if (clean === '') return { partial: true };

  const full = clean.match(/^([A-Z0-9]{1,8})-([A-Z0-9]{1,8})-(\d{1,12})$/);
  if (full) {
    return {
      branchCode: full[1],
      series: full[2],
      consecutive: full[3],
      partial: false,
    };
  }

  const seriesOnly = clean.match(/^([A-Z0-9]{1,8})-(\d{1,12})$/);
  if (seriesOnly) {
    return { series: seriesOnly[1], consecutive: seriesOnly[2], partial: false };
  }

  if (/^\d{1,12}$/.test(clean)) {
    return { consecutive: clean, partial: true };
  }

  return { partial: true };
}
