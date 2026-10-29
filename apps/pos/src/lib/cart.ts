import type { CatalogItem, CommonItem, SaleLineInput } from './api';
import { toNumber } from './format';

/**
 * El carrito.
 *
 * Calcula importes SOLO para mostrarlos mientras el cajero arma el ticket. El
 * total que se cobra lo devuelve el servidor al registrar la venta, y es el que
 * manda: aquí se usa `number` por comodidad, y un centavo de diferencia por
 * redondeo binario no puede decidir cuánto paga un cliente.
 *
 * La existencia NO topa la cantidad. En mostrador el sistema dice 0 y el
 * artículo está en la mano del cliente: se vende, y el inventario queda en
 * negativo hasta que se capture la entrada. Si la tienda lo prohíbe en
 * Configuración, el servidor es quien rechaza la venta.
 */

export interface CartLine {
  /**
   * Identificador del renglón. Para un artículo del catálogo es su variante
   * (pasarlo dos veces sube la cantidad); un producto común lleva clave
   * propia, porque cada uno es distinto aunque compartan variante.
   */
  key: string;
  variantId: string;
  sku: string;
  barcode?: string | null;
  name: string;
  unitPrice: number;
  qty: number;
  /** Descuento por renglón, en importe. */
  discount: number;
  /** Existencia al momento de agregarlo; puede ser negativa. */
  available: number;
  trackStock: boolean;
  unit: string;
  /** Producto común: descripción y precio los puso el cajero. */
  common?: boolean;
}

export interface CartTotals {
  lineCount: number;
  itemCount: number;
  gross: number;
  discount: number;
  total: number;
}

export function lineTotal(line: CartLine): number {
  return Math.max(0, line.unitPrice * line.qty - line.discount);
}

export function cartTotals(lines: CartLine[]): CartTotals {
  const gross = lines.reduce((acc, l) => acc + l.unitPrice * l.qty, 0);
  const discount = lines.reduce((acc, l) => acc + l.discount, 0);

  return {
    lineCount: lines.length,
    itemCount: lines.reduce((acc, l) => acc + l.qty, 0),
    gross,
    discount,
    total: Math.max(0, gross - discount),
  };
}

/**
 * Agrega un artículo. Si ya está en el ticket, SUBE LA CANTIDAD en vez de
 * abrir otro renglón: es lo que espera quien pasa el mismo producto dos veces
 * por el lector.
 */
export function addToCart(lines: CartLine[], item: CatalogItem, qty = 1): CartLine[] {
  const existing = lines.findIndex((l) => l.key === item.variantId);

  if (existing >= 0) {
    return lines.map((line, index) =>
      index === existing ? { ...line, qty: roundQty(line.qty + qty) } : line,
    );
  }

  return [
    ...lines,
    {
      key: item.variantId,
      variantId: item.variantId,
      sku: item.sku,
      barcode: item.barcode,
      name: item.name,
      unitPrice: toNumber(item.unitPrice),
      qty,
      discount: 0,
      available: toNumber(item.qtyAvailable),
      trackStock: item.trackStock,
      unit: item.unit,
    },
  ];
}

/** Agrega un producto común: siempre en renglón nuevo. */
export function addCommonItem(
  lines: CartLine[],
  common: CommonItem,
  input: { description: string; unitPrice: number; qty: number },
): CartLine[] {
  return [
    ...lines,
    {
      key: `comun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      variantId: common.variantId,
      sku: common.sku,
      barcode: null,
      name: input.description.trim() || 'Producto común',
      unitPrice: input.unitPrice,
      qty: input.qty,
      discount: 0,
      available: 0,
      trackStock: false,
      unit: 'PZA',
      common: true,
    },
  ];
}

/** Fija la cantidad. Cero o menos elimina el renglón. */
export function setQty(lines: CartLine[], key: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.key !== key);
  return lines.map((l) => (l.key === key ? { ...l, qty: roundQty(qty) } : l));
}

/**
 * Refresca existencia con lo que acaba de decir el servidor. Solo informa: la
 * columna «Existencia» del ticket muestra el dato fresco, pero la cantidad
 * capturada no se toca.
 */
export function syncAvailability(lines: CartLine[], items: CatalogItem[]): CartLine[] {
  if (items.length === 0) return lines;
  const fresh = new Map(items.map((i) => [i.variantId, i]));

  return lines.map((line) => {
    const item = line.common ? undefined : fresh.get(line.variantId);
    return item ? { ...line, available: toNumber(item.qtyAvailable) } : line;
  });
}

/** Cambia los precios del ticket (al activar o quitar mayoreo, o cambiar de cliente). */
export function reprice(lines: CartLine[], items: CatalogItem[]): CartLine[] {
  const fresh = new Map(items.map((i) => [i.variantId, i]));
  return lines.map((line) => {
    const item = line.common ? undefined : fresh.get(line.variantId);
    return item ? { ...line, unitPrice: toNumber(item.unitPrice), discount: 0 } : line;
  });
}

export function setDiscount(lines: CartLine[], key: string, discount: number): CartLine[] {
  return lines.map((l) =>
    l.key === key
      ? { ...l, discount: Math.max(0, Math.min(discount, l.unitPrice * l.qty)) }
      : l,
  );
}

/**
 * Descuento a todo el ticket.
 *
 * Se REPARTE entre los renglones en proporción a su importe y se registra
 * renglón por renglón. Así el servidor lo valida con las mismas reglas que un
 * descuento de línea, el reporte por artículo sabe cuánto se descontó de cada
 * uno, y una devolución parcial devuelve el precio realmente pagado.
 *
 * El último renglón absorbe el redondeo, para que la suma cuadre al centavo.
 * Reemplaza cualquier descuento previo: aplicar 10 % dos veces no es 20 %.
 */
export function applyGlobalDiscount(lines: CartLine[], amount: number): CartLine[] {
  const gross = lines.reduce((acc, l) => acc + l.unitPrice * l.qty, 0);
  const target = Math.max(0, Math.min(round2(amount), round2(gross)));
  if (gross <= 0) return lines;

  let assigned = 0;
  return lines.map((line, index) => {
    const lineGross = line.unitPrice * line.qty;
    const share =
      index === lines.length - 1
        ? round2(target - assigned)
        : round2((target * lineGross) / gross);
    assigned += share;
    return { ...line, discount: Math.max(0, Math.min(share, lineGross)) };
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Hasta 3 decimales, como el servidor: 0.1 + 0.2 no debe pintar 0.30000000000000004. */
function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function removeLine(lines: CartLine[], key: string): CartLine[] {
  return lines.filter((l) => l.key !== key);
}

/** Renglones que dejarán la existencia en negativo: solo para avisar. */
export function overstockedLines(lines: CartLine[]): CartLine[] {
  return lines.filter((l) => l.trackStock && !l.common && l.qty > l.available);
}

/** Convierte el carrito al contrato del API. */
export function toSaleLines(lines: CartLine[]): SaleLineInput[] {
  return lines.map((line) => ({
    variantId: line.variantId,
    qty: String(line.qty),
    ...(line.common ? { unitPrice: line.unitPrice.toFixed(2), description: line.name } : {}),
    ...(line.discount > 0
      ? { discountAmount: line.discount.toFixed(2), discountReason: 'Descuento en caja' }
      : {}),
  }));
}

/**
 * Tickets guardados antes de que existiera `key` (en espera o en el
 * almacenamiento local): se les asigna su variante como clave.
 */
export function normalizeLines(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is CartLine => typeof l === 'object' && l !== null && 'variantId' in l)
    .map((l) => ({ ...l, key: l.key ?? l.variantId }));
}
