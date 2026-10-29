import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * PRUEBAS DE CONCURRENCIA — el escenario que define todo el sistema.
 *
 *   Stock = 1. Al mismo tiempo, el cliente A compra en la web y el cliente B
 *   en el mostrador. ¿Qué impide vender la misma pieza dos veces?
 *
 * Corren contra PostgreSQL REAL. Un simulador no tiene bloqueos de fila ni
 * restricciones CHECK: aprobaría exactamente el código que estas pruebas
 * existen para rechazar.
 *
 * Cada prueba reproduce lo que hará `StockService.apply()` en la Fase 3:
 * abrir transacción, bloquear la fila de saldo en orden determinista, validar,
 * insertar el asiento y actualizar el saldo. Verificar el mecanismo ahora, con
 * la base vacía, es lo que permite construir el inventario encima con confianza.
 */

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.DATABASE_MIGRATION_URL ?? APP_URL;

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const id = () => uuidv7();

let branchId: string;
let warehouseId: string;

beforeAll(async () => {
  await owner.$connect();

  const company = await owner.company.create({
    data: { id: id(), name: `Concurrencia ${Date.now()}`, timezone: 'America/Chihuahua' },
  });
  const branch = await owner.branch.create({
    data: {
      id: id(),
      companyId: company.id,
      code: `C${Date.now() % 1000}`,
      name: 'Sucursal concurrencia',
    },
  });
  branchId = branch.id;

  const warehouse = await owner.warehouse.create({
    data: { id: id(), branchId, code: 'CONC', name: 'Almacén', type: 'SALES_FLOOR' },
  });
  warehouseId = warehouse.id;
}, 60_000);

afterAll(async () => {
  await owner.$disconnect();
});

