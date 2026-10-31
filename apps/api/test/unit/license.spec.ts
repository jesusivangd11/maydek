import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  effectiveLimits,
  verifyLicense,
  type LicensePayload,
} from '../../src/modules/license/license.token';

/** Firma igual que `scripts/licencias.mjs`. */
function issue(payload: LicensePayload, privateKey = pair.privateKey): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64url');
  return `MAYDEK1.${body}.${signature}`;
}

const pair = generateKeyPairSync('ed25519');
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const base: LicensePayload = {
  v: 1,
  id: 'LIC-2026-0001',
  licensee: 'Abarrotes López',
  plan: 'EMPRESARIAL',
  kind: 'PERMANENT',
  issuedAt: '2026-10-30T00:00:00.000Z',
  expiresAt: null,
  installation: null,
};

describe('licencia firmada', () => {
  it('acepta una licencia auténtica', () => {
    const result = verifyLicense(issue(base), publicPem);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.licensee).toBe('Abarrotes López');
  });

  it('tolera saltos de línea y espacios al pegarla', () => {
    const token = issue(base);
    const messy = ` ${token.slice(0, 40)}\n${token.slice(40)} \n`;
    expect(verifyLicense(messy, publicPem).ok).toBe(true);
  });

  it('rechaza datos alterados (cambiar el plan o quitar el vencimiento)', () => {
    const basic = issue({ ...base, plan: 'BASICO', kind: 'TERM', expiresAt: '2026-11-30T00:00:00.000Z' });
    const [prefix, , signature] = basic.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...base, plan: 'EMPRESARIAL' }), 'utf8').toString('base64url');
    expect(verifyLicense(`${prefix}.${forgedBody}.${signature}`, publicPem).ok).toBe(false);
  });

  it('rechaza una licencia firmada con otra llave', () => {
    const other = generateKeyPairSync('ed25519');
    expect(verifyLicense(issue(base, other.privateKey), publicPem).ok).toBe(false);
  });

  it('rechaza texto que no es una licencia', () => {
    expect(verifyLicense('hola', publicPem).ok).toBe(false);
    expect(verifyLicense('MAYDEK1.abc', publicPem).ok).toBe(false);
  });
});

describe('límites del plan', () => {
  it('Empresarial no tiene límites', () => {
    expect(effectiveLimits(base)).toEqual({ terminals: null, users: null, products: null });
  });

  it('Básico trae sus topes y una licencia a la medida los sobrescribe', () => {
    const basic = { ...base, plan: 'BASICO' as const };
    expect(effectiveLimits(basic)).toEqual({ terminals: 1, users: 2, products: 2000 });
    expect(effectiveLimits({ ...basic, limits: { users: 5 } })).toEqual({ terminals: 1, users: 5, products: 2000 });
  });
});
