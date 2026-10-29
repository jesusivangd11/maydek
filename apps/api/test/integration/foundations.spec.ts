import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Pruebas de integración de los cimientos.
 *
 * Corren contra PostgreSQL REAL, no contra un simulador: un mock no tiene
 * restricciones CHECK ni bloqueos de fila y aprobaría código roto.
 *
 * Requisitos previos:
 *   docker compose up -d postgres
 *   pnpm --filter @pv/api db:deploy      (sobre punto_venta_test)
 *
 * Se ejecutan con:  pnpm test:integration
 */

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.DATABASE_MIGRATION_URL ?? APP_URL;

/** Conexión con el rol RESTRINGIDO de la aplicación (pv_app). */
const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
/** Conexión con el rol dueño (pv_owner), para preparar datos. */
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const id = () => uuidv7();

/**
 * Compara un decimal por VALOR, no por su representación en texto.
 *
 * PostgreSQL guarda NUMERIC(14,3), pero el `toString()` de Prisma.Decimal no
 * conserva la escala: 17.000 llega como "17". Comparar cadenas aquí produce
 * fallos falsos que no dicen nada sobre el comportamiento del sistema.
 */
function expectDecimal(actual: unknown, expected: string): void {
  expect(Number(String(actual))).toBe(Number(expected));
}

let branchId: string;
let warehouseId: string;
let variantId: string;

beforeAll(async () => {
  await app.$connect();
  await owner.$connect();

  // Datos mínimos para las pruebas, creados con el rol dueño.
  const company = await owner.company.create({
    // La zona horaria es obligatoria a propósito: sin valor por defecto,
    // nadie hereda en silencio una zona equivocada.
    data: { id: id(), name: `Pruebas ${Date.now()}`, timezone: 'America/Chihuahua' },
  });

  const branch = await owner.branch.create({
    data: { id: id(), companyId: company.id, code: `T${Date.now() % 1000}`, name: 'Sucursal de pruebas' },
  });
  branchId = branch.id;

  const warehouse = await owner.warehouse.create({
    data: { id: id(), branchId, code: 'PRUEBA', name: 'Almacén de pruebas', type: 'SALES_FLOOR' },
  });
  warehouseId = warehouse.id;

  const product = await owner.product.create({
    data: { id: id(), name: 'Faja de prueba', hasVariants: false },
  });

  const variant = await owner.productVariant.create({
    data: {
      id: id(),
      productId: product.id,
      sku: `TEST-${Date.now()}`,
      basePrice: '999.0000',
      cost: '400.0000',
    },
  });
  variantId = variant.id;
}, 60_000);

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════

describe('Restricciones del inventario — la última defensa', () => {
  it('rechaza un saldo NEGATIVO', async () => {
    await expect(
      owner.stockBalance.create({
        data: { variantId, warehouseId, condition: 'GOOD', qtyOnHand: '-1.000' },
      }),
    ).rejects.toThrow(/chk_stock_no_negativo|violates check constraint/i);
  });

  it('rechaza reservar MÁS de lo que hay físicamente', async () => {
    await expect(
      owner.stockBalance.create({
        data: {
          variantId,
          warehouseId,
          condition: 'QUARANTINE',
          qtyOnHand: '5.000',
          qtyReserved: '10.000',
        },
      }),
    ).rejects.toThrow(/chk_stock_reservado_cubierto|violates check constraint/i);
  });

  it('calcula qty_available como columna generada, no como dato editable', async () => {
    await owner.stockBalance.create({
      data: {
        variantId,
        warehouseId,
        condition: 'GOOD',
        qtyOnHand: '20.000',
        qtyReserved: '3.000',
        avgCost: '400.0000',
      },
    });

    const rows = await owner.$queryRaw<{ qty_available: unknown }[]>`
      SELECT qty_available FROM stock_balances
      WHERE variant_id = ${variantId}::uuid AND warehouse_id = ${warehouseId}::uuid
        AND condition = 'GOOD'
    `;

    // El ejemplo del requisito 3: físico 20, reservado 3, disponible 17.
    expectDecimal(rows[0]?.qty_available, '17.000');
  });

  it('rechaza un asiento del kardex INCOHERENTE (antes ± cantidad ≠ después)', async () => {
    await expect(
      owner.$executeRaw`
        INSERT INTO stock_ledger
          (id, occurred_at, variant_id, warehouse_id, condition, movement_type,
           direction, qty, qty_before, qty_after, reference_type, created_at)
        VALUES
          (${id()}::uuid, now(), ${variantId}::uuid, ${warehouseId}::uuid, 'GOOD',
           'SALE', 'OUT', 1, 10, 99, 'SALE', now())
      `,
    ).rejects.toThrow(/chk_ledger_coherente|violates check constraint/i);
  });

  it('rechaza una reserva HELD sin fecha de vencimiento', async () => {
    await expect(
      owner.reservation.create({
        data: {
          id: id(),
          variantId,
          warehouseId,
          qty: '1.000',
          status: 'HELD',
          purpose: 'WEB_ORDER',
          expiresAt: null,
        },
      }),
    ).rejects.toThrow(/chk_reserva_ttl|violates check constraint/i);
  });

  it('acepta una reserva COMMITTED sin vencimiento (comprometido no expira)', async () => {
    const reservation = await owner.reservation.create({
      data: {
        id: id(),
        variantId,
        warehouseId,
        qty: '1.000',
        status: 'COMMITTED',
        purpose: 'LAYAWAY',
        expiresAt: null,
      },
    });
    expect(reservation.status).toBe('COMMITTED');
  });
});

