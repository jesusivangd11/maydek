import { Injectable } from '@nestjs/common';
import { CashSessionStatus } from '@prisma/client';
import type { AuthenticatedUser } from '@pv/shared-types';
import { PrismaService } from '../../core/database/prisma.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/domain-errors';

/**
 * Contexto operativo de una petición del punto de venta.
 *
 * Resuelve el "dónde" de la operación: qué sucursal, qué caja, qué almacén
 * descuenta y qué lista de precios aplica. Lo comparten ventas, caja y
 * devoluciones, que necesitan exactamente los mismos datos.
 *
 * NADA de esto se acepta del cliente sin verificar. Que el POS mande un
 * `branchId` no significa que el cajero tenga acceso a esa sucursal: se
 * comprueba contra las sucursales asignadas al usuario.
 */

export interface PosContext {
  branchId: string;
  branchCode: string;
  warehouseId: string;
  terminalId: string | null;
  channelId: string;
  priceListId: string | null;
  timezone: string;
}

@Injectable()
export class PosContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Contexto para operar. `branchId` y `terminalId` son opcionales: si no
   * llegan, se toma la única sucursal del usuario y la terminal de su sesión.
   */
  async resolve(
    actor: AuthenticatedUser,
    hints: { branchId?: string | null; terminalId?: string | null; channelCode?: string } = {},
  ): Promise<PosContext> {
    const branchId = await this.resolveBranch(actor, hints.branchId);

    const branch = await this.prisma.client.branch.findFirst({
      where: { id: branchId, isActive: true, deletedAt: null },
      select: { id: true, code: true, timezone: true, company: { select: { timezone: true } } },
    });
    if (!branch) throw new NotFoundError('la sucursal', branchId);

    const channelCode = hints.channelCode ?? 'POS';
    const channel = await this.prisma.client.channel.findUnique({
      where: { code: channelCode },
      select: {
        id: true,
        isActive: true,
        defaultPriceListId: true,
        defaultWarehouseId: true,
      },
    });
    if (!channel || !channel.isActive) {
      throw new NotFoundError(`el canal ${channelCode}`);
    }

    const warehouseId = await this.resolveWarehouse(branchId, channel.defaultWarehouseId);
    const terminalId = await this.resolveTerminal(branchId, hints.terminalId ?? actor.terminalId);

    return {
      branchId: branch.id,
      branchCode: branch.code,
      warehouseId,
      terminalId,
      channelId: channel.id,
      priceListId: channel.defaultPriceListId,
      // La sucursal puede sobrescribir la zona horaria de la empresa.
      timezone: branch.timezone ?? branch.company.timezone,
    };
  }

  /** Sesión de caja ABIERTA de una terminal, si la hay. */
  async findOpenCashSession(terminalId: string) {
    return this.prisma.client.cashSession.findFirst({
      where: { terminalId, status: CashSessionStatus.OPEN },
      select: {
        id: true,
        folio: true,
        openedAt: true,
        openingFloat: true,
        openedById: true,
        openedBy: { select: { name: true } },
      },
    });
  }

  private async resolveBranch(
    actor: AuthenticatedUser,
    requested?: string | null,
  ): Promise<string> {
    if (requested) {
      // Un usuario sin sucursales asignadas es multi-sucursal (administrador).
      if (actor.branchIds.length > 0 && !actor.branchIds.includes(requested)) {
        throw new ForbiddenError('No tienes acceso a esta sucursal', { branchId: requested });
      }
      return requested;
    }

    if (actor.branchIds.length === 1) return actor.branchIds[0]!;

    if (actor.branchIds.length === 0) {
      // Administrador sin restricción: se opera sobre la sucursal principal.
      const first = await this.prisma.client.branch.findFirst({
        where: { isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!first) throw new NotFoundError('una sucursal activa');
      return first.id;
    }

    throw new ValidationError(
      'Tienes acceso a varias sucursales: indica en cuál estás operando',
      { branchIds: actor.branchIds },
    );
  }

  private async resolveWarehouse(
    branchId: string,
    channelDefault: string | null,
  ): Promise<string> {
    if (channelDefault) {
      const owned = await this.prisma.client.warehouse.findFirst({
        where: { id: channelDefault, branchId, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (owned) return owned.id;
    }

    const fallback = await this.prisma.client.warehouse.findFirst({
      where: { branchId, isActive: true, deletedAt: null, type: 'SALES_FLOOR' },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true },
    });

    if (!fallback) {
      throw new NotFoundError(`un almacén de piso de venta en la sucursal ${branchId}`);
    }
    return fallback.id;
  }

  private async resolveTerminal(
    branchId: string,
    requested?: string | null,
  ): Promise<string | null> {
    if (requested) {
      const terminal = await this.prisma.client.terminal.findFirst({
        where: { id: requested, branchId, isActive: true, deletedAt: null },
        select: { id: true },
      });
      if (!terminal) throw new NotFoundError('la terminal', requested);
      return terminal.id;
    }

    // Sin terminal declarada: si la sucursal tiene UNA sola, es esa.
    const terminals = await this.prisma.client.terminal.findMany({
      where: { branchId, isActive: true, deletedAt: null },
      select: { id: true },
      take: 2,
    });

    return terminals.length === 1 ? terminals[0]!.id : null;
  }
}
