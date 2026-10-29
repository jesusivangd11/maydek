import { Injectable } from '@nestjs/common';
import { Decimal, money, toMoney } from '@pv/domain-rules';
import { PrismaService } from '../../core/database/prisma.service';
import { newId } from '../../core/ids';
import { SettingsService } from '../settings/settings.service';

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

/** Código de la lista que usa la tecla de mayoreo si la configuración no elige otra. */
export const WHOLESALE_LIST_CODE = 'MAYOREO';

/** SKU del artículo de sistema que respalda los renglones de «producto común». */
export const COMMON_ITEM_SKU = 'COMUN';

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * La lista de precios de mayoreo: la que eligió el dueño en Configuración o,
   * si no eligió ninguna, la de código MAYOREO, que se crea la primera vez que
   * se necesita. Así F11 funciona desde el primer día sin configurar nada.
   */
  async wholesalePriceListId(): Promise<string> {
    const configured = await this.settings.get('sales.wholesalePriceListId');
    if (configured) {
      const list = await this.prisma.client.priceList.findFirst({
        where: { id: configured, deletedAt: null },
        select: { id: true },
      });
      if (list) return list.id;
    }

    const list = await this.prisma.client.priceList.upsert({
      where: { code: WHOLESALE_LIST_CODE },
      create: { id: newId(), code: WHOLESALE_LIST_CODE, name: 'Mayoreo', includesTax: true, priority: 10 },
      update: {},
      select: { id: true },
    });
    return list.id;
  }

  /**
   * Fija (o quita, con null) el precio de mayoreo de un artículo. Un solo
   * escalón desde 1 pieza: el precio por volumen fino se sigue capturando en
   * las listas de precios.
   */
  async setWholesalePrice(variantId: string, price: string | null) {
    const priceListId = await this.wholesalePriceListId();
    const tx = this.prisma.client;
    if (price === null || price === '') {
      await tx.priceListItem.deleteMany({ where: { priceListId, variantId, minQty: 1 } });
      return;
    }
    await tx.priceListItem.upsert({
      where: { priceListId_variantId_minQty: { priceListId, variantId, minQty: 1 } },
      create: { id: newId(), priceListId, variantId, minQty: 1, price: toMoney(price).toFixed(4) },
      update: { price: toMoney(price).toFixed(4) },
    });
  }

  /** Precio de mayoreo (escalón de 1 pieza) de varios artículos. */
  async wholesalePrices(variantIds: string[]): Promise<Map<string, string>> {
    if (variantIds.length === 0) return new Map();
    const priceListId = await this.wholesalePriceListId();
    const items = await this.prisma.client.priceListItem.findMany({
      where: { priceListId, variantId: { in: variantIds }, minQty: 1 },
      select: { variantId: true, price: true },
    });
    return new Map(items.map((i) => [i.variantId, i.price.toString()]));
  }

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
