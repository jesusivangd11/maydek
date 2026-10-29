import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { CryptoService } from './crypto/crypto.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { OutboxRelay } from './outbox/outbox.relay';
import { OutboxService } from './outbox/outbox.service';
import { SequenceService } from './sequences/sequence.service';
import { TimeZoneService } from './time/timezone.service';

/**
 * Núcleo transversal.
 *
 * Global a propósito: estos servicios los necesita cada módulo de negocio y
 * declararlos en cada uno solo genera ruido. Son infraestructura, no dominio.
 */
@Global()
@Module({
  providers: [
    AuditService,
    CryptoService,
    IdempotencyService,
    OutboxService,
    OutboxRelay,
    SequenceService,
    TimeZoneService,
  ],
  exports: [
    AuditService,
    CryptoService,
    IdempotencyService,
    OutboxService,
    OutboxRelay,
    SequenceService,
    TimeZoneService,
  ],
})
export class CoreModule {}
