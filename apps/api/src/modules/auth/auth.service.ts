import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import {
  AUDIT_ACTIONS,
  EVENT_TYPES,
  type AuthenticatedUser,
  type LoginResponse,
  type PermissionCode,
  type RoleCode,
} from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import {
  AccountLockedError,
  AuthorizationRequiredError,
  ForbiddenError,
  UnauthenticatedError,
} from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { OutboxService } from '../../core/outbox/outbox.service';
import { env } from '../../config/env';

/**
 * Parámetros de argon2id.
 *
 * argon2id y no bcrypt: mejor resistencia a ataques con GPU, que es como se
 * revientan las contraseñas hoy. 64 MB de memoria hace que paralelizar sea caro.
 */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
};

export interface LoginContext {
  ipAddress?: string;
  userAgent?: string;
  terminalId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ── Hashing ────────────────────────────────────────────────────────────────

  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON_OPTIONS);
  }

  async verifyPassword(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  // ── Login con correo y contraseña ──────────────────────────────────────────

  async login(
    email: string,
    password: string,
    ctx: LoginContext = {},
  ): Promise<LoginResponse & { refreshToken: string }> {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
    });

    // Se ejecuta la verificación aun sin usuario, con un hash señuelo, para que
    // el tiempo de respuesta no revele si el correo existe.
    if (!user) {
      await this.dummyVerify();
      await this.recordFailedLogin(normalizedEmail, 'usuario inexistente');
      throw new UnauthenticatedError('Correo o contraseña incorrectos');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AccountLockedError(user.lockedUntil);
    }

    if (user.status !== 'ACTIVE') {
      await this.recordFailedLogin(normalizedEmail, `cuenta ${user.status}`);
      throw new UnauthenticatedError('La cuenta no está activa');
    }

    const valid = await this.verifyPassword(user.passwordHash, password);

    if (!valid) {
      await this.registerFailedAttempt(user.id, user.failedAttempts);
      await this.recordFailedLogin(normalizedEmail, 'contraseña incorrecta');
      throw new UnauthenticatedError('Correo o contraseña incorrectos');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const principal = await this.buildPrincipal(user.id);
    const tokens = await this.issueTokens(principal, ctx);

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGIN,
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.email,
      userId: user.id,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      user: {
        id: principal.id,
        email: principal.email,
        name: principal.name,
        roles: principal.roles,
        permissions: principal.permissions,
        branchIds: principal.branchIds,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  // ── Login por PIN en el POS ────────────────────────────────────────────────

  /**
   * El cajero no teclea correo y contraseña en cada venta. La terminal ya está
   * autenticada por su token de dispositivo; el cajero se identifica con un PIN.
   *
   * El PIN se compara contra los usuarios con acceso a la sucursal de esa
   * terminal, no contra todos: reduce la superficie y evita colisiones entre
   * PIN iguales de sucursales distintas.
   */
  async loginWithPin(
    terminalId: string,
    pin: string,
    ctx: LoginContext = {},
  ): Promise<LoginResponse & { refreshToken: string }> {
    const terminal = await this.prisma.terminal.findFirst({
      where: { id: terminalId, isActive: true, deletedAt: null },
      select: { id: true, branchId: true },
    });

    if (!terminal) {
      throw new UnauthenticatedError('Terminal no reconocida');
    }

    const candidates = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        pinHash: { not: null },
        userBranches: { some: { branchId: terminal.branchId } },
      },
      select: { id: true, email: true, pinHash: true, lockedUntil: true },
    });

    for (const candidate of candidates) {
      if (candidate.lockedUntil && candidate.lockedUntil > new Date()) continue;
      if (!candidate.pinHash) continue;

      if (await this.verifyPassword(candidate.pinHash, pin)) {
        const principal = await this.buildPrincipal(candidate.id);
        principal.terminalId = terminal.id;

        const tokens = await this.issueTokens(principal, {
          ...ctx,
          terminalId: terminal.id,
        });

        await this.prisma.terminal.update({
          where: { id: terminal.id },
          data: { lastSeenAt: new Date() },
        });

        await this.audit.record({
          action: AUDIT_ACTIONS.AUTH_PIN_LOGIN,
          entityType: 'user',
          entityId: candidate.id,
          entityLabel: candidate.email,
          userId: candidate.id,
        });

        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: tokens.expiresIn,
          user: {
            id: principal.id,
            email: principal.email,
            name: principal.name,
            roles: principal.roles,
            permissions: principal.permissions,
            branchIds: principal.branchIds,
            mustChangePassword: false,
          },
        };
      }
    }

    await this.dummyVerify();
    throw new UnauthenticatedError('PIN incorrecto');
  }

  /**
   * Autorización de supervisor.
   *
   * Cuando un cajero intenta algo que excede su permiso, el sistema no lo
   * bloquea con un error seco: pide el PIN de alguien autorizado, verifica que
   * ESE usuario tenga el permiso, y devuelve su id para dejarlo registrado en
   * `authorized_by_user_id`. Es como funciona un mostrador real, y deja rastro.
   */
  async authorize(
    branchId: string,
    pin: string,
    requiredPermission: PermissionCode,
    reason: string,
  ): Promise<{ userId: string; userName: string }> {
    const candidates = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        pinHash: { not: null },
        userBranches: { some: { branchId } },
      },
      select: { id: true, name: true, email: true, pinHash: true },
    });

    for (const candidate of candidates) {
      if (!candidate.pinHash) continue;
      if (!(await this.verifyPassword(candidate.pinHash, pin))) continue;

      const permissions = await this.permissionsOf(candidate.id);
      if (!permissions.includes(requiredPermission)) {
        throw new ForbiddenError(
          `${candidate.name} no tiene permiso para autorizar esta acción`,
          { requiredPermission },
        );
      }

      await this.audit.record({
        action: AUDIT_ACTIONS.AUTH_AUTHORIZE,
        entityType: 'user',
        entityId: candidate.id,
        entityLabel: candidate.name,
        reason,
        authorizedByUserId: candidate.id,
        changes: {
          permission: { before: null, after: requiredPermission },
        },
      });

      return { userId: candidate.id, userName: candidate.name };
    }

    await this.dummyVerify();
    throw new AuthorizationRequiredError(requiredPermission, reason);
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /**
   * Emite el par de tokens. El de refresco se guarda HASHEADO: si alguien roba
   * la base, no obtiene tokens utilizables.
   *
   * `familyId` encadena las rotaciones. Ver `refresh()`.
   */
  async issueTokens(
    principal: AuthenticatedUser,
    ctx: LoginContext,
    familyId?: string,
  ): Promise<TokenPair> {
    const config = env();

    const accessToken = await this.jwt.signAsync(
      {
        sub: principal.id,
        email: principal.email,
        name: principal.name,
        roles: principal.roles,
        terminalId: principal.terminalId,
      },
      {
        secret: config.JWT_ACCESS_SECRET,
        // Formato validado por zod en env.ts.
        expiresIn: config.JWT_ACCESS_TTL as `${number}${'m' | 'h' | 'd'}`,
      },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(refreshToken);

    await this.prisma.session.create({
      data: {
        id: newId(),
        userId: principal.id,
        tokenHash,
        familyId: familyId ?? newId(),
        terminalId: ctx.terminalId ?? null,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
        ipAddress: ctx.ipAddress ?? null,
        expiresAt: new Date(Date.now() + this.ttlToMs(config.JWT_REFRESH_TTL)),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(this.ttlToMs(config.JWT_ACCESS_TTL) / 1000),
    };
  }

  /**
   * Rotación del token de refresco, con detección de reutilización.
   *
   * Si llega un token YA CONSUMIDO, es la señal clásica de robo: alguien copió
   * el token y lo está usando en paralelo. Se revocan TODAS las sesiones de esa
   * familia y se registra el incidente. Es preferible que el usuario legítimo
   * vuelva a iniciar sesión a que el atacante siga dentro.
   */
  async refresh(
    refreshToken: string,
    ctx: LoginContext = {},
  ): Promise<TokenPair & { user: AuthenticatedUser }> {
    const tokenHash = this.hashToken(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, status: true, deletedAt: true, email: true } } },
    });

    if (!session) {
      throw new UnauthenticatedError('Sesión no válida');
    }

    if (session.revokedAt) {
      // ── REUTILIZACIÓN DETECTADA ──
      await this.revokeFamily(session.familyId, 'reutilización de token detectada');

      await this.audit.record({
        action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED,
        entityType: 'session',
        entityId: session.id,
        userId: session.userId,
        reason: 'Se recibió un token de refresco ya consumido; se revocó toda la familia',
      });

      await this.outbox.publish({
        eventType: EVENT_TYPES.SESSION_REUSE_DETECTED,
        aggregateType: 'session',
        aggregateId: session.id,
        payload: { userId: session.userId, familyId: session.familyId },
      });

      this.logger.warn(
        { userId: session.userId, familyId: session.familyId },
        'Reutilización de token de refresco: se revocaron todas las sesiones del usuario',
      );

      throw new UnauthenticatedError('Sesión no válida');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthenticatedError('La sesión expiró');
    }

    if (session.user.status !== 'ACTIVE' || session.user.deletedAt) {
      throw new UnauthenticatedError('La cuenta no está activa');
    }

    // Consume el token actual y emite uno nuevo en la misma familia.
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'rotado', lastUsedAt: new Date() },
    });

    const principal = await this.buildPrincipal(session.userId);
    if (session.terminalId) principal.terminalId = session.terminalId;

    const tokens = await this.issueTokens(
      principal,
      { ...ctx, terminalId: session.terminalId ?? undefined },
      session.familyId,
    );

    return { ...tokens, user: principal };
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { tokenHash } });
    if (!session) return;

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'cierre de sesión' },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      entityType: 'session',
      entityId: session.id,
      userId: session.userId,
    });
  }

  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  // ── Identidad ──────────────────────────────────────────────────────────────

  /**
   * Arma el principal resolviendo roles, permisos efectivos y sucursales.
   *
   * Los permisos se leen SIEMPRE de la base, nunca del token: si a alguien se le
   * retira un permiso, deja de tenerlo en la siguiente petición, no cuando
   * caduque su token.
   */
  async buildPrincipal(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        userRoles: {
          include: {
            role: {
              include: { rolePermissions: { include: { permission: true } } },
            },
          },
        },
        userBranches: { select: { branchId: true } },
      },
    });

    if (!user) throw new UnauthenticatedError('Usuario no encontrado');

    const roles = user.userRoles.map((ur) => ur.role.code as RoleCode);
    const permissions = new Set<PermissionCode>();
    for (const userRole of user.userRoles) {
      for (const rp of userRole.role.rolePermissions) {
        permissions.add(rp.permission.code as PermissionCode);
      }
    }

    return {
      kind: 'user',
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      permissions: [...permissions].sort(),
      branchIds: user.userBranches.map((ub) => ub.branchId),
    };
  }

  async permissionsOf(userId: string): Promise<PermissionCode[]> {
    return (await this.buildPrincipal(userId)).permissions;
  }

  // ── Cambio de credenciales ─────────────────────────────────────────────────

  /**
   * Cambio de la propia contraseña.
   *
   * Al cambiarla se revocan TODAS las demás sesiones. Si el motivo del cambio
   * es que la contraseña estaba comprometida, dejar las sesiones vivas
   * anularía el propósito.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, passwordHash: true },
    });

    if (!user) throw new UnauthenticatedError('Usuario no encontrado');

    if (!(await this.verifyPassword(user.passwordHash, currentPassword))) {
      throw new UnauthenticatedError('La contraseña actual no es correcta');
    }

    if (currentPassword === newPassword) {
      throw new ForbiddenError('La contraseña nueva debe ser distinta de la actual');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await this.hashPassword(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    const revoked = await this.revokeAllSessions(userId, 'cambio de contraseña');

    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
      entityType: 'user',
      entityId: userId,
      entityLabel: user.email,
      userId,
      reason: `Se revocaron ${revoked} sesiones activas`,
    });
  }

  /** Asigna o cambia el PIN del POS. Se hashea igual que una contraseña. */
  async setPin(userId: string, pin: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { pinHash: await this.hashPassword(pin) },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.USER_UPDATE,
      entityType: 'user',
      entityId: userId,
      reason: 'PIN de POS actualizado',
      changes: { pin: { before: '(oculto)', after: '(actualizado)' } },
    });
  }

  // ── Interno ────────────────────────────────────────────────────────────────

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Bloqueo progresivo tras intentos fallidos. */
  private async registerFailedAttempt(userId: string, current: number): Promise<void> {
    const config = env();
    const attempts = current + 1;

    const data: { failedAttempts: number; lockedUntil?: Date } = {
      failedAttempts: attempts,
    };

    if (attempts >= config.AUTH_MAX_FAILED_ATTEMPTS) {
      data.lockedUntil = new Date(Date.now() + config.AUTH_LOCKOUT_MINUTES * 60_000);
      this.logger.warn({ userId, attempts }, 'Cuenta bloqueada por intentos fallidos');
    }

    await this.prisma.user.update({ where: { id: userId }, data });
  }

  private async recordFailedLogin(email: string, reason: string): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      entityType: 'user',
      entityLabel: email,
      reason,
    });
  }

  /**
   * Verificación señuelo: gasta el mismo tiempo que una real para que un
   * atacante no pueda deducir qué correos existen midiendo la respuesta.
   */
  private async dummyVerify(): Promise<void> {
    const DUMMY =
      '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHR2YWx1ZQ$3Qe0Xm1WQm0Bq3qXNvXm1WQm0Bq3qXNvXm1WQm0Bq3o';
    await argon2.verify(DUMMY, 'contrasena-inexistente').catch(() => false);
  }

  private ttlToMs(ttl: string): number {
    const match = ttl.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!match) throw new Error(`Duración no válida: ${ttl}`);
    const value = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return value * (multipliers[unit!] ?? 1);
  }
}
