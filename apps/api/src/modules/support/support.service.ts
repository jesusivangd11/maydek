import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { NotFoundError, ValidationError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import type { CreateTicketDto, UpdateTicketDto } from './support.controller';

/**
 * SOPORTE.
 *
 * La página web pública abre tickets sin sesión; el equipo los atiende desde el
 * panel. El cliente consulta el estado con folio + correo: el folio solo no
 * basta, para que nadie pueda leer tickets ajenos probando folios.
 */

// Sin 0/O ni 1/I: el folio se dicta por teléfono.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeFolio(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `SOP-${code}`;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateTicketDto, ip: string) {
    // Un bot que llenó el campo trampa recibe una respuesta normal y no se guarda nada.
    if (dto.website) return { folio: makeFolio(), status: 'OPEN' };

    for (let attempt = 0; attempt < 5; attempt++) {
      const folio = makeFolio();
      try {
        await this.prisma.client.supportTicket.create({
          data: {
            id: newId(),
            folio,
            kind: dto.kind,
            name: dto.name.trim(),
            email: dto.email.trim().toLowerCase(),
            phone: dto.phone?.trim() || null,
            company: dto.company?.trim() || null,
            plan: dto.plan?.trim() || null,
            subject: dto.subject.trim(),
            message: dto.message.trim(),
            priority: dto.kind === 'SALES' ? 'HIGH' : 'NORMAL',
            ipAddress: ip?.slice(0, 64) ?? null,
          },
        });
        return { folio, status: 'OPEN' };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
    throw new ValidationError('No se pudo registrar la solicitud; intenta de nuevo');
  }

  async track(folio: string, email: string) {
    const ticket = await this.prisma.client.supportTicket.findFirst({
      where: { folio: folio.trim().toUpperCase(), email: email.trim().toLowerCase() },
      select: {
        folio: true,
        subject: true,
        status: true,
        answer: true,
        answeredAt: true,
        createdAt: true,
      },
    });
    if (!ticket) throw new NotFoundError('un ticket con ese folio y correo');
    return ticket;
  }

  async list(status?: string) {
    const rows = await this.prisma.client.supportTicket.findMany({
      where: status ? { status } : {},
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    });
    return rows.map(({ ipAddress: _ip, ...row }) => row);
  }

  async update(id: string, dto: UpdateTicketDto, actor: AuthenticatedUser) {
    const ticket = await this.prisma.client.supportTicket.findUnique({
      where: { id },
      select: { id: true, folio: true, status: true },
    });
    if (!ticket) throw new NotFoundError('el ticket', id);

    const answering = dto.answer !== undefined && dto.answer.trim().length > 0;
    const updated = await this.prisma.client.supportTicket.update({
      where: { id },
      data: {
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(answering
          ? {
              answer: dto.answer!.trim(),
              answeredById: actor.id,
              answeredAt: new Date(),
              status: dto.status ?? 'ANSWERED',
            }
          : dto.status
            ? { status: dto.status }
            : {}),
      },
    });

    await this.audit.record({
      action: 'support.ticket.update',
      entityType: 'SupportTicket',
      entityId: id,
      entityLabel: ticket.folio,
      userId: actor.id,
      before: { status: ticket.status },
      after: { status: updated.status },
    });

    const { ipAddress: _ip, ...row } = updated;
    return row;
  }
}
