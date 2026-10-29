import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../core/database/prisma.service';
import { OutboxRelay } from '../../core/outbox/outbox.relay';
import { Public } from '../auth/decorators/permissions.decorator';

@ApiTags('Salud')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRelay,
  ) {}

  /** ¿El proceso vive? Lo consulta el orquestador. */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Comprobación de vida' })
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** ¿Puede atender tráfico? Verifica las dependencias reales. */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Comprobación de disponibilidad (base de datos, colas)' })
  async ready() {
    const database = await this.prisma.ping();
    const pendingEvents = database ? await this.outbox.pendingCount().catch(() => -1) : -1;

    return {
      status: database ? 'ok' : 'degraded',
      checks: {
        database: database ? 'ok' : 'error',
        // Un outbox creciendo sin freno significa que los eventos no salen:
        // se vigila desde aquí y se alerta a partir de 100 (docs/08-operacion.md).
        outboxPending: pendingEvents,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
