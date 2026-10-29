import { Injectable } from '@nestjs/common';
import { DOC_SERIES, formatFolio, type DocType } from '@pv/domain-rules';
import { PrismaService } from '../database/prisma.service';
import { newId } from '../ids';

/**
 * Folios legibles por sucursal y tipo de documento: `A-001-000123`.
 *
 * Se reserva con `UPDATE … RETURNING`, que es atómico y bloquea la fila de la
 * secuencia solo el instante que dura la transacción. Ventaja sobre una
 * secuencia nativa de PostgreSQL: si la transacción del documento hace
 * rollback, el folio se devuelve — no quedan huecos en la numeración.
 *
 * Un hueco en los folios de venta es una pregunta incómoda en una auditoría,
 * así que preferimos el bloqueo breve a la numeración con saltos.
 */
@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Siguiente folio del tipo indicado.
   *
   * DEBE invocarse dentro de la transacción del documento: así el folio y el
   * documento nacen o fallan juntos.
   */
  async next(docType: DocType, branchId?: string | null): Promise<string> {
    const tx = this.prisma.client;

    const rows = await tx.$queryRaw<{ next_value: bigint; prefix: string; padding: number }[]>`
      UPDATE sequences
      SET next_value = next_value + 1,
          updated_at = now()
      WHERE doc_type = ${docType}
        AND branch_id IS NOT DISTINCT FROM ${branchId ?? null}::uuid
      RETURNING next_value - 1 AS next_value, prefix, padding
    `;

    const row = rows[0];
    if (row) {
      return formatFolio({
        branchCode: row.prefix || null,
        series: DOC_SERIES[docType],
        value: row.next_value,
        padding: row.padding,
      });
    }

    // No existe la secuencia todavía: se crea y se reintenta.
    // Puede ocurrir al dar de alta una sucursal nueva.
    await this.ensure(docType, branchId ?? null);
    return this.next(docType, branchId);
  }

  /**
   * Crea la secuencia si falta. Idempotente: dos procesos que la creen a la vez
   * no chocan gracias al índice único (branch_id, doc_type).
   */
  async ensure(docType: DocType, branchId: string | null, prefix = ''): Promise<void> {
    const tx = this.prisma.client;
    let branchPrefix = prefix;

    if (!branchPrefix && branchId) {
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { code: true },
      });
      branchPrefix = branch?.code ?? '';
    }

    await tx.$executeRaw`
      INSERT INTO sequences (id, branch_id, doc_type, prefix, next_value, padding, created_at, updated_at)
      VALUES (${newId()}::uuid, ${branchId}::uuid, ${docType}, ${branchPrefix}, 1, 6, now(), now())
      ON CONFLICT (branch_id, doc_type) DO NOTHING
    `;
  }

  /** Consulta el siguiente folio SIN consumirlo. Para previsualizar en la interfaz. */
  async peek(docType: DocType, branchId?: string | null): Promise<string | null> {
    const sequence = await this.prisma.client.sequence.findFirst({
      where: { docType, branchId: branchId ?? null },
      select: { nextValue: true, prefix: true, padding: true },
    });

    if (!sequence) return null;

    return formatFolio({
      branchCode: sequence.prefix || null,
      series: DOC_SERIES[docType],
      value: sequence.nextValue,
      padding: sequence.padding,
    });
  }
}