describe('Append-only impuesto por PostgreSQL', () => {
  let ledgerId: string;

  beforeAll(async () => {
    ledgerId = id();
    await owner.$executeRaw`
      INSERT INTO stock_ledger
        (id, occurred_at, variant_id, warehouse_id, condition, movement_type,
         direction, qty, qty_before, qty_after, reference_type, created_at)
      VALUES
        (${ledgerId}::uuid, now(), ${variantId}::uuid, ${warehouseId}::uuid, 'GOOD',
         'INITIAL_LOAD', 'IN', 20, 0, 20, 'IMPORT', now())
    `;
  });

  it('el rol de la aplicación PUEDE insertar en el kardex', async () => {
    const inserted = await app.$executeRaw`
      INSERT INTO stock_ledger
        (id, occurred_at, variant_id, warehouse_id, condition, movement_type,
         direction, qty, qty_before, qty_after, reference_type, created_at)
      VALUES
        (${id()}::uuid, now(), ${variantId}::uuid, ${warehouseId}::uuid, 'GOOD',
         'SALE', 'OUT', 1, 20, 19, 'SALE', now())
    `;
    expect(inserted).toBe(1);
  });

  it('el rol de la aplicación NO PUEDE modificar un asiento del kardex', async () => {
    await expect(
      app.$executeRaw`UPDATE stock_ledger SET qty = 999 WHERE id = ${ledgerId}::uuid`,
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });

  it('el rol de la aplicación NO PUEDE borrar un asiento del kardex', async () => {
    await expect(
      app.$executeRaw`DELETE FROM stock_ledger WHERE id = ${ledgerId}::uuid`,
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });

  it('el rol de la aplicación NO PUEDE modificar ni borrar la auditoría', async () => {
    const auditId = id();
    await app.$executeRaw`
      INSERT INTO audit_logs (id, occurred_at, action)
      VALUES (${auditId}::uuid, now(), 'test.action')
    `;

    await expect(
      app.$executeRaw`UPDATE audit_logs SET action = 'alterado' WHERE id = ${auditId}::uuid`,
    ).rejects.toThrow(/permission denied|permiso denegado/i);

    await expect(
      app.$executeRaw`DELETE FROM audit_logs WHERE id = ${auditId}::uuid`,
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });
});

describe('Unicidad entre registros no archivados', () => {
  it('no admite dos variantes activas con el mismo SKU', async () => {
    const sku = `DUP-${Date.now()}`;
    const product = await owner.product.create({
      data: { id: id(), name: 'Producto duplicado', hasVariants: false },
    });

    await owner.productVariant.create({
      data: { id: id(), productId: product.id, sku },
    });

    await expect(
      owner.productVariant.create({ data: { id: id(), productId: product.id, sku } }),
    ).rejects.toThrow(/uq_variant_sku_activo|unique constraint/i);
  });

  it('SÍ admite reusar el SKU de una variante archivada', async () => {
    const sku = `ARCH-${Date.now()}`;
    const product = await owner.product.create({
      data: { id: id(), name: 'Producto archivado', hasVariants: false },
    });

    const first = await owner.productVariant.create({
      data: { id: id(), productId: product.id, sku },
    });
    await owner.productVariant.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });

    // Un producto archivado no bloquea su SKU para siempre.
    const second = await owner.productVariant.create({
      data: { id: id(), productId: product.id, sku },
    });
    expect(second.sku).toBe(sku);
  });

  it('no admite dos códigos de barras iguales activos', async () => {
    const code = `750${Date.now()}`.slice(0, 13);
    await owner.barcode.create({ data: { id: id(), variantId, code, type: 'EAN13' } });

    await expect(
      owner.barcode.create({ data: { id: id(), variantId, code, type: 'EAN13' } }),
    ).rejects.toThrow(/uq_barcode_activo|unique constraint/i);
  });
});

describe('Búsqueda — normalización y trigram', () => {
  it('pv_normalizar quita acentos y pasa a minúsculas', async () => {
    const rows = await owner.$queryRaw<{ resultado: string }[]>`
      SELECT pv_normalizar('Faja POSTQUIRÚRGICA  Negro') AS resultado
    `;
    expect(rows[0]?.resultado).toBe('faja postquirurgica negro');
  });

  it('el trigger materializa search_text y search_document', async () => {
    const product = await owner.product.create({
      data: { id: id(), name: 'Faja búsqueda', hasVariants: false },
    });

    const variant = await owner.productVariant.create({
      data: {
        id: id(),
        productId: product.id,
        sku: `SRCH-${Date.now()}`,
        searchText: 'Faja Postquirúrgica Negro M',
      },
    });

    const rows = await owner.$queryRaw<{ search_text: string; tiene_doc: boolean }[]>`
      SELECT search_text, (search_document IS NOT NULL) AS tiene_doc
      FROM product_variants WHERE id = ${variant.id}::uuid
    `;

    expect(rows[0]?.search_text).toBe('faja postquirurgica negro m');
    expect(rows[0]?.tiene_doc).toBe(true);
  });

  it('la búsqueda difusa tolera errores de captura', async () => {
    // "postquirurjica" (con j) debe parecerse a "postquirurgica".
    const rows = await owner.$queryRaw<{ parecido: number }[]>`
      SELECT similarity('postquirurgica', 'postquirurjica') AS parecido
    `;
    expect(Number(rows[0]?.parecido)).toBeGreaterThan(0.5);
  });
});

describe('Idempotencia', () => {
  it('la misma clave en el mismo ámbito no se puede insertar dos veces', async () => {
    const key = `test-${Date.now()}`;

    await owner.idempotencyKey.create({
      data: {
        key,
        scope: 'sales',
        endpoint: 'POST /sales',
        requestHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    // Esta es la garantía: dos peticiones simultáneas, una gana el INSERT.
    await expect(
      owner.idempotencyKey.create({
        data: {
          key,
          scope: 'sales',
          endpoint: 'POST /sales',
          requestHash: 'b'.repeat(64),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    ).rejects.toThrow(/unique constraint|idempotency_keys_pkey/i);
  });
});

describe('Folios', () => {
  it('UPDATE … RETURNING entrega consecutivos sin huecos ni repeticiones', async () => {
    await owner.sequence.create({
      data: { id: id(), branchId, docType: 'SALE', prefix: 'T', nextValue: 1, padding: 6 },
    });

    const obtenidos: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const rows = await owner.$queryRaw<{ next_value: bigint }[]>`
        UPDATE sequences SET next_value = next_value + 1
        WHERE branch_id = ${branchId}::uuid AND doc_type = 'SALE'
        RETURNING next_value - 1 AS next_value
      `;
      obtenidos.push(rows[0]!.next_value);
    }

    expect(obtenidos.map(Number)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Bloqueo de fila — la base del control de concurrencia', () => {
  it('SELECT … FOR UPDATE serializa a dos transacciones sobre el mismo saldo', async () => {
    const product = await owner.product.create({
      data: { id: id(), name: 'Faja concurrencia', hasVariants: false },
    });
    const variant = await owner.productVariant.create({
      data: { id: id(), productId: product.id, sku: `LOCK-${Date.now()}` },
    });

    await owner.stockBalance.create({
      data: {
        variantId: variant.id,
        warehouseId,
        condition: 'GOOD',
        qtyOnHand: '1.000',
        avgCost: '400.0000',
      },
    });

    const orden: string[] = [];

    // Transacción A: bloquea y retiene el bloqueo un momento.
    const a = owner.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT qty_on_hand FROM stock_balances
        WHERE variant_id = ${variant.id}::uuid AND warehouse_id = ${warehouseId}::uuid
          AND condition = 'GOOD'
        FOR UPDATE
      `;
      orden.push('A obtiene el bloqueo');
      await new Promise((r) => setTimeout(r, 400));
      await tx.$executeRaw`
        UPDATE stock_balances SET qty_on_hand = 0
        WHERE variant_id = ${variant.id}::uuid AND warehouse_id = ${warehouseId}::uuid
          AND condition = 'GOOD'
      `;
      orden.push('A confirma');
    });

    // Transacción B: intenta el mismo saldo; debe ESPERAR.
    const b = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      orden.push('B intenta');
      await owner.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ qty_on_hand: unknown }[]>`
          SELECT qty_on_hand FROM stock_balances
          WHERE variant_id = ${variant.id}::uuid AND warehouse_id = ${warehouseId}::uuid
            AND condition = 'GOOD'
          FOR UPDATE
        `;
        orden.push('B obtiene el bloqueo');
        // B ve el valor DESPUÉS de A: no lee un valor obsoleto.
        expectDecimal(rows[0]?.qty_on_hand, '0.000');
      });
    })();

    await Promise.all([a, b]);

    expect(orden).toEqual([
      'A obtiene el bloqueo',
      'B intenta',
      'A confirma',
      'B obtiene el bloqueo',
    ]);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════════════

describe('PrismaService.client — regresión del proxy de Prisma', () => {
  it('fuera de transacción devuelve un cliente CON delegados de modelo', async () => {
    const { Test } = await import('@nestjs/testing');
    const { DatabaseModule } = await import('../../src/core/database/database.module');
    const { PrismaService } = await import('../../src/core/database/prisma.service');

    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    const prisma = moduleRef.get(PrismaService);
    await prisma.$connect();

    // El bug: `get client()` devolvía `this`, que es el objeto envuelto por el
    // Proxy de Prisma y NO tiene los delegados. La auditoría fuera de
    // transacción se perdía en silencio porque AuditService traga sus errores.
    const client = prisma.client as unknown as Record<string, unknown>;

    expect(prisma.inTransaction).toBe(false);
    expect(client.auditLog, 'client.auditLog debe existir').toBeDefined();
    expect(client.user, 'client.user debe existir').toBeDefined();
    expect(client.outboxEvent, 'client.outboxEvent debe existir').toBeDefined();

    // Y debe poder escribir de verdad, no solo existir.
    const auditId = id();
    await (client.auditLog as { create: (a: unknown) => Promise<unknown> }).create({
      data: { id: auditId, action: 'test.proxy_regresion' },
    });
    const guardado = await owner.auditLog.findUnique({ where: { id: auditId } });
    expect(guardado).toBeTruthy();

    await moduleRef.close();
  }, 60_000);

  it('dentro de transacción devuelve el cliente transaccional', async () => {
    const { Test } = await import('@nestjs/testing');
    const { DatabaseModule } = await import('../../src/core/database/database.module');
    const { PrismaService } = await import('../../src/core/database/prisma.service');

    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    const prisma = moduleRef.get(PrismaService);
    await prisma.$connect();

    let dentroEraTransaccional = false;

    await prisma.transaction(async (tx) => {
      dentroEraTransaccional = prisma.client === tx && prisma.inTransaction;
    });

    expect(dentroEraTransaccional).toBe(true);
    // Al salir, vuelve al cliente normal.
    expect(prisma.inTransaction).toBe(false);

    await moduleRef.close();
  }, 60_000);
});
