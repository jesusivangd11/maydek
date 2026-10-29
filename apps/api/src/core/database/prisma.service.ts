import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { LockTimeoutError } from '../errors/domain-errors';

/** Cliente dentro de una transacción: no expone $transaction ni $connect. */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Contexto transaccional ambiental.
 *
 * Permite que servicios anidados (auditoría, outbox, folios) se unan a la
 * transacción en curso sin tener que pasarse el cliente de mano en mano por
 * toda la pila de llamadas. Si un servicio se invoca fuera de transacción,
 * recibe el cliente normal.
 */
const transactionStorage = new AsyncLocalStorage<TransactionClient>();

export interface TransactionOptions {
  /**
   * READ COMMITTED es el nivel por defecto y es suficiente: la corrección la
   * garantiza el bloqueo explícito de fila (SELECT … FOR UPDATE), no el nivel
   * de aislamiento. Ver docs/07-concurrencia.md.
   */
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Espera máxima para ABRIR la transacción. */
  maxWait?: number;
  /** Duración máxima de la transacción. Corta a propósito: la caja no espera. */
  timeout?: number;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Referencia al PROXY que devuelve el constructor de PrismaClient.
   *
   * Prisma 6 no devuelve la instancia: devuelve un Proxy que resuelve los
   * delegados de modelo (`auditLog`, `user`, …) al vuelo. Dentro de un método o
   * getter, `this` es el objeto envuelto —que NO tiene esos delegados—, no el
   * proxy. Devolver `this` desde `get client()` producía un cliente sin
   * modelos, y como AuditService traga sus errores, los registros de auditoría
   * fuera de transacción se perdían EN SILENCIO.
   *
   * Lo detectaron las pruebas E2E contra el API real; ninguna prueba unitaria
   * con dobles lo habría visto.
   *
   * Lo inyecta `DatabaseModule` mediante fábrica, que es el único lugar donde
   * se tiene el proxy a la mano.
   */
  private self?: TransactionClient;

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Conexión con PostgreSQL establecida');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Cliente a usar AHORA: el transaccional si hay uno activo, o el normal.
   *
   * Todo repositorio debe leer y escribir a través de este método. Es lo que
   * hace que `AuditService` y `OutboxService` queden dentro de la misma
   * transacción que la venta, sin acoplar sus firmas.
   */
  get client(): TransactionClient {
    return transactionStorage.getStore() ?? this.self ?? this;
  }

  /**
   * Registra el proxy. Lo llama `DatabaseModule` justo después de construir el
   * servicio, que es cuando `instance` sí es el proxy con los delegados.
   */
  registerSelf(instance: TransactionClient): void {
    this.self = instance;
  }

  /** ¿Estamos dentro de una transacción? */
  get inTransaction(): boolean {
    return transactionStorage.getStore() !== undefined;
  }

  /**
   * Ejecuta `fn` dentro de una transacción.
   *
   * Si ya hay una transacción activa, se une a ella en vez de anidar: las
   * transacciones anidadas en PostgreSQL requieren savepoints y complican el
   * rollback sin darnos nada aquí. Una operación de negocio = una transacción.
   */
  async transaction<T>(
    fn: (tx: TransactionClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const existing = transactionStorage.getStore();
    if (existing) return fn(existing);

    try {
      return await this.$transaction(
        async (tx) => transactionStorage.run(tx, () => fn(tx)),
        {
          isolationLevel:
            options.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: options.maxWait ?? 5_000,
          timeout: options.timeout ?? 15_000,
        },
      );
    } catch (error) {
      throw this.translateLockError(error);
    }
  }

  /**
   * `lock_timeout` de PostgreSQL llega como un error crudo. Se traduce a un
   * error de dominio para que el cajero vea "vuelve a intentar" en vez de un
   * 500 sin explicación.
   */
  private translateLockError(error: unknown): unknown {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (
      message.includes('lock timeout') ||
      message.includes('canceling statement due to lock timeout') ||
      message.includes('deadlock detected')
    ) {
      return new LockTimeoutError();
    }
    return error;
  }

  /**
   * Bloquea filas de saldo con SELECT … FOR UPDATE.
   *
   * ORDEN DETERMINISTA, siempre. Sin el ORDER BY, dos transacciones que tocan
   * los mismos dos productos en orden inverso se bloquean mutuamente para
   * siempre. Esta única cláusula elimina la causa clásica del deadlock.
   *
   * Se deja aquí, en el núcleo, para que el módulo de inventario de la Fase 3
   * lo use sin volver a escribir el SQL de bloqueo.
   */
  async lockStockBalances(
    tx: TransactionClient,
    keys: { variantId: string; warehouseId: string; condition?: string }[],
  ): Promise<
    {
      variant_id: string;
      warehouse_id: string;
      condition: string;
      qty_on_hand: Prisma.Decimal;
      qty_reserved: Prisma.Decimal;
      qty_available: Prisma.Decimal;
      avg_cost: Prisma.Decimal;
    }[]
  > {
    if (keys.length === 0) return [];

    const tuples = Prisma.join(
      keys.map((k) =>
        Prisma.sql`(${k.variantId}::uuid, ${k.warehouseId}::uuid, ${k.condition ?? 'GOOD'}::"StockCondition")`,
      ),
    );

    return tx.$queryRaw`
      SELECT variant_id, warehouse_id, condition,
             qty_on_hand, qty_reserved, qty_available, avg_cost
      FROM stock_balances
      WHERE (variant_id, warehouse_id, condition) IN (${tuples})
      ORDER BY variant_id, warehouse_id, condition
      FOR UPDATE
    `;
  }

  /** Comprobación de vida para /health/ready. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
