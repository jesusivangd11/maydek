import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { REDACTED_FIELDS, type AuditAction } from '@pv/shared-types';
import { PrismaService } from '../database/prisma.service';
import { newId } from '../ids';
import { getRequestContext } from '../request-context/request-context';

export interface AuditRecordInput {
  action: AuditAction | string;
  entityType?: string;
  entityId?: string;
  /** Etiqueta legible: "Faja Postquirúrgica X - Negro / M (FJ-0012-NEG-M)". */
  entityLabel?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Diff ya calculado. Si viene, se ignoran `before`/`after`. */
  changes?: Record<string, { before: unknown; after: unknown }>;
  reason?: string;
  authorizedByUserId?: string;
  userId?: string;
  branchId?: string;
}

/**
 * Auditoría.
 *
 * Se escribe DENTRO de la transacción del documento (usa `prisma.client`, que
 * devuelve el cliente transaccional activo). Si la venta hace rollback, su
 * registro de auditoría también: no quedan rastros de operaciones que nunca
 * ocurrieron.
 *
 * La tabla es append-only por permisos de PostgreSQL — el rol de la aplicación
 * no tiene UPDATE ni DELETE. Un registro de auditoría editable no sirve para
 * auditar nada.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    const ctx = getRequestContext();
    const principal = ctx?.principal;

    const userId =
      input.userId ?? (principal?.kind === 'user' ? principal.id : undefined) ?? null;
    const apiClientId = principal?.kind === 'api_client' ? principal.id : null;

    const changes = input.changes ?? this.diff(input.before, input.after);

    try {
      await this.prisma.client.auditLog.create({
        data: {
          id: newId(),
          action: input.action,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          entityLabel: input.entityLabel ?? null,
          changes:
            changes && Object.keys(changes).length > 0
              ? (changes as Prisma.InputJsonValue)
              : undefined,
          reason: input.reason ?? null,
          authorizedByUserId:
            input.authorizedByUserId ?? ctx?.authorizedByUserId ?? null,
          userId,
          apiClientId,
          ipAddress: ctx?.ipAddress ?? null,
          userAgent: ctx?.userAgent?.slice(0, 512) ?? null,
          requestId: ctx?.requestId ?? null,
          channelId: ctx?.channelId ?? null,
          branchId: input.branchId ?? ctx?.branchId ?? null,
        },
      });
    } catch (error) {
      // Un fallo al auditar NO debe tumbar la operación de negocio, pero sí
      // debe gritar: significa que hay operaciones sin rastro.
      this.logger.error(
        { err: error, action: input.action, requestId: ctx?.requestId },
        'No se pudo registrar la auditoría',
      );
    }
  }

  /**
   * Diff campo a campo entre dos estados.
   *
   * Solo incluye lo que realmente cambió: un registro con 40 campos iguales y
   * uno distinto es ilegible, y lo que se necesita al investigar es
   * exactamente el campo que se movió.
   */
  diff(
    before?: Record<string, unknown> | null,
    after?: Record<string, unknown> | null,
  ): Record<string, { before: unknown; after: unknown }> | undefined {
    if (!before && !after) return undefined;

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);

    for (const key of keys) {
      if (this.isRedacted(key)) continue;

      const prev = this.normalize(before?.[key]);
      const next = this.normalize(after?.[key]);

      if (prev !== next) {
        changes[key] = { before: prev, after: next };
      }
    }

    return Object.keys(changes).length > 0 ? changes : undefined;
  }

  /** Contraseñas, PIN, tokens y secretos jamás entran a la auditoría. */
  private isRedacted(field: string): boolean {
    const lower = field.toLowerCase();
    return REDACTED_FIELDS.some((r) => lower === r.toLowerCase() || lower.includes(r.toLowerCase()));
  }

  /**
   * Normaliza a un valor comparable y serializable.
   * Decimal y Date se convierten a string para que `430.6100` y `430.61` no
   * aparezcan como un cambio cuando son el mismo importe.
   */
  private normalize(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const maybeDecimal = value as { toFixed?: (n?: number) => string; toString(): string };
      if (typeof maybeDecimal.toFixed === 'function') {
        // Prisma.Decimal: se compara con escala fija.
        return Number(maybeDecimal.toString()).toString();
      }
      return JSON.stringify(value);
    }
    return value;
  }
}
