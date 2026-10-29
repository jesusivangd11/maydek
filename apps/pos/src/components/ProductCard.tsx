import type { CatalogItem } from '../lib/api';
import { formatMoney, formatQty } from '../lib/format';

/**
 * Tarjeta de artículo.
 *
 * Cuatro datos y una jerarquía que no cambia nunca: nombre, SKU, precio,
 * existencia. Siempre en el mismo orden y el mismo sitio, porque lo que hace
 * rápido a un cajero no es leer, es saber dónde mirar.
 *
 * El nombre se corta a dos líneas con puntos suspensivos y lleva el nombre
 * completo en `title`: un artículo con nombre largo no puede deformar la
 * rejilla ni empujar el precio fuera de su renglón.
 */
export function ProductCard({
  item,
  onSelect,
}: {
  item: CatalogItem;
  onSelect: (item: CatalogItem) => void;
}) {
  // Agotado con inventario: no se puede vender. Un servicio no tiene
  // existencia, así que nunca se bloquea.
  const blocked = item.isOut && item.trackStock;
  const stock = describeStock(item);

  return (
    <button
      type="button"
      className={item.isOut ? 'product product--out' : 'product'}
      disabled={blocked}
      title={blocked ? `${item.name} · sin existencia` : `Agregar ${item.name}`}
      onClick={() => onSelect(item)}
    >
      <span className="product__name clamp-2">{item.name}</span>
      <span className="product__sku">{item.sku}</span>
      <span className="product__price">{formatMoney(item.unitPrice)}</span>
      <span className={stock.className}>{stock.label}</span>
    </button>
  );
}

/**
 * Existencia como estado, no como número suelto.
 *
 * Tres situaciones y tres tonos, y ninguno decorativo: rojo bloquea la venta,
 * ámbar avisa de que hay que reponer, gris es información. El umbral sale de
 * `minStock` de la variante —lo calcula el servidor—, así que "bajo" significa
 * lo que la tienda decidió que significa y no un número inventado aquí.
 */
function describeStock(item: CatalogItem): { label: string; className: string } {
  if (!item.trackStock) {
    return { label: 'Servicio', className: 'product__stock' };
  }

  if (item.isOut) {
    return { label: 'Sin existencia', className: 'product__stock product__stock--out' };
  }

  const qty = `${formatQty(item.qtyAvailable)} ${item.unit}`;

  if (item.isLow) {
    return { label: `${qty} · bajo`, className: 'product__stock product__stock--low' };
  }

  return { label: qty, className: 'product__stock' };
}
