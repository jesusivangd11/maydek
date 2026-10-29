import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} from '../errors/domain-errors';

export interface IdempotencyLookup {
  key: string;
  scope: string;
  endpoint: string;
  requestBody: unknown;
  apiClientId?: string;
  userId?: string;
  ttlHours?: number;
}

export interface StoredResponse {
  status: number;
  body: unknown;
  resourceId?: string;
}

/**
 * Idempotencia (requisito 27).
 *
 * Escenario que resuelve: la web envía un pedido, el servidor lo procesa bien,
 * pero la respuesta se pierde por un timeout de red. La web reintenta. Sin esto
 * se registran DOS ventas y se descuenta el doble de inventario.
 *
 * La clave se inserta con restricción UNIQUE dentro de la transacción de la
 * operación. Si dos peticiones idénticas llegan al mismo milisegundo, una gana
 * el INSERT y la otra recibe 409 con Retry-After. No hay ventana de carrera.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private static readonly DEFAULT_TTL_HOURS = 24;

  constructor(private readonly prisma: PrismaService) {}

  /** Hash del cuerpo, para detectar la misma clave con contenido distinto. */
  hashRequest(body: unknown): string {
    return createHash('sha256').update(this.stableStringify(body)).digest('hex');
  }

  /**
   * Reclama la clave.
   *
   *   · No existe            → la reserva y devuelve null: hay que procesar.
   *   · Existe, COMPLETED    → devuelve la respuesta guardada, mismo cuerpo.
   *   · Existe, cuerpo ≠     → 422 IDEMPOTENCY_CONFLICT.
   *   · Existe, IN_PROGRESS  → 409 IDEMPOTENCY_IN_PROGRESS con Retry-After.
   */
  async claim(input: IdempotencyLookup): Promise<StoredResponse | null> {
    const requestHash = this.hashRequest(input.requestBody);
    const expiresAt = new Date(
      Date.now() + (input.ttlHours ?? IdempotencyService.DEFAULT_TTL_HOURS) * 3_600_000,
    );

    try {
      await this.prisma.client.idempotencyKey.create({
        data: {
          key: input.key,
          scope: input.scope,
          endpoint: input.endpoint,
          requestHash,
          apiClientId: input.apiClientId ?? null,
          userId: input.userId ?? null,
          expiresAt,
        },
      });
      return null; // clave nueva: adelante
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
    }

    // La clave ya existía: hay que decidir qué devolver.
    const existing = await this.prisma.client.idempotencyKey.findUnique({
      where: { scope_key: { scope: input.scope, key: input.key } },
    });

    if (!existing) {
      // Carrera con la limpieza de expiradas: se reintenta una vez.
      return this.claim(input);
    }

    if (existing.requestHash !== requestHash) {
      this.logger.warn(
        { key: input.key, scope: input.scope, endpoint: input.endpoint },
        'Misma clave de idempotencia con cuerpo distinto',
      );
      throw new IdempotencyConflictError();
    }

    if (existing.status === 'IN_PROGRESS') {
      throw new IdempotencyInProgressError(2);
    }

    if (existing.status === 'FAILED') {
      // Un intento fallido no debe bloquear para siempre: se libera y se
      // permite reintentar el mismo pedido.
      await this.prisma.client.idempotencyKey.update({
        where: { scope_key: { scope: input.scope, key: input.key } },
        data: { status: 'IN_PROGRESS', responseStatus: null, responseBody: Prisma.DbNull },
      });
      return null;
    }

    return {
      status: existing.responseStatus ?? 200,
      body: existing.responseBody,
      resourceId: existing.resourceId ?? undefined,
    };
  }

  /** Guarda el resultado. Se llama DENTRO de la transacción de la operación. */
  async complete(
    scope: string,
    key: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.prisma.client.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: {
        status: 'COMPLETED',
        responseStatus: response.status,
        responseBody: (response.body ?? Prisma.DbNull) as never,
        resourceId: response.resourceId ?? null,
        completedAt: new Date(),
      },
    });
  }

  /** Marca el intento como fallido para que el cliente pueda reintentar. */
  async fail(scope: string, key: string): Promise<void> {
    try {
      await this.prisma.idempotencyKey.update({
        where: { scope_key: { scope, key } },
        data: { status: 'FAILED', completedAt: new Date() },
      });
    } catch {
      // Si la transacción ya revirtió el INSERT de la clave, no hay nada que marcar.
    }
  }

  /** Limpieza de claves vencidas. La invoca un job diario. */
  async purgeExpired(): Promise<number> {
    const result = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (result.count > 0) {
      this.logger.log(`Se purgaron ${result.count} claves de idempotencia vencidas`);
    }
    return result.count;
  }

  /**
   * Serialización estable: el orden de las llaves de un JSON no debe cambiar
   * el hash. `{a:1,b:2}` y `{b:2,a:1}` son la misma petición.
   */
  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((v) => this.stableStringify(v)).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${this.stableStringify(v)}`);

    return `{${entries.join(',')}}`;
  }
}
