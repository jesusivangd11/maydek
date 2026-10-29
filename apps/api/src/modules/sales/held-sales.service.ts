import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '@pv/shared-types';
import { PrismaService } from '../../core/database/prisma.service';
import { ForbiddenError, NotFoundError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { PosContextService } from '../pos-context/pos-context.service';

/**
 * VENTAS EN ESPERA.
 *
 * El cliente se fue a buscar otra talla y en la fila hay tres personas: el
 * ticket se aparta y la caja sigue. NO reserva inventario —un ticket olvidado
 * no debe congelar mercancía— y vence solo a las 24 horas.
 *
 * Se guarda el carrito tal como lo arma el POS. Al recuperarlo, los precios y
 * la existencia se vuelven a consultar: lo apartado no congela el precio.
 */

const TTL_HOURS = 24;

@Injectable()
export class HeldSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
  ) {}

  async hold(dto: { label?: string; cart: Record<string, unknown> }, actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);
    const id = newId();

    await this.prisma.client.heldSale.create({
      data: {
        id,
        branchId: ctx.branchId,
        terminalId: ctx.terminalId,
        userId: actor.id,
        label: dto.label?.trim() || null,
        cart: dto.cart as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + TTL_HOURS * 3600 * 1000),
      },
    });

    return this.findOne(id, actor);
  }

  async list(actor: AuthenticatedUser) {
    const ctx = await this.posContext.resolve(actor);

    // Los vencidos se limpian al consultar: no hace falta un proceso aparte.
    await this.prisma.client.heldSale.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    const rows = await this.prisma.client.heldSale.findMany({
      where: { branchId: ctx.branchId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const users = await this.prisma.client.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      cart: row.cart,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      user: { id: row.userId, name: nameOf.get(row.userId) ?? '—' },
    }));
  }

  async findOne(id: string, actor: AuthenticatedUser) {
    const row = await this.prisma.client.heldSale.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('el ticket en espera', id);
    if (actor.branchIds.length > 0 && !actor.branchIds.includes(row.branchId)) {
      throw new ForbiddenError('Ese ticket es de otra sucursal');
    }
    return {
      id: row.id,
      label: row.label,
      cart: row.cart,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  /** Recuperar = leerlo y borrarlo. Un ticket recuperado no puede cobrarse dos veces. */
  async resume(id: string, actor: AuthenticatedUser) {
    const held = await this.findOne(id, actor);
    await this.prisma.client.heldSale.delete({ where: { id } });
    return held;
  }

  async discard(id: string, actor: AuthenticatedUser) {
    await this.findOne(id, actor);
    await this.prisma.client.heldSale.delete({ where: { id } });
  }
}
