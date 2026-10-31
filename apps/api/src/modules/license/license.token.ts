import { createPublicKey, verify } from 'node:crypto';

/**
 * LICENCIA FIRMADA.
 *
 * Una licencia es un texto `MAYDEK1.<datos>.<firma>`:
 *   · datos  = JSON en base64url (negocio, plan, tipo, vencimiento, límites).
 *   · firma  = Ed25519 sobre el texto de los datos, hecha con la llave PRIVADA
 *              que solo existe en la computadora de quien emite.
 *
 * El programa solo trae la llave pública: puede comprobar que la licencia es
 * auténtica y no fue alterada, pero no puede fabricar una. Se valida sin
 * internet.
 */

export const LICENSE_PLANS = ['BASICO', 'PROFESIONAL', 'EMPRESARIAL'] as const;
export type LicensePlan = (typeof LICENSE_PLANS)[number];
export type LicenseKind = 'PERMANENT' | 'TERM';

/** `null` = sin límite. */
export interface LicenseLimits {
  terminals: number | null;
  users: number | null;
  products: number | null;
}

export const PLAN_LIMITS: Record<LicensePlan, LicenseLimits> = {
  BASICO: { terminals: 1, users: 2, products: 2000 },
  PROFESIONAL: { terminals: 3, users: 10, products: null },
  EMPRESARIAL: { terminals: null, users: null, products: null },
};

export interface LicensePayload {
  v: 1;
  /** Folio de la licencia, para llevar el registro: LIC-2026-0001. */
  id: string;
  licensee: string;
  plan: LicensePlan;
  kind: LicenseKind;
  issuedAt: string;
  /** Solo en licencias por periodo. Las permanentes no vencen. */
  expiresAt: string | null;
  /** Código de instalación al que está atada; null = sirve en cualquier equipo. */
  installation: string | null;
  /** Límites a la medida; lo que no se indique sale del plan. */
  limits?: Partial<LicenseLimits>;
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: string };

const PREFIX = 'MAYDEK1';

export function verifyLicense(token: string, publicKeyPem: string): VerifyResult {
  const parts = token.replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { ok: false, reason: 'El texto no tiene el formato de una licencia de Maydek.' };
  }
  const [, body, signature] = parts as [string, string, string];

  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(body, 'utf8'),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'La licencia no es auténtica o está incompleta.' };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LicensePayload;
  } catch {
    return { ok: false, reason: 'La licencia está dañada.' };
  }
  if (payload.v !== 1 || !LICENSE_PLANS.includes(payload.plan)) {
    return { ok: false, reason: 'La licencia es de una versión que este programa no reconoce.' };
  }
  return { ok: true, payload };
}

export function effectiveLimits(payload: LicensePayload): LicenseLimits {
  return { ...PLAN_LIMITS[payload.plan], ...payload.limits };
}
