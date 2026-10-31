import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, type AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { ConflictError, LicenseRequiredError, ValidationError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';
import { LICENSE_PUBLIC_KEY } from './public-key';
import {
  effectiveLimits,
  verifyLicense,
  type LicenseKind,
  type LicenseLimits,
  type LicensePayload,
  type LicensePlan,
} from './license.token';

const TRIAL_DAYS = 30;
const DAY_MS = 86_400_000;
const KEY_TOKEN = 'license.token';
const KEY_TRIAL = 'license.trialStartedAt';
const CACHE_MS = 30_000;

export type LicenseState = 'LICENSED' | 'TRIAL' | 'TRIAL_EXPIRED' | 'EXPIRED';

export interface LicenseStatus {
  state: LicenseState;
  /** ¿Se pueden registrar ventas? */
  canSell: boolean;
  /** Código que el cliente le da a quien emite la licencia (atarla a este equipo). */
  installationCode: string;
  plan: LicensePlan | null;
  kind: LicenseKind | null;
  licensee: string | null;
  licenseId: string | null;
  expiresAt: string | null;
  /** Días que faltan de la prueba o del periodo; null en licencias permanentes. */
  daysLeft: number | null;
  limits: LicenseLimits;
  /** Por qué se rechazó la licencia guardada, si se rechazó. */
  problem: string | null;
}

const UNLIMITED: LicenseLimits = { terminals: null, users: null, products: null };

type Tx = Parameters<Parameters<PrismaService['transaction']>[0]>[0];

/**
 * LICENCIAMIENTO.
 *
 * Reglas:
 *   · Con licencia vigente (permanente, o por periodo sin vencer): todo
 *     funciona dentro de los límites de su plan.
 *   · Sin licencia: 30 días de prueba completos, contados desde el primer uso.
 *   · Terminada la prueba o vencido el periodo: se detiene el registro de
 *     ventas nuevas. Los datos, reportes, respaldos y la pantalla para activar
 *     siguen disponibles: la información del negocio nunca queda secuestrada.
 */
@Injectable()
export class LicenseService {
  private cache: { at: number; status: LicenseStatus } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<LicenseStatus> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.status;
    const status = await this.compute();
    this.cache = { at: Date.now(), status };
    return status;
  }

  async activate(token: string, actor: AuthenticatedUser): Promise<LicenseStatus> {
    const installationCode = await this.installationCode();
    const result = verifyLicense(token, LICENSE_PUBLIC_KEY);
    if (!result.ok) throw new ValidationError(result.reason);

    const { payload } = result;
    if (payload.installation && payload.installation !== installationCode) {
      throw new ConflictError(
        'Esta licencia fue emitida para otra instalación. Pide una nueva con el código de este equipo.',
      );
    }
    if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
      throw new ConflictError('Esta licencia ya venció.');
    }

    const before = await this.status();
    await this.prisma.transaction(async (tx) => {
      await this.write(tx, KEY_TOKEN, token.replace(/\s+/g, ''), actor.id);
      await this.audit.record({
        action: AUDIT_ACTIONS.LICENSE_ACTIVATE,
        entityType: 'license',
        entityLabel: `${payload.id} · ${payload.licensee} · ${payload.plan}`,
        userId: actor.id,
        before: { state: before.state, plan: before.plan },
        after: { state: 'LICENSED', plan: payload.plan, kind: payload.kind, expiresAt: payload.expiresAt },
      });
    });
    this.cache = null;
    return this.status();
  }

  /** Impide registrar ventas nuevas cuando no hay licencia ni prueba vigente. */
  async assertCanSell(): Promise<void> {
    const s = await this.status();
    if (s.canSell) return;
    throw new LicenseRequiredError(
      s.state === 'EXPIRED'
        ? 'La licencia de este sistema venció. Actívala en Administración → Licencia para seguir vendiendo.'
        : 'Terminó el periodo de prueba. Activa tu licencia en Administración → Licencia para seguir vendiendo.',
    );
  }

  /** Impide pasar del tope que marca el plan. `current` es lo que ya existe. */
  async assertWithinLimit(kind: 'users' | 'products', current: () => Promise<number>): Promise<void> {
    const s = await this.status();
    const max = s.limits[kind];
    if (max === null) return;
    if ((await current()) < max) return;
    const what = kind === 'users' ? 'usuarios' : 'productos';
    throw new LicenseRequiredError(
      `Tu plan ${s.plan ?? ''} permite hasta ${max} ${what}. Para agregar más, sube de plan con soporte.`,
    );
  }

  async installationCode(): Promise<string> {
    const company = await this.prisma.client.company.findFirst({ select: { id: true } });
    const hex = createHash('sha256')
      .update(company?.id ?? 'sin-empresa')
      .digest('hex')
      .slice(0, 12)
      .toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  }

  // ── Internos ───────────────────────────────────────────────────────────────

  private async compute(): Promise<LicenseStatus> {
    const installationCode = await this.installationCode();
    const stored = await this.read(KEY_TOKEN);
    let problem: string | null = null;

    if (stored) {
      const result = verifyLicense(stored, LICENSE_PUBLIC_KEY);
      if (!result.ok) {
        problem = result.reason;
      } else if (result.payload.installation && result.payload.installation !== installationCode) {
        problem = 'La licencia guardada pertenece a otra instalación.';
      } else {
        return this.fromLicense(result.payload, installationCode);
      }
    }

    // Sin licencia válida: prueba de 30 días desde el primer uso.
    let started = await this.read(KEY_TRIAL);
    if (!started) {
      const now = new Date().toISOString();
      started = now;
      await this.prisma.transaction((tx) => this.write(tx, KEY_TRIAL, now, null));
    }
    const end = Date.parse(started) + TRIAL_DAYS * DAY_MS;
    const trialOn = Date.now() < end;
    return {
      state: trialOn ? 'TRIAL' : 'TRIAL_EXPIRED',
      canSell: trialOn,
      installationCode,
      plan: null,
      kind: null,
      licensee: null,
      licenseId: null,
      expiresAt: new Date(end).toISOString(),
      daysLeft: Math.max(0, Math.ceil((end - Date.now()) / DAY_MS)),
      limits: UNLIMITED,
      problem,
    };
  }

  private fromLicense(p: LicensePayload, installationCode: string): LicenseStatus {
    const expired = p.expiresAt !== null && Date.parse(p.expiresAt) <= Date.now();
    return {
      state: expired ? 'EXPIRED' : 'LICENSED',
      canSell: !expired,
      installationCode,
      plan: p.plan,
      kind: p.kind,
      licensee: p.licensee,
      licenseId: p.id,
      expiresAt: p.expiresAt,
      daysLeft: p.expiresAt ? Math.max(0, Math.ceil((Date.parse(p.expiresAt) - Date.now()) / DAY_MS)) : null,
      limits: effectiveLimits(p),
      problem: null,
    };
  }

  private async read(key: string): Promise<string | null> {
    const row = await this.prisma.client.setting.findFirst({
      where: { companyId: null, branchId: null, key },
      select: { value: true },
    });
    return row?.value ?? null;
  }

  private async write(tx: Tx, key: string, value: string, userId: string | null): Promise<void> {
    const existing = await tx.setting.findFirst({
      where: { companyId: null, branchId: null, key },
      select: { id: true },
    });
    if (existing) {
      await tx.setting.update({ where: { id: existing.id }, data: { value, updatedById: userId } });
    } else {
      await tx.setting.create({
        data: { id: newId(), key, value, isSecret: false, updatedById: userId },
      });
    }
  }
}
