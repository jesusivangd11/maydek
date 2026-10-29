import { Injectable } from '@nestjs/common';
import { Decimal, money, toMoney } from '@pv/domain-rules';
import { PrismaService } from '../../core/database/prisma.service';

/**
 * Resolución de precio.
 *
 * Orden de prioridad, de más específico a más general:
 *
 *   1. Lista de precios del cliente (mayoreo, distribuidor…), con precio por
 *      volumen: gana el escalón de `minQty` más alto que la cantidad alcance.
 *   2. Lista de precios del canal (POS, web, Didi…).
 *   3. `variant.basePrice` — el precio de mostrador.
 *
 * Las promociones se aplican DESPUÉS, sobre este precio base, y se registran
 * como descuento en la línea para que el ticket muestre de dónde salió.
 *
 * Devuelve también si la lista incluye impuesto, porque de eso depende si el
 * IVA se desglosa hacia atrás o se suma.
 */

export interface ResolvedPrice {
  unitPrice: Decimal;
  priceListId: string | null;
  includesTax: boolean;
  /** De qué escalón salió, para mostrarlo en la interfaz. */
  source: 'PRICE_LIST' | 'BASE_PRICE';
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Precios de varios variantes de una vez.
   *
   * En lote a propósito: el POS pinta 40 artículos en pantalla y no puede hacer
   * 40 consultas.
   */
  async resolveMany(params: {
    variantIds: string[];
    priceListId?: string | null;
    qtyByVariant?: Map<string, Decimal>;
  }): Promise<Map<string, ResolvedPrice>> {
    const { variantIds, priceListId } = params;
    const result = new Map<string, ResolvedPrice>();

    if (variantIds.length === 0) return result;

    const variants = await this.prisma.client.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, basePrice: true },
    });

    const baseById = new Map(variants.map((v) => [v.id, money(v.basePrice.toString())]));

    // Sin lista: todo al precio de mostrador.
    if (!priceListId) {
      for (const variantId of variantIds) {
        result.set(variantId, {
          unitPrice: toMoney(baseById.get(variantId) ?? new Decimal(0)),
          priceListId: null,
          includesTax: true,
          source: 'BASE_PRICE',
        });
      }
      return result;
    }

    const priceList = await this.prisma.client.priceList.findUnique({
      where: { id: priceListId },
      select: { id: true, includesTax: true, isActive: true },
    });

    const now = new Date();
    const items =
      priceList && priceList.isActive
        ? await this.prisma.client.priceListItem.findMany({
            where: {
              priceListId,
              variantId: { in: variantIds },
              OR: [{ validFrom: null }, { validFrom: { lte: now } }],
              AND: [{ OR: [{ validTo: null }, { validTo: { gte: now } }] }],
            },
            select: { variantId: true, price: true, minQty: true },
            orderBy: { minQty: 'desc' },
          })
        : [];

    // Agrupa por variante conservando el orden descendente de minQty.
    const itemsByVariant = new Map<string, { price: Decimal; minQty: Decimal }[]>();
    for (const item of items) {
      const list = itemsByVariant.get(item.variantId) ?? [];
      list.push({ price: money(item.price.toString()), minQty: money(item.minQty.toString()) });
      itemsByVariant.set(item.variantId, list);
    }

    for (const variantId of variantIds) {
      const qty = params.qtyByVariant?.get(variantId) ?? new Decimal(1);
      const escalones = itemsByVariant.get(variantId) ?? [];
      // Ya vienen de mayor a menor: el primero que la cantidad alcanza es el suyo.
      const match = escalones.find((e) => qty.gte(e.minQty));

      if (match) {
        result.set(variantId, {
          unitPrice: toMoney(match.price),
          priceListId: priceList!.id,
          includesTax: priceList!.includesTax,
          source: 'PRICE_LIST',
        });
      } else {
        result.set(variantId, {
          unitPrice: toMoney(baseById.get(variantId) ?? new Decimal(0)),
          priceListId: null,
          includesTax: priceList?.includesTax ?? true,
          source: 'BASE_PRICE',
        });
      }
    }

    return result;
  }

  async resolveOne(params: {
    variantId: string;
    priceListId?: string | null;
    qty?: Decimal;
  }): Promise<ResolvedPrice> {
    const map = await this.resolveMany({
      variantIds: [params.variantId],
      priceListId: params.priceListId,
      qtyByVariant: params.qty ? new Map([[params.variantId, params.qty]]) : undefined,
    });

    return map.get(params.variantId)!;
  }
}
