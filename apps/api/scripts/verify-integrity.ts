import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * Verificación de integridad del inventario.
 *
 * Reconstruye TODOS los saldos desde el libro de movimientos y los compara con
 * `stock_balances`. En operación normal debe reportar CERO discrepancias.
 *
 * Si alguna vez reporta una, la premisa central del sistema se rompió: hay que
 * detener la operación e investigar. Por eso está en el nivel máximo de alerta
 * (docs/08-operacion.md).
 *
 * Se ejecuta a diario y bajo demanda:  pnpm db:verify
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const NODE_ENV = process.env.NODE_ENV ?? 'development';
for (const file of [`.env.${NODE_ENV}.local`, `.env.${NODE_ENV}`, '.env']) {
  loadEnv({ path: path.join(ROOT, file), override: false, quiet: true });
}

const prisma = new PrismaClient();

interface Discrepancy {
  variant_id: string;
  warehouse_id: string;
  condition: string;
  sku: string | null;
  balance_qty: string;
  ledger_qty: string;
  difference: string;
}

async function main(): Promise<void> {
  console.log('\nVerificando integridad del inventario…\n');

  const discrepancies = await prisma.$queryRaw<Discrepancy[]>`
    WITH ledger_totals AS (
      SELECT
        variant_id,
        warehouse_id,
        condition,
        SUM(CASE WHEN direction = 'IN' THEN qty ELSE -qty END) AS ledger_qty
      FROM stock_ledger
      GROUP BY variant_id, warehouse_id, condition
    )
    SELECT
      COALESCE(b.variant_id, l.variant_id)     AS variant_id,
      COALESCE(b.warehouse_id, l.warehouse_id) AS warehouse_id,
      COALESCE(b.condition, l.condition)::text AS condition,
      v.sku,
      COALESCE(b.qty_on_hand, 0)::text         AS balance_qty,
      COALESCE(l.ledger_qty, 0)::text          AS ledger_qty,
      (COALESCE(b.qty_on_hand, 0) - COALESCE(l.ledger_qty, 0))::text AS difference
    FROM stock_balances b
    FULL OUTER JOIN ledger_totals l
      ON  b.variant_id   = l.variant_id
      AND b.warehouse_id = l.warehouse_id
      AND b.condition    = l.condition
    LEFT JOIN product_variants v
      ON v.id = COALESCE(b.variant_id, l.variant_id)
    WHERE COALESCE(b.qty_on_hand, 0) <> COALESCE(l.ledger_qty, 0)
    ORDER BY v.sku
  `;

  const balanceRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM stock_balances
  `;
  const ledgerRows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM stock_ledger
  `;
  const balanceCount = balanceRows[0]?.count ?? 0n;
  const ledgerCount = ledgerRows[0]?.count ?? 0n;

  console.log(`  Saldos revisados     : ${balanceCount}`);
  console.log(`  Asientos en el kardex: ${ledgerCount}`);
  console.log(`  Discrepancias        : ${discrepancies.length}\n`);

  if (discrepancies.length === 0) {
    console.log('✓ El inventario cuadra: cada saldo coincide con su historial.\n');
    return;
  }

  console.error('✗ DISCREPANCIAS DETECTADAS — detén la operación e investiga:\n');
  for (const d of discrepancies) {
    console.error(
      `  ${(d.sku ?? d.variant_id).padEnd(24)} ` +
        `saldo=${d.balance_qty.padStart(10)}  ` +
        `kardex=${d.ledger_qty.padStart(10)}  ` +
        `diferencia=${d.difference}`,
    );
  }
  console.error('');
  process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('\n✗ La verificación falló:\n', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
