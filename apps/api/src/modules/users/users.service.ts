import { Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  EVENT_TYPES,
  PERMISSION_NAMES,
  ROLES,
  permissionGroupOf,
  type AuthenticatedUser,
} from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { OutboxService } from '../../core/outbox/outbox.service';
import { AuthService } from '../auth/auth.service';
import type { CreateUserDto, ListUsersDto, UpdateUserDto } from './dto/users.dto';

/** Campos que se devuelven de un usuario. NUNCA hashes ni secretos. */
const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  name: true,
  phone: true,
  status: true,
  mfaEnabled: true,
  lastLoginAt: true,
  mustChangePassword: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(query: ListUsersDto) {
    const limit = Math.min(query.limit ?? 50, 200);

    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { name: { contains: query.search, mode: 'insensitive' as const } },
                { username: { contains: query.search, mode: 'insensitive' as const } },
                { email: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: {
        ...USER_SELECT,
        userRoles: { select: { role: { select: { code: true, name: true } } } },
        userBranches: { select: { branchId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;

    return {
      data: page.map((u) => ({
        ...u,
        userRoles: undefined,
        userBranches: undefined,
        roles: u.userRoles.map((ur) => ur.role),
        branchIds: u.userBranches.map((ub) => ub.branchId),
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...USER_SELECT,
        userRoles: { select: { role: { select: { code: true, name: true } } } },
        userBranches: { select: { branchId: true } },
      },
    });

    if (!user) throw new NotFoundError('el usuario', id);

    const principal = await this.auth.buildPrincipal(id);

    return {
      ...user,
      userRoles: undefined,
      userBranches: undefined,
      roles: user.userRoles.map((ur) => ur.role),
      branchIds: user.userBranches.map((ub) => ub.branchId),
      /** Permisos EFECTIVOS: la unión de todos sus roles. */
      permissions: principal.permissions,
    };
  }

  async create(dto: CreateUserDto) {
    const username = dto.username.trim().toLowerCase();
    // El correo es opcional; la columna es única y obligatoria, así que quien
    // no lo da recibe uno interno derivado de su usuario.
    const email = dto.email?.trim().toLowerCase() || `${username}@sin-correo.maydek`;

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
      select: { username: true },
    });
    if (existing) {
      throw new ConflictError(
        existing.username === username
          ? `El usuario «${username}» ya existe`
          : 'Ya existe un usuario con ese correo',
      );
    }

    const roles = await this.prisma.role.findMany({
      where: { code: { in: dto.roleCodes } },
      select: { id: true, code: true },
    });
    if (roles.length !== dto.roleCodes.length) {
      throw new ConflictError('Alguno de los roles indicados no existe');
    }

    const userId = newId();

    // Todo dentro de una transacción: un usuario sin roles no debe existir.
    const created = await this.prisma.transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          username,
          email,
          name: dto.name,
          phone: dto.phone ?? null,
          passwordHash: await this.auth.hashPassword(dto.password),
          pinHash: dto.pin ? await this.auth.hashPassword(dto.pin) : null,
          // El administrador fija una contraseña temporal; el usuario la cambia
          // en su primer acceso y nadie más la conoce.
          mustChangePassword: dto.mustChangePassword ?? true,
        },
        select: USER_SELECT,
      });

      await tx.userRole.createMany({
        data: roles.map((r) => ({ userId, roleId: r.id })),
      });

      if (dto.branchIds?.length) {
        await tx.userBranch.createMany({
          data: dto.branchIds.map((branchId) => ({ userId, branchId })),
        });
      }

      await this.audit.record({
        action: AUDIT_ACTIONS.USER_CREATE,
        entityType: 'user',
        entityId: userId,
        entityLabel: `${dto.name} (${username})`,
        after: { username, email, name: dto.name, roles: dto.roleCodes },
      });

      await this.outbox.publish({
        eventType: EVENT_TYPES.USER_CREATED,
        aggregateType: 'user',
        aggregateId: userId,
        payload: { id: userId, username, email, name: dto.name, roles: dto.roleCodes },
      });

      return user;
    });

    return created;
  }

  async update(id: string, dto: UpdateUserDto) {
    const before = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: USER_SELECT,
    });
    if (!before) throw new NotFoundError('el usuario', id);

    const email = dto.email?.trim().toLowerCase();
    if (email && email !== before.email) {
      const taken = await this.prisma.user.findFirst({ where: { email, id: { not: id } }, select: { id: true } });
      if (taken) throw new ConflictError('Ya existe un usuario con ese correo');
    }

    const username = dto.username;
    if (username && username !== before.username) {
      const taken = await this.prisma.user.findFirst({ where: { username, id: { not: id } }, select: { id: true } });
      if (taken) throw new ConflictError('Ya existe una persona con ese usuario');
    }

    return this.prisma.transaction(async (tx) => {
      const after = await tx.user.update({
        where: { id },
        data: {
          ...(username ? { username } : {}),
          ...(email ? { email } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          // Contraseña olvidada: el administrador pone una temporal y la persona
          // la cambia al entrar. Nunca se muestra la anterior.
          ...(dto.password !== undefined
            ? {
                passwordHash: await this.auth.hashPassword(dto.password),
                mustChangePassword: true,
                failedAttempts: 0,
                lockedUntil: null,
              }
            : {}),
          ...(dto.pin !== undefined ? { pinHash: await this.auth.hashPassword(dto.pin) } : {}),
          version: { increment: 1 },
        },
        select: USER_SELECT,
      });

      // Suspender a alguien debe expulsarlo de inmediato, no cuando caduque su
      // token: si se le retira el acceso, es por algo.
      if (dto.status && dto.status !== 'ACTIVE') {
        await this.auth.revokeAllSessions(id, `cuenta ${dto.status}`);
      }

      await this.audit.record({
        action: AUDIT_ACTIONS.USER_UPDATE,
        entityType: 'user',
        entityId: id,
        entityLabel: after.email,
        before,
        after,
      });

      return after;
    });
  }

  /**
   * Cambia los roles de un usuario.
   *
   * Protege el caso que rompe un sistema en producción: quedarse sin ningún
   * administrador. Es un error del que no se puede salir desde la interfaz.
   */
  async updateRoles(id: string, roleCodes: string[], actor: AuthenticatedUser) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        userRoles: { select: { role: { select: { code: true } } } },
      },
    });
    if (!user) throw new NotFoundError('el usuario', id);

    const previousRoles = user.userRoles.map((ur) => ur.role.code);
    const losesAdmin = previousRoles.includes(ROLES.ADMIN) && !roleCodes.includes(ROLES.ADMIN);

    if (losesAdmin) {
      const remainingAdmins = await this.countActiveAdmins(id);
      if (remainingAdmins === 0) {
        throw new ForbiddenError(
          'No puedes quitar el último administrador: el sistema quedaría sin nadie que pueda administrarlo',
        );
      }
    }

    const roles = await this.prisma.role.findMany({
      where: { code: { in: roleCodes } },
      select: { id: true, code: true },
    });
    if (roles.length !== roleCodes.length) {
      throw new ConflictError('Alguno de los roles indicados no existe');
    }

    return this.prisma.transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({
        data: roles.map((r) => ({ userId: id, roleId: r.id, grantedById: actor.id })),
      });

      await this.audit.record({
        action: AUDIT_ACTIONS.USER_ROLES_UPDATE,
        entityType: 'user',
        entityId: id,
        entityLabel: `${user.name} (${user.email})`,
        changes: {
          roles: { before: previousRoles.sort(), after: [...roleCodes].sort() },
        },
      });

      await this.outbox.publish({
        eventType: EVENT_TYPES.USER_ROLES_CHANGED,
        aggregateType: 'user',
        aggregateId: id,
        payload: { userId: id, before: previousRoles, after: roleCodes },
      });

      return { id, roles: roleCodes };
    });
  }

  /**
   * Fija los permisos EFECTIVOS de una persona.
   *
   * Lo que el administrador marca es la lista final; aquí se compara contra
   * lo que ya traen sus roles y solo se guardan las diferencias. Así, si el
   * rol de cajero gana un permiso mañana, también lo gana esta persona, salvo
   * que se le haya retirado a propósito.
   */
  async updatePermissions(id: string, desired: string[], actor: AuthenticatedUser) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        userRoles: {
          select: { role: { select: { rolePermissions: { select: { permission: { select: { code: true } } } } } } },
        },
      },
    });
    if (!user) throw new NotFoundError('el usuario', id);

    // Nadie se encierra fuera: quien administra usuarios no puede quitarse ese permiso.
    if (id === actor.id && !desired.includes('user.manage')) {
      throw new ForbiddenError('No puedes quitarte el permiso de administrar usuarios');
    }

    const catalog = await this.prisma.permission.findMany({ select: { id: true, code: true } });
    const idByCode = new Map(catalog.map((p) => [p.code, p.id]));
    const unknown = desired.filter((code) => !idByCode.has(code));
    if (unknown.length > 0) {
      throw new ConflictError(`Permisos desconocidos: ${unknown.join(', ')}`);
    }

    const fromRoles = new Set(
      user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code)),
    );
    const wanted = new Set(desired);
    const grants = [...wanted].filter((code) => !fromRoles.has(code));
    const revokes = [...fromRoles].filter((code) => !wanted.has(code));

    await this.prisma.transaction(async (tx) => {
      await tx.userPermission.deleteMany({ where: { userId: id } });
      await tx.userPermission.createMany({
        data: [
          ...grants.map((code) => ({ userId: id, permissionId: idByCode.get(code)!, granted: true, grantedById: actor.id })),
          ...revokes.map((code) => ({ userId: id, permissionId: idByCode.get(code)!, granted: false, grantedById: actor.id })),
        ],
      });

      await this.audit.record({
        action: AUDIT_ACTIONS.USER_ROLES_UPDATE,
        entityType: 'user',
        entityId: id,
        entityLabel: `${user.name} (${user.email})`,
        after: { grants, revokes },
      });
    });

    return this.findOne(id);
  }

  /** Archiva, nunca elimina: el usuario aparece en ventas y movimientos históricos. */
  async archive(id: string, actor: AuthenticatedUser) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        userRoles: { select: { role: { select: { code: true } } } },
      },
    });
    if (!user) throw new NotFoundError('el usuario', id);

    if (user.id === actor.id) {
      throw new ForbiddenError('No puedes archivar tu propia cuenta');
    }

    if (user.userRoles.some((ur) => ur.role.code === ROLES.ADMIN)) {
      const remainingAdmins = await this.countActiveAdmins(id);
      if (remainingAdmins === 0) {
        throw new ForbiddenError('No puedes archivar el último administrador');
      }
    }

    return this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'ARCHIVED' },
      });

      await this.auth.revokeAllSessions(id, 'usuario archivado');

      await this.audit.record({
        action: AUDIT_ACTIONS.USER_ARCHIVE,
        entityType: 'user',
        entityId: id,
        entityLabel: `${user.name} (${user.email})`,
      });

      return { id, archived: true };
    });
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      include: {
        _count: { select: { rolePermissions: true, userRoles: true } },
        rolePermissions: { select: { permission: { select: { code: true } } } },
      },
      orderBy: { code: 'asc' },
    });

    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissionCount: r._count.rolePermissions,
      userCount: r._count.userRoles,
      permissions: r.rolePermissions.map((rp) => rp.permission.code),
    }));
  }

  async listPermissions() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: [{ group: 'asc' }, { code: 'asc' }],
    });

    const grouped = new Map<string, typeof permissions>();
    for (const permission of permissions) {
      const group = permissionGroupOf(permission.code);
      const bucket = grouped.get(group) ?? [];
      bucket.push(permission);
      grouped.set(group, bucket);
    }

    return [...grouped.entries()].map(([group, items]) => ({
      group,
      permissions: items.map((p) => ({
        code: p.code,
        // Bases sembradas con versiones anteriores guardan nombres a medio traducir.
        name: (PERMISSION_NAMES as Record<string, string>)[p.code] ?? p.name,
        description: p.description,
        isSensitive: p.isSensitive,
      })),
    }));
  }

  /** Administradores activos, excluyendo a uno. */
  private async countActiveAdmins(excludeUserId: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        id: { not: excludeUserId },
        deletedAt: null,
        status: 'ACTIVE',
        userRoles: { some: { role: { code: ROLES.ADMIN } } },
      },
    });
  }
}
