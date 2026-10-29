import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { env } from '../../config/env';

/**
 * Relay del outbox.
 *
 * Lee los eventos no publicados y los entrega a sus destinos. En la Fase 1 el
 * único destino es el log: los webhooks llegan en la Fase 10, cuando exista
 * BullMQ y Redis. Lo que ya funciona desde ahora es la mecánica —marcado
 * transaccional, reintentos, bloqueo entre instancias— para que la Fase 10 solo
 * tenga que enchufar el despachador.
 *
 * Barrido periódico. En la Fase 10 se le añade LISTEN/NOTIFY para bajar la
 * latencia, dejando el barrido como red de seguridad.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    const config = env();
    if (!config.OUTBOX_ENABLED) {
      this.logger.log('Relay del outbox desactivado por configuración');
      return;
    }
    this.timer = setInterval(() => {
      void this.drain();
    }, config.OUTBOX_POLL_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Relay del outbox activo (cada ${config.OUTBOX_POLL_INTERVAL_MS} ms)`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Procesa un lote. Público para poder invocarlo en las pruebas. */
  async drain(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;

    try {
      const batchSize = env().OUTBOX_BATCH_SIZE;

      // SKIP LOCKED permite que varias instancias del API compartan la cola sin
      // procesar el mismo evento dos veces ni bloquearse entre sí.
      const pending = await this.prisma.$queryRaw<
        { id: string; event_type: string; aggregate_type: string; aggregate_id: string | null }[]
      >`
        SELECT id, event_type, aggregate_type, aggregate_id
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY occurred_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (pending.length === 0) return 0;

      for (const event of pending) {
        try {
          await this.dispatch(event);
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: { publishedAt: new Date(), lastError: null },
          });
        } catch (error) {
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              attempts: { increment: 1 },
              lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
            },
          });
          this.logger.warn(
            { eventId: event.id, eventType: event.event_type, err: error },
            'No se pudo entregar el evento; se reintentará',
          );
        }
      }

      return pending.length;
    } catch (error) {
      this.logger.error({ err: error }, 'Fallo en el barrido del outbox');
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Punto de extensión de la Fase 10.
   *
   * Aquí entrará: buscar los endpoints suscritos al tipo de evento, crear
   * `webhook_deliveries` y encolarlas en BullMQ con reintentos exponenciales.
   */
  private async dispatch(event: {
    id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string | null;
  }): Promise<void> {
    this.logger.debug(
      { eventId: event.id, aggregateId: event.aggregate_id },
      `Evento ${event.event_type} (${event.aggregate_type})`,
    );
  }

  /** Cuántos eventos quedan sin publicar. Alimenta /health/ready y las alertas. */
  async pendingCount(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { publishedAt: null } });
  }
}
