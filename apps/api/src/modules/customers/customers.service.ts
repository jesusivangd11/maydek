import { Injectable } from '@nestjs/common';
import { CashMovementType, CustomerType, Prisma, ReferenceType } from '@prisma/client';
import { Decimal, money, moneyToString, toMoney } from '@pv/domain-rules';
import { PERMISSIONS, type AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import {
  CashSessionRequiredError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { PosContextService } from '../pos-context/pos-context.service';
import { customerDisplayName } from './customer-name';
import type {
  CustomerPaymentDto,
  ListCustomersDto,
  SetPriceListItemDto,
  StatementDto,
  UpsertCustomerDto,
} from './dto/customers.dto';

/**
 * CLIENTES Y CUENTA CORRIENTE.
 *
 * El saldo de un cliente NO es un campo: es el `balanceAfter` del último
 * asiento de su cuenta. Cargos (ventas a crédito) suben la deuda; abonos,
 * devoluciones y ajustes la bajan. Así el estado de cuenta siempre cuadra con
 * la suma de sus asientos, porque es literalmente esa suma.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posContext: PosContextService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListCustomersDto) {
    const term = query.search?.trim();
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(term
        ? {
            OR: [
              { firstName: { contains: term, mode: 'insensitive' } },
              { lastName: { contains: term, mode: 'insensitive' } },
              { businessName: { contains: term, mode: 'insensitive' } },
              { phone: { contains: term } },
              { email: { contains: term, mode: 'insensitive' } },
              { rfc: { startsWith: term.toUpperCase() } },
              { code: { equals: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.client.customer.findMany({
      where,
      take: Math.min(query.limit ?? 50, 200),
      orderBy: [{ lastPurchaseAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: { priceList: { select: { id: true, code: true, name: true } } },
    });

    const balances = await this.balancesOf(rows.map((r) => r.id));

    const data = rows.map((row) => this.present(row, balances.get(row.id) ?? new Decimal(0)));
    return { data: query.withBalance ? data.filter((c) => Number(c.balance) > 0) : data };
  }

  async findOne(id: string) {
    const row = await this.prisma.client.customer.findFirst({
      where: { id, deletedAt: null },
      include: { priceList: { select: { id: true, code: true, name: true } } },
    });
    if (!row) throw new NotFoundError('el cliente', id);

    const balances = await this.balancesOf([id]);
    const recentSales = await this.prisma.client.sale.findMany({
      where: { customerId: id },
      orderBy: { occurredAt: 'desc' },
      take: 10,
      select: { id: true, folio: true, status: true, total: true, occurredAt: true },
    });
    const creditNotes = await this.prisma.client.creditNote.findMany({
      where: { customerId: id, status: { in: ['ACTIVE', 'PARTIALLY_USED'] } },
      select: { folio: true, amount: true, usedAmount: true, expiresAt: true },
    });

    return {
      ...this.present(row, balances.get(id) ?? new Decimal(0)),
      recentSales: recentSales.map((s) => ({ ...s, total: s.total.toString() })),
      creditNotes: creditNotes.map((n) => ({
        folio: n.folio,
        available: money(n.amount.toString()).minus(money(n.usedAmount.toString())).toFixed(4),
        expiresAt: n.expiresAt,
      })),
    };
  }

  async create(dto: UpsertCustomerDto, actor: AuthenticatedUser) {
    this.assertCreditPermission(dto, actor);
    this.assertHasName(dto);

    const id = newId();
    try {
      await this.prisma.client.customer.create({ data: { id, ...this.toData(dto) } });
    } catch (error) {
      this.rethrowUnique(error);
    }

    await this.audit.record({
      action: 'customer.create',
      entityType: 'Customer',
      entityId: id,
      entityLabel: customerDisplayName(dto),
      userId: actor.id,
    });

    return this.findOne(id);
  }

  async update(id: string, dto: UpsertCustomerDto, actor: AuthenticatedUser) {
    const before = await this.prisma.client.customer.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, creditLimit: true, priceListId: true, isActive: true },
    });
    if (!before) throw new NotFoundError('el cliente', id);
    this.assertCreditPermission(dto, actor);

    try {
      await this.prisma.client.customer.update({
        where: { id },
        data: { ...this.toData(dto), version: { increment: 1 } },
      });
    } catch (error) {
      this.rethrowUnique(error);
    }

    await this.audit.record({
      action: 'customer.update',
      entityType: 'Customer',
      entityId: id,
      userId: actor.id,
      before: { creditLimit: before.creditLimit.toString(), priceListId: before.priceListId },
      after: { creditLimit: dto.creditLimit, priceListId: dto.priceListId },
    });

    return this.findOne(id);
  }

  /** Estado de cuenta: los asientos en orden, con el saldo tras cada uno. */
  async statement(id: string, query: StatementDto) {
    const customer = await this.findOne(id);
    const entries = await this.prisma.client.customerAccountEntry.findMany({
      where: {
        customerId: id,
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: 'asc' },
      take: 500,
    });

    return {
      customer: { id: customer.id, name: customer.name, creditLimit: customer.creditLimit },
      balance: customer.balance,
      entries: entries.map((e) => ({
        id: e.id,
        type: e.type,
        amount: e.amount.toString(),
        balanceAfter: e.balanceAfter.toString(),
        referenceFolio: e.referenceFolio,
        notes: e.notes,
        occurredAt: e.occurredAt,
      })),
    };
  }

  /**
   * Abono a la cuenta. Si es en efectivo entra al cajón del turno abierto,
   * igual que una venta: el corte tiene que verlo.
   */
  async registerPayment(id: string, dto: CustomerPaymentDto, actor: AuthenticatedUser) {
    const amount = toMoney(dto.amount);
    if (amount.lte(0)) throw new ValidationError('El abono debe ser mayor que cero');

    const customer = await this.findOne(id);
    const balance = money(customer.balance);
    if (amount.gt(balance)) {
      throw new ValidationError(
        `El cliente debe ${balance.toFixed(2)}; no se puede abonar ${amount.toFixed(2)}`,
      );
    }

    const method = await this.prisma.client.paymentMethod.findFirst({
      where: { code: dto.methodCode, isActive: true },
      select: { id: true, name: true, kind: true, affectsCash: true, requiresReference: true },
    });
    if (!method || method.kind === 'CREDIT' || method.kind === 'STORE_CREDIT') {
      throw new ValidationError('Elige una forma de pago válida para el abono');
    }
    if (method.requiresReference && !dto.reference) {
      throw new ValidationError(`${method.name} necesita un número de referencia`);
    }

    const ctx = await this.posContext.resolve(actor);
    const session = ctx.terminalId
      ? await this.posContext.findOpenCashSession(ctx.terminalId)
      : null;
    if (method.affectsCash && !session) throw new CashSessionRequiredError();

    const entryId = newId();
    const occurredAt = new Date();

    await this.prisma.transaction(async (tx) => {
      // Se vuelve a leer el saldo dentro de la transacción, con la fila del
      // cliente bloqueada: dos abonos simultáneos no pueden partir del mismo saldo.
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id}::uuid FOR UPDATE`;
      const last = await tx.customerAccountEntry.findFirst({
        where: { customerId: id },
        orderBy: { occurredAt: 'desc' },
        select: { balanceAfter: true },
      });
      const current = money(last?.balanceAfter.toString() ?? '0');

      await tx.customerAccountEntry.create({
        data: {
          id: entryId,
          customerId: id,
          type: 'PAYMENT',
          amount: moneyToString(amount.negated()),
          balanceAfter: moneyToString(current.minus(amount)),
          notes: dto.notes ?? `Abono con ${method.name}`,
          userId: actor.id,
          occurredAt,
        },
      });

      await tx.payment.create({
        data: {
          id: newId(),
          customerId: id,
          paymentMethodId: method.id,
          amount: moneyToString(amount),
          reference: dto.reference ?? null,
          cashSessionId: session?.id ?? null,
          userId: actor.id,
          channelId: ctx.channelId,
          metadata: { kind: 'ACCOUNT_PAYMENT', accountEntryId: entryId },
          occurredAt,
        },
      });

      if (method.affectsCash && session) {
        await tx.cashMovement.create({
          data: {
            id: newId(),
            cashSessionId: session.id,
            type: CashMovementType.CASH_IN,
            amount: moneyToString(amount),
            paymentMethodId: method.id,
            referenceType: ReferenceType.MANUAL,
            referenceId: entryId,
            reason: `Abono de ${customer.name}`,
            userId: actor.id,
            occurredAt,
          },
        });
      }

      await this.audit.record({
        action: 'customer.payment',
        entityType: 'Customer',
        entityId: id,
        entityLabel: customer.name,
        userId: actor.id,
        after: { amount: moneyToString(amount), method: dto.methodCode },
      });
    });

    return this.statement(id, {});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LISTAS DE PRECIOS
  // ═══════════════════════════════════════════════════════════════════════════

  async priceLists() {
    const lists = await this.prisma.client.priceList.findMany({
      where: { deletedAt: null },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { items: true, customers: true } } },
    });
    return lists.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      includesTax: l.includesTax,
      isActive: l.isActive,
      itemCount: l._count.items,
      customerCount: l._count.customers,
    }));
  }

  async priceListItems(priceListId: string) {
    const items = await this.prisma.client.priceListItem.findMany({
      where: { priceListId },
      orderBy: [{ variant: { sku: 'asc' } }, { minQty: 'asc' }],
      include: {
        variant: {
          select: { sku: true, nameSuffix: true, basePrice: true, product: { select: { name: true } } },
        },
      },
    });
    return items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      sku: i.variant.sku,
      name: i.variant.nameSuffix
        ? `${i.variant.product.name} ${i.variant.nameSuffix}`
        : i.variant.product.name,
      basePrice: i.variant.basePrice.toString(),
      price: i.price.toString(),
      minQty: i.minQty.toString(),
    }));
  }

  async setPriceListItem(priceListId: string, dto: SetPriceListItemDto, actor: AuthenticatedUser) {
    const price = toMoney(dto.price);
    if (price.lt(0)) throw new ValidationError('El precio no puede ser negativo');
    const minQty = dto.minQty ?? '1';

    await this.prisma.client.priceListItem.upsert({
      where: { priceListId_variantId_minQty: { priceListId, variantId: dto.variantId, minQty } },
      create: { id: newId(), priceListId, variantId: dto.variantId, price: moneyToString(price), minQty },
      update: { price: moneyToString(price) },
    });

    await this.audit.record({
      action: 'pricing.list.item.set',
      entityType: 'PriceList',
      entityId: priceListId,
      userId: actor.id,
      after: { variantId: dto.variantId, price: moneyToString(price), minQty },
    });

    return this.priceListItems(priceListId);
  }

  async removePriceListItem(priceListId: string, itemId: string) {
    await this.prisma.client.priceListItem.deleteMany({ where: { id: itemId, priceListId } });
    return this.priceListItems(priceListId);
  }

  // ═══════════════════════════════════════════════════════════════════════════

  private async balancesOf(ids: string[]): Promise<Map<string, Decimal>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.client.$queryRaw<{ customer_id: string; balance: string }[]>`
      SELECT DISTINCT ON (customer_id) customer_id, balance_after::text AS balance
      FROM customer_account_entries
      WHERE customer_id = ANY(${ids}::uuid[])
      ORDER BY customer_id, occurred_at DESC`;
    return new Map(rows.map((r) => [r.customer_id, money(r.balance)]));
  }

  private present(
    row: Prisma.CustomerGetPayload<{ include: { priceList: { select: { id: true; code: true; name: true } } } }>,
    balance: Decimal,
  ) {
    const address = row.address as { line?: string } | null;
    return {
      id: row.id,
      code: row.code,
      type: row.type,
      name: customerDisplayName(row),
      firstName: row.firstName,
      lastName: row.lastName,
      businessName: row.businessName,
      rfc: row.rfc,
      fiscalName: row.fiscalName,
      fiscalPostalCode: row.fiscalPostalCode,
      phone: row.phone,
      email: row.email,
      address: address?.line ?? null,
      priceList: row.priceList,
      creditLimit: row.creditLimit.toString(),
      creditDays: row.creditDays,
      balance: balance.toFixed(4),
      creditAvailable: Decimal.max(0, money(row.creditLimit.toString()).minus(balance)).toFixed(4),
      tags: row.tags,
      notes: row.notes,
      totalPurchased: row.totalPurchased.toString(),
      purchaseCount: row.purchaseCount,
      averageTicket: row.averageTicket.toString(),
      lastPurchaseAt: row.lastPurchaseAt,
      isActive: row.isActive,
    };
  }

  private toData(dto: UpsertCustomerDto) {
    const clean = (value?: string | null) =>
      value === undefined ? undefined : value === null ? null : value.trim() || null;
    return {
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.code !== undefined ? { code: clean(dto.code) } : {}),
      ...(dto.firstName !== undefined ? { firstName: clean(dto.firstName) } : {}),
      ...(dto.lastName !== undefined ? { lastName: clean(dto.lastName) } : {}),
      ...(dto.businessName !== undefined ? { businessName: clean(dto.businessName) } : {}),
      ...(dto.rfc !== undefined ? { rfc: clean(dto.rfc)?.toUpperCase() ?? null } : {}),
      ...(dto.fiscalName !== undefined ? { fiscalName: clean(dto.fiscalName) } : {}),
      ...(dto.fiscalPostalCode !== undefined ? { fiscalPostalCode: clean(dto.fiscalPostalCode) } : {}),
      ...(dto.phone !== undefined ? { phone: clean(dto.phone) } : {}),
      ...(dto.email !== undefined ? { email: clean(dto.email)?.toLowerCase() ?? null } : {}),
      ...(dto.address !== undefined
        ? { address: dto.address ? { line: dto.address.trim() } : Prisma.JsonNull }
        : {}),
      ...(dto.priceListId !== undefined ? { priceListId: dto.priceListId } : {}),
      ...(dto.creditLimit !== undefined ? { creditLimit: moneyToString(toMoney(dto.creditLimit)) } : {}),
      ...(dto.creditDays !== undefined ? { creditDays: dto.creditDays } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.notes !== undefined ? { notes: clean(dto.notes) } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
  }

  private assertHasName(dto: UpsertCustomerDto) {
    const hasName =
      dto.type === CustomerType.COMPANY
        ? Boolean(dto.businessName?.trim())
        : Boolean(dto.firstName?.trim() || dto.businessName?.trim());
    if (!hasName) throw new ValidationError('El cliente necesita un nombre');
  }

  /** Dar crédito o cambiar la lista de precios es un permiso aparte de editar. */
  private assertCreditPermission(dto: UpsertCustomerDto, actor: AuthenticatedUser) {
    const touchesCredit =
      (dto.creditLimit !== undefined && Number(dto.creditLimit) > 0) ||
      dto.creditDays !== undefined;
    if (touchesCredit && !actor.permissions.includes(PERMISSIONS.CUSTOMER_CREDIT_MANAGE)) {
      throw new ForbiddenError('No tienes permiso para otorgar crédito', {
        requiredPermission: PERMISSIONS.CUSTOMER_CREDIT_MANAGE,
      });
    }
  }

  private rethrowUnique(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Ya existe un cliente con ese código');
    }
    throw error;
  }
}