/** Crea una variante con existencia inicial. */
async function crearVarianteConStock(qty: string): Promise<string> {
  const product = await owner.product.create({
    data: { id: id(), name: `Faja ${Date.now()}-${Math.random()}`, hasVariants: false },
  });
  const variant = await owner.productVariant.create({
    data: {
      id: id(),
      productId: product.id,
      sku: `CONC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      cost: '400.0000',
      basePrice: '999.0000',
    },
  });
  await owner.stockBalance.create({
    data: {
      variantId: variant.id,
      warehouseId,
      condition: 'GOOD',
      qtyOnHand: qty,
      avgCost: '400.0000',
    },
  });
  return variant.id;
}

/**
 * Una venta, tal como la ejecutará StockService.apply().
 *
 * Los pasos son exactamente los de docs/07-concurrencia.md §"La secuencia real".
 */
async function intentarVender(
  variantId: string,
  qty: number,
): Promise<'vendido' | 'sin_stock'> {
  try {
    await owner.$transaction(
      async (tx) => {
        // 1 · BLOQUEO en orden determinista.
        //     Sin el ORDER BY, dos transacciones que tocan los mismos dos
        //     productos en orden inverso se bloquean mutuamente para siempre.
        const filas = await tx.$queryRaw<
          { qty_on_hand: unknown; qty_reserved: unknown; avg_cost: unknown }[]
        >`
          SELECT qty_on_hand, qty_reserved, avg_cost
          FROM stock_balances
          WHERE variant_id = ${variantId}::uuid
            AND warehouse_id = ${warehouseId}::uuid
            AND condition = 'GOOD'
          ORDER BY variant_id, warehouse_id, condition
          FOR UPDATE
        `;

        const saldo = filas[0];
        if (!saldo) throw new Error('SIN_SALDO');

        const enMano = Number(String(saldo.qty_on_hand));
        const reservado = Number(String(saldo.qty_reserved));
        const disponible = enMano - reservado;

        // 2 · VALIDACIÓN sobre un dato que nadie más puede cambiar ahora.
        if (disponible < qty) throw new Error('SIN_STOCK');

        // 3 · ASIENTO inmutable en el kardex.
        await tx.$executeRaw`
          INSERT INTO stock_ledger
            (id, occurred_at, variant_id, warehouse_id, condition, movement_type,
             direction, qty, qty_before, qty_after, unit_cost, reference_type, created_at)
          VALUES
            (${id()}::uuid, now(), ${variantId}::uuid, ${warehouseId}::uuid, 'GOOD',
             'SALE', 'OUT', ${qty}, ${enMano}, ${enMano - qty}, 400, 'SALE', now())
        `;

        // 4 · SALDO derivado.
        await tx.$executeRaw`
          UPDATE stock_balances
          SET qty_on_hand = qty_on_hand - ${qty}, last_movement_at = now()
          WHERE variant_id = ${variantId}::uuid
            AND warehouse_id = ${warehouseId}::uuid
            AND condition = 'GOOD'
        `;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    return 'vendido';
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    if (
      mensaje.includes('SIN_STOCK') ||
      mensaje.includes('SIN_SALDO') ||
      mensaje.includes('chk_stock_no_negativo')
    ) {
      return 'sin_stock';
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Sobreventa — el escenario del requisito 24', () => {
  it('50 compradores simultáneos, 1 pieza: exactamente 1 vende', async () => {
    const variantId = await crearVarianteConStock('1.000');

    // Todas salen a la vez: ninguna espera a la anterior.
    const resultados = await Promise.all(
      Array.from({ length: 50 }, () => intentarVender(variantId, 1)),
    );

    const vendidos = resultados.filter((r) => r === 'vendido').length;
    const rechazados = resultados.filter((r) => r === 'sin_stock').length;

    expect(vendidos).toBe(1);
    expect(rechazados).toBe(49);

    // El saldo queda en cero, no en negativo.
    const saldo = await owner.stockBalance.findUnique({
      where: {
        variantId_warehouseId_condition: { variantId, warehouseId, condition: 'GOOD' },
      },
    });
    expect(Number(saldo?.qtyOnHand)).toBe(0);

    // Y el kardex registra UN solo movimiento: no hay asientos huérfanos de
    // transacciones que hicieron rollback.
    const asientos = await owner.stockLedger.count({ where: { variantId } });
    expect(asientos).toBe(1);
  }, 60_000);

  it('20 compradores, 5 piezas: venden 5 y el resto se rechaza', async () => {
    const variantId = await crearVarianteConStock('5.000');

    const resultados = await Promise.all(
      Array.from({ length: 20 }, () => intentarVender(variantId, 1)),
    );

    expect(resultados.filter((r) => r === 'vendido').length).toBe(5);
    expect(resultados.filter((r) => r === 'sin_stock').length).toBe(15);

    const saldo = await owner.stockBalance.findUnique({
      where: {
        variantId_warehouseId_condition: { variantId, warehouseId, condition: 'GOOD' },
      },
    });
    expect(Number(saldo?.qtyOnHand)).toBe(0);
  }, 60_000);

  it('cantidades distintas: 10 piezas repartidas entre compras de 1, 2 y 3', async () => {
    const variantId = await crearVarianteConStock('10.000');

    const intentos = [3, 2, 1, 3, 2, 1, 3, 2, 1, 3];
    const resultados = await Promise.all(
      intentos.map((qty) => intentarVender(variantId, qty)),
    );

    const vendidas = intentos.filter((_, i) => resultados[i] === 'vendido');
    const total = vendidas.reduce((a, b) => a + b, 0);

    // Nunca se vende más de lo que había.
    expect(total).toBeLessThanOrEqual(10);

    const saldo = await owner.stockBalance.findUnique({
      where: {
        variantId_warehouseId_condition: { variantId, warehouseId, condition: 'GOOD' },
      },
    });
    expect(Number(saldo?.qtyOnHand)).toBe(10 - total);
    expect(Number(saldo?.qtyOnHand)).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('El kardex siempre reconstruye el saldo', () => {
  it('tras 60 operaciones concurrentes, SUM(kardex) = saldo', async () => {
    const variantId = await crearVarianteConStock('30.000');

    await Promise.all(Array.from({ length: 60 }, () => intentarVender(variantId, 1)));

    const filas = await owner.$queryRaw<{ saldo: unknown; kardex: unknown }[]>`
      SELECT
        b.qty_on_hand AS saldo,
        (SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN qty ELSE -qty END), 0)
         FROM stock_ledger l
         WHERE l.variant_id = b.variant_id
           AND l.warehouse_id = b.warehouse_id
           AND l.condition = b.condition) AS kardex
      FROM stock_balances b
      WHERE b.variant_id = ${variantId}::uuid
        AND b.warehouse_id = ${warehouseId}::uuid
        AND b.condition = 'GOOD'
    `;

    const saldo = Number(String(filas[0]?.saldo));
    const kardex = Number(String(filas[0]?.kardex));

    // La carga inicial se hizo con INSERT directo, así que el kardex refleja
    // solo las salidas: saldo = 30 + kardex.
    expect(saldo).toBe(30 + kardex);
    expect(saldo).toBe(0);
    expect(kardex).toBe(-30);
  }, 90_000);
});

describe('Reserva contra venta — web y mostrador a la vez', () => {
  it('con 1 pieza, si la web reserva primero el mostrador no puede vender', async () => {
    const variantId = await crearVarianteConStock('1.000');

    // La web reserva.
    await owner.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT qty_on_hand FROM stock_balances
        WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
          AND condition = 'GOOD'
        FOR UPDATE
      `;
      await tx.$executeRaw`
        UPDATE stock_balances SET qty_reserved = qty_reserved + 1
        WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
          AND condition = 'GOOD'
      `;
      await tx.reservation.create({
        data: {
          id: id(),
          variantId,
          warehouseId,
          qty: '1.000',
          status: 'HELD',
          purpose: 'WEB_ORDER',
          expiresAt: new Date(Date.now() + 20 * 60_000),
        },
      });
    });

    // El mostrador intenta vender la misma pieza.
    const resultado = await intentarVender(variantId, 1);

    // Físico 1, reservado 1, disponible 0 → no se puede vender.
    expect(resultado).toBe('sin_stock');

    const filas = await owner.$queryRaw<{ qty_available: unknown }[]>`
      SELECT qty_available FROM stock_balances
      WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
        AND condition = 'GOOD'
    `;
    expect(Number(String(filas[0]?.qty_available))).toBe(0);
  }, 60_000);

  it('liberar la reserva devuelve la pieza al mostrador', async () => {
    const variantId = await crearVarianteConStock('1.000');

    await owner.$executeRaw`
      UPDATE stock_balances SET qty_reserved = 1
      WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
        AND condition = 'GOOD'
    `;
    expect(await intentarVender(variantId, 1)).toBe('sin_stock');

    // La reserva vence o se cancela.
    await owner.$executeRaw`
      UPDATE stock_balances SET qty_reserved = 0
      WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
        AND condition = 'GOOD'
    `;
    expect(await intentarVender(variantId, 1)).toBe('vendido');
  }, 60_000);
});

