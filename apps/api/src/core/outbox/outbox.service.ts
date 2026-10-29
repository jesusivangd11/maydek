import { Injectable, Logger } from '@nestjs/common';
import type { EventType } from '@pv/shared-types';
import { PrismaService } from '../database/prisma.service';
import { newId } from '../ids';
import { getRequestContext } from '../request-context/request-context';

export interface PublishEventInput {
  eventType: EventType | string;
  aggregateType: string;
  aggregateId?: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Patrón *transactional outbox*.
 *
 * El evento se escribe en la MISMA transacción que el dato que lo origina.
 * De ahí salen dos garantías que ningún esquema de "publicar después" puede dar:
 *
 *   · Es imposible que exista una venta sin su evento.
 *   · Es imposible que se dispare un webhook de una venta que hizo rollback.
 *
 * El relay (OutboxRelay) los entrega después del commit, con reintentos.
 * El `id` del evento ES la clave de idempotencia del consumidor: viaja en la
 * cabecera `X-Event-Id` y permite deduplicar en el otro extremo.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async publish(input: PublishEventInput): Promise<string> {
    const ctx = getRequestContext();
    const id = newId();

    if (!this.prisma.inTransaction) {
      // No es fatal, pero sí una señal de diseño: un evento publicado fuera de
      // transacción puede describir algo que después se revierte.
      this.logger.warn(
        { eventType: input.eventType, requestId: ctx?.requestId },
        'Evento publicado FUERA de transacción: se pierde la garantía del outbox',
      );
    }

    await this.prisma.client.outboxEvent.create({
      data: {
        id,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId ?? null,
        payload: input.payload as never,
        metadata: {
          ...(input.metadata ?? {}),
          requestId: ctx?.requestId,
          userId: ctx?.principal?.kind === 'user' ? ctx.principal.id : undefined,
          apiClientId: ctx?.principal?.kind === 'api_client' ? ctx.principal.id : undefined,
          channelId: ctx?.channelId,
          branchId: ctx?.branchId,
        } as never,
      },
    });

    return id;
  }

  /** Publica varios eventos de una vez, en la transacción activa. */
  async publishMany(events: PublishEventInput[]): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) {
      ids.push(await this.publish(event));
    }
    return ids;
  }
}
