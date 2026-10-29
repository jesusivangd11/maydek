import { Injectable } from '@nestjs/common';
import {
  MovementDirection,
  MovementType,
  ReferenceType,
  StockCondition,
} from '@prisma/client';
import { Decimal, money, toMoney, toQty, weightedAverageCost } from '@pv/domain-rules';
import { PrismaService } from '../../core/database/prisma.service';
import { InsufficientStockError, ValidationError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { getRequestId } from '../../core/request-context/request-context';

/**
 * EL MOTOR DEL KARDEX.
 *
 * Punto ÚNICO por el que puede moverse la existencia. Ventas, compras, ajustes,
 * conteos y traspasos pasan todos por aquí. Nadie escribe `stock_balances` a
 * mano: si lo hiciera, el saldo y el kardex se separarían y el inventario
 * dejaría de ser auditable.
 *
 * Garantías que ofrece:
 *   1. Bloqueo de filas en orden determinista, para no provocar abrazos mortales.
 *   2. Validación del disponible ANTES de escribir: no se vende lo que no hay.
 *   3. Un asiento en `stock_ledger` por línea, con saldo antes y después.
 *   4. Costo promedio ponderado recalculado SOLO en entradas.
 *   5. Devuelve el costo unitario con el que salió cada línea, que es el COGS
 *      que la venta congela (req. 35).
 *
 * DEBE invocarse dentro de una transacción. No la abre por su cuenta a
 * propósito: la venta, el asiento y el movimiento de caja tienen que nacer o
 * fallar juntos.
 */

export interface StockPostingLine {
  variantId: string;
  warehouseId: string;
  condition?: StockCondition;
  /** Siempre POSITIVA. La dirección la marca `direction`, no el signo. */
  qty: string | number | Decimal;
  /** Obligatorio en entradas: sin él no se puede recalcular el promedio. */
  unitCost?: string | number | Decimal | null;
  /** Solo para el mensaje de error cuando no alcanza la existencia. */
  sku?: string;
  name?: string;
}

export interface StockPostingInput {
  movementType: MovementType;
  direction: MovementDirection;
  lines: StockPostingLine[];
  referenceType: ReferenceType;
  referenceId?: string | null;
  referenceFolio?: string | null;
  userId?: string | null;
  terminalId?: string | null;
  channelId?: string | null;
  reasonCode?: string | null;
  notes?: string | null;
  occurredAt?: Date;
  /**
   * Vender por debajo de cero. Exige el permiso `inventory.allow_negative`;
   * quien llama ya lo verificó. Aquí solo se obedece.
   */
  allowNegative?: boolean;
}

export interface PostedLine {
  variantId: string;
  warehouseId: string;
  condition: StockCondition;
  qty: Decimal;
  qtyBefore: Decimal;
  qtyAfter: Decimal;
  /** En salidas es el COGS del momento; en entradas, el costo de compra. */
  unitCost: Decimal;
  avgCostAfter: Decimal;
  ledgerId: string;
}

interface BalanceState {
  qtyOnHand: Decimal;
  qtyReserved: Decimal;
  avgCost: Decimal;
}

const SEPARATOR = '::';

function keyOf(variantId: string, warehouseId: string, condition: StockCondition): string {
  return [variantId, warehouseId, condition].join(SEPARATOR);
}

@Injectable()
export class StockPostingService {
  constructor(private readonly prisma: PrismaService) {}

  async post(input: StockPostingInput): Promise<PostedLine[]> {
    if (input.lines.length === 0) return [];

    const tx = this.prisma.client;
    const occurredAt = input.occurredAt ?? new Date();
    const isInbound = input.direction === MovementDirection.IN;

    // ── 1. Normalizar y validar cantidades ──
    const lines = input.lines.map((line) => {
      const quantity = toQty(line.qty);
      if (quantity.lte(0)) {
        throw new ValidationError(
          'La cantidad de un movimiento de inventario debe ser mayor que cero',
          { variantId: line.variantId, qty: quantity.toString() },
        );
      }
      return { ...line, qty: quantity, condition: line.condition ?? StockCondition.GOOD };
    });

    // ── 2. Bloquear todas las filas de saldo de una vez, en orden determinista ──
    const uniqueKeys = new Map<
      string,
      { variantId: string; warehouseId: string; condition: string }
    >();
    for (const line of lines) {
      uniqueKeys.set(keyOf(line.variantId, line.warehouseId, line.condition), {
        variantId: line.variantId,
        warehouseId: line.warehouseId,
        condition: line.condition,
      });
    }

    const locked = await this.prisma.lockStockBalances(tx, [...uniqueKeys.values()]);

    const state = new Map<string, BalanceState>();
    for (const row of locked) {
      state.set(keyOf(row.variant_id, row.warehouse_id, row.condition as StockCondition), {
        qtyOnHand: money(row.qty_on_hand.toString()),
        qtyReserved: money(row.qty_reserved.toString()),
        avgCost: money(row.avg_cost.toString()),
      });
    }
    // Las combinaciones sin fila todavía arrancan en cero.
    for (const key of uniqueKeys.keys()) {
      if (!state.has(key)) {
        state.set(key, {
          qtyOnHand: new Decimal(0),
          qtyReserved: new Decimal(0),
          avgCost: new Decimal(0),
        });
      }
    }

    // ── 3. En salidas, comprobar el disponible ANTES de tocar nada ──
    //
    // Se acumula por clave: si el mismo artículo aparece en dos renglones del
    // ticket, lo que manda es la suma, no cada renglón por separado.
    if (!isInbound && !input.allowNegative) {
      const required = new Map<string, Decimal>();
      for (const line of lines) {
        const key = keyOf(line.variantId, line.warehouseId, line.condition);
        required.set(key, (required.get(key) ?? new Decimal(0)).plus(line.qty));
      }

      const shortages = [];
      for (const [key, needed] of required) {
        const current = state.get(key)!;
        const available = current.qtyOnHand.minus(current.qtyReserved);
        if (available.lt(needed)) {
          const line = lines.find((l) => keyOf(l.variantId, l.warehouseId, l.condition) === key)!;
          shortages.push({
            variantId: line.variantId,
            sku: line.sku,
            name: line.name,
            requested: needed.toString(),
            available: available.toString(),
          });
        }
      }

      if (shortages.length > 0) throw new InsufficientStockError(shortages);
    }

    // ── 4. Asentar renglón por renglón, arrastrando el saldo ──
    const requestId = getRequestId() ?? null;
    const posted: PostedLine[] = [];
    const ledgerRows = [];

    for (const line of lines) {
      const key = keyOf(line.variantId, line.warehouseId, line.condition);
      const current = state.get(key)!;

      const qtyBefore = current.qtyOnHand;
      const qtyAfter = isInbound ? qtyBefore.plus(line.qty) : qtyBefore.minus(line.qty);

      let unitCost: Decimal;
      let avgCostAfter: Decimal;

      if (isInbound) {
        if (line.unitCost === undefined || line.unitCost === null) {
          throw new ValidationError('Una entrada de inventario necesita el costo unitario', {
            variantId: line.variantId,
          });
        }
        unitCost = toMoney(line.unitCost);
        avgCostAfter = weightedAverageCost({
          currentQty: qtyBefore,
          currentAvgCost: current.avgCost,
          incomingQty: line.qty,
          incomingUnitCost: unitCost,
        });
      } else {
        // La salida se valúa al promedio vigente y NO mueve el promedio:
        // vender no cambia lo que costó lo que queda en el almacén.
        unitCost = current.avgCost;
        avgCostAfter = current.avgCost;
      }

      const ledgerId = newId();

      ledgerRows.push({
        id: ledgerId,
        occurredAt,
        variantId: line.variantId,
        warehouseId: line.warehouseId,
        condition: line.condition,
        movementType: input.movementType,
        direction: input.direction,
        qty: line.qty.toFixed(3),
        qtyBefore: qtyBefore.toFixed(3),
        qtyAfter: qtyAfter.toFixed(3),
        unitCost: unitCost.toFixed(4),
        avgCostAfter: avgCostAfter.toFixed(4),
        totalCost: toMoney(unitCost.times(line.qty)).toFixed(4),
        reasonCode: input.reasonCode ?? null,
        notes: input.notes ?? null,
        referenceType: input.referenceType,
        referenceId: input.referenceId ?? null,
        referenceFolio: input.referenceFolio ?? null,
        channelId: input.channelId ?? null,
        userId: input.userId ?? null,
        terminalId: input.terminalId ?? null,
        requestId,
      });

      // El estado en memoria avanza para que el siguiente renglón del mismo
      // artículo parta del saldo correcto.
      state.set(key, {
        qtyOnHand: qtyAfter,
        qtyReserved: current.qtyReserved,
        avgCost: avgCostAfter,
      });

      posted.push({
        variantId: line.variantId,
        warehouseId: line.warehouseId,
        condition: line.condition,
        qty: line.qty,
        qtyBefore,
        qtyAfter,
        unitCost,
        avgCostAfter,
        ledgerId,
      });
    }

    // ── 5. Escribir: primero el kardex (append-only), luego los saldos ──
    await tx.stockLedger.createMany({ data: ledgerRows });

    for (const [key, final] of state) {
      const [variantId, warehouseId, condition] = key.split(SEPARATOR) as [
        string,
        string,
        StockCondition,
      ];

      await tx.stockBalance.upsert({
        where: { variantId_warehouseId_condition: { variantId, warehouseId, condition } },
        create: {
          variantId,
          warehouseId,
          condition,
          qtyOnHand: final.qtyOnHand.toFixed(3),
          qtyReserved: final.qtyReserved.toFixed(3),
          avgCost: final.avgCost.toFixed(4),
          lastMovementAt: occurredAt,
        },
        update: {
          qtyOnHand: final.qtyOnHand.toFixed(3),
          avgCost: final.avgCost.toFixed(4),
          lastMovementAt: occurredAt,
        },
      });
    }

    // ── 6. El costo del variante refleja el promedio recién calculado ──
    //
    // Solo en entradas: es el único momento en que el promedio se mueve.
    if (isInbound) {
      for (const line of posted) {
        await tx.productVariant.update({
          where: { id: line.variantId },
          data: { cost: line.avgCostAfter.toFixed(4), lastCost: line.unitCost.toFixed(4) },
        });
      }
    }

    return posted;
  }
}