describe('La restricción CHECK como última defensa', () => {
  it('un UPDATE que ignore la validación es rechazado por PostgreSQL', async () => {
    const variantId = await crearVarianteConStock('1.000');

    // Simula un bug futuro: descontar sin validar.
    await expect(
      owner.$executeRaw`
        UPDATE stock_balances SET qty_on_hand = qty_on_hand - 5
        WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
          AND condition = 'GOOD'
      `,
    ).rejects.toThrow(/chk_stock_no_negativo|violates check constraint/i);

    // El saldo quedó intacto: la transacción abortó completa.
    const saldo = await owner.stockBalance.findUnique({
      where: {
        variantId_warehouseId_condition: { variantId, warehouseId, condition: 'GOOD' },
      },
    });
    expect(Number(saldo?.qtyOnHand)).toBe(1);
  }, 30_000);

  it('no se puede reservar más de lo que hay físicamente', async () => {
    const variantId = await crearVarianteConStock('2.000');

    await expect(
      owner.$executeRaw`
        UPDATE stock_balances SET qty_reserved = 5
        WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
          AND condition = 'GOOD'
      `,
    ).rejects.toThrow(/chk_stock_reservado_cubierto|violates check constraint/i);
  }, 30_000);
});

describe('Folios bajo concurrencia', () => {
  it('30 documentos simultáneos: 30 folios únicos y consecutivos', async () => {
    await owner.sequence.create({
      data: { id: id(), branchId, docType: 'PURCHASE_ORDER', prefix: 'C', nextValue: 1, padding: 6 },
    });

    const folios = await Promise.all(
      Array.from({ length: 30 }, () =>
        owner.$transaction(async (tx) => {
          const filas = await tx.$queryRaw<{ next_value: bigint }[]>`
            UPDATE sequences SET next_value = next_value + 1
            WHERE branch_id = ${branchId}::uuid AND doc_type = 'PURCHASE_ORDER'
            RETURNING next_value - 1 AS next_value
          `;
          return Number(filas[0]!.next_value);
        }),
      ),
    );

    // Sin repeticiones: dos ventas nunca comparten folio.
    expect(new Set(folios).size).toBe(30);

    // Sin huecos: un salto en la numeración es una pregunta incómoda en una
    // auditoría fiscal.
    expect([...folios].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  }, 60_000);
});

describe('Idempotencia bajo concurrencia', () => {
  it('la misma clave enviada 20 veces a la vez: solo una gana', async () => {
    const key = `concurrente-${Date.now()}`;

    const resultados = await Promise.all(
      Array.from({ length: 20 }, async () => {
        try {
          await owner.idempotencyKey.create({
            data: {
              key,
              scope: 'sales',
              endpoint: 'POST /sales',
              requestHash: 'a'.repeat(64),
              expiresAt: new Date(Date.now() + 3_600_000),
            },
          });
          return 'reclamada';
        } catch {
          return 'duplicada';
        }
      }),
    );

    // Esta es la garantía del requisito 27: un reintento no crea otra venta.
    expect(resultados.filter((r) => r === 'reclamada').length).toBe(1);
    expect(resultados.filter((r) => r === 'duplicada').length).toBe(19);
  }, 60_000);
});

describe('Bloqueo por fila, no por tabla', () => {
  it('dos productos DISTINTOS se venden en paralelo sin estorbarse', async () => {
    const variantA = await crearVarianteConStock('10.000');
    const variantB = await crearVarianteConStock('10.000');

    const inicio = Date.now();

    // Si el bloqueo fuera por tabla, estas 20 operaciones se serializarían.
    await Promise.all([
      ...Array.from({ length: 10 }, () => intentarVender(variantA, 1)),
      ...Array.from({ length: 10 }, () => intentarVender(variantB, 1)),
    ]);

    const duracion = Date.now() - inicio;

    const saldoA = await owner.stockBalance.findUnique({
      where: {
        variantId_warehouseId_condition: {
          variantId: variantA,
          warehouseId,
          condition: 'GOOD',
        },
      },
    });
    const saldoB = await owner.stockBalance.findUnique({
      where: {
        variantId_warehouseId_condition: {
          variantId: variantB,
          warehouseId,
          condition: 'GOOD',
        },
      },
    });

    expect(Number(saldoA?.qtyOnHand)).toBe(0);
    expect(Number(saldoB?.qtyOnHand)).toBe(0);

    // Dos cajeros vendiendo cosas distintas nunca se esperan.
    expect(duracion).toBeLessThan(15_000);
  }, 60_000);
});
