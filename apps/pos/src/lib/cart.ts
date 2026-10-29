import type { CatalogItem, SaleLineInput } from './api';
import { toNumber } from './format';

/**
 * El carrito.
 *
 * Calcula importes SOLO para mostrarlos mientras el cajero arma el ticket. El
 * total que se cobra lo devuelve el servidor al registrar la venta, y es el que
 * manda: aquí se usa `number` por comodidad, y un centavo de diferencia por
 * redondeo binario no puede decidir cuánto paga un cliente.
 *
 * Si el total de pantalla y el del servidor no coinciden, gana el del servidor
 * y la pantalla se corrige sola al confirmar.
 */

export interface CartLine {
  variantId: string;
  sku: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Descuento por renglón, en importe. */
  discount: number;
  /** Existencia disponible al momento de agregarlo, para avisar al pasarse. */
  available: number;
  trackStock: boolean;
  unit: string;
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
 * Tope de cantidad de un renglón.
 *
 * Un servicio no tiene existencia y no se topa. Un artículo con inventario no
 * puede pasar de lo disponible: el servidor lo rechazaría de todas formas, y
 * es mejor que el cajero se entere ANTES de decirle un total al cliente que
 * después, con el ticket ya cantado.
 *
 * Esto NO sustituye la validación del servidor, que es la que manda y la que
 * vuelve a comprobar con la fila bloqueada.
 */
export function maxQtyFor(line: Pick<CartLine, 'trackStock' | 'available'>): number {
  if (!line.trackStock) return Number.POSITIVE_INFINITY;
  return Math.max(0, line.available);
}

/** ¿El renglón ya está en su tope? Lo usa la interfaz para apagar el "+". */
export function isAtMax(line: CartLine): boolean {
  return line.qty >= maxQtyFor(line);
}

/**
 * Agrega un artículo. Si ya está en el ticket, SUBE LA CANTIDAD en vez de
 * abrir otro renglón: es lo que espera quien pasa el mismo producto dos veces
 * por el lector.
 *
 * Nunca sube por encima de la existencia disponible.
 */
export function addToCart(lines: CartLine[], item: CatalogItem, qty = 1): CartLine[] {
  const existing = lines.findIndex((l) => l.variantId === item.variantId);

  if (existing >= 0) {
    return lines.map((line, index) =>
      index === existing
        ? { ...line, qty: Math.min(line.qty + qty, maxQtyFor(line)) }
        : line,
    );
  }

  const available = toNumber(item.qtyAvailable);
  const cap = item.trackStock ? Math.max(0, available) : Number.POSITIVE_INFINITY;

  // Sin existencia no se abre renglón: el ticket no debe nacer inválido.
  if (cap <= 0) return lines;

  return [
    ...lines,
    {
      variantId: item.variantId,
      sku: item.sku,
      name: item.name,
      unitPrice: toNumber(item.unitPrice),
      qty: Math.min(qty, cap),
      discount: 0,
      available,
      trackStock: item.trackStock,
      unit: item.unit,
    },
  ];
}

/** Fija la cantidad. Cero o menos elimina el renglón; el tope es la existencia. */
export function setQty(lines: CartLine[], variantId: string, qty: number): CartLine[] {
  if (qty <= 0) return lines.filter((l) => l.variantId !== variantId);
  return lines.map((l) =>
    l.variantId === variantId ? { ...l, qty: Math.min(qty, maxQtyFor(l)) } : l,
  );
}

/**
 * Refresca existencia y precio con lo que acaba de decir el servidor.
 *
 * Se llama tras cada búsqueda: si otra caja vendió las últimas piezas mientras
 * este ticket estaba abierto, el tope baja aquí y no en el cobro.
 */
export function syncAvailability(lines: CartLine[], items: CatalogItem[]): CartLine[] {
  if (items.length === 0) return lines;
  const fresh = new Map(items.map((i) => [i.variantId, i]));

  return lines.map((line) => {
    const item = fresh.get(line.variantId);
    if (!item) return line;

    const available = toNumber(item.qtyAvailable);
    const cap = item.trackStock ? Math.max(0, available) : Number.POSITIVE_INFINITY;

    return { ...line, available, qty: Math.min(line.qty, cap) };
  });
}

export function setDiscount(lines: CartLine[], variantId: string, discount: number): CartLine[] {
  return lines.map((l) =>
    l.variantId === variantId
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

export function removeLine(lines: CartLine[], variantId: string): CartLine[] {
  return lines.filter((l) => l.variantId !== variantId);
}

/** Renglones que se pasaron de la existencia conocida. */
export function overstockedLines(lines: CartLine[]): CartLine[] {
  return lines.filter((l) => l.trackStock && l.qty > l.available);
}

/** Convierte el carrito al contrato del API. */
export function toSaleLines(lines: CartLine[]): SaleLineInput[] {
  return lines.map((line) => ({
    variantId: line.variantId,
    qty: String(line.qty),
    ...(line.discount > 0
      ? { discountAmount: line.discount.toFixed(2), discountReason: 'Descuento en caja' }
      : {}),
  }));
}
