import { describe, expect, it, beforeEach } from 'vitest';
import { AuditService } from '../../src/core/audit/audit.service';
import { CryptoService } from '../../src/core/crypto/crypto.service';
import { IdempotencyService } from '../../src/core/idempotency/idempotency.service';
import { resetEnvCache, validateEnv } from '../../src/config/env';
import {
  ForbiddenError,
  InsufficientStockError,
  VersionConflictError,
} from '../../src/core/errors/domain-errors';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/db?schema=public',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('Validación de entorno', () => {
  beforeEach(() => resetEnvCache());

  it('acepta una configuración mínima válida', () => {
    const env = validateEnv({ ...BASE_ENV } as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(3000);
    expect(env.JWT_ACCESS_TTL).toBe('15m');
  });

  it('NO ARRANCA si falta DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...rest } = BASE_ENV;
    expect(() => validateEnv(rest as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('NO ARRANCA con un secreto JWT corto', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, JWT_ACCESS_SECRET: 'corto' } as NodeJS.ProcessEnv),
    ).toThrow(/32 caracteres/);
  });

  it('NO ARRANCA con una ENCRYPTION_KEY que no sea de 32 bytes', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, ENCRYPTION_KEY: 'Y29ydGE=' } as NodeJS.ProcessEnv),
    ).toThrow(/32 bytes/);
  });

  it('en producción rechaza los secretos de ejemplo', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://admin.tudominio.com',
        JWT_ACCESS_SECRET: 'desarrollo_cambia_este_secreto_de_acceso_min_32_chars',
      } as NodeJS.ProcessEnv),
    ).toThrow(/valor de ejemplo/);
  });

  it('en producción rechaza secretos de acceso y refresco iguales', () => {
    const secret = 'x'.repeat(40);
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://admin.tudominio.com',
        JWT_ACCESS_SECRET: secret,
        JWT_REFRESH_SECRET: secret,
      } as NodeJS.ProcessEnv),
    ).toThrow(/deben ser distintos/);
  });

  it('en producción rechaza CORS con comodín', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
      } as NodeJS.ProcessEnv),
    ).toThrow(/"\*"/);
  });

  it('en desarrollo tolera los valores de ejemplo', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'development',
        JWT_ACCESS_SECRET: 'desarrollo_cambia_este_secreto_de_acceso_min_32_chars',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

describe('CryptoService — cifrado en reposo', () => {
  beforeEach(() => {
    resetEnvCache();
    Object.assign(process.env, BASE_ENV);
  });

  it('cifra y descifra sin pérdida', () => {
    const crypto = new CryptoService();
    const secreto = 'contraseña-del-PAC-fiscal-2026';
    const cifrado = crypto.encrypt(secreto);

    expect(cifrado).not.toContain(secreto);
    expect(cifrado.startsWith('v1.')).toBe(true);
    expect(crypto.decrypt(cifrado)).toBe(secreto);
  });

  it('cada cifrado es distinto: el IV es aleatorio', () => {
    const crypto = new CryptoService();
    expect(crypto.encrypt('mismo')).not.toBe(crypto.encrypt('mismo'));
  });

  it('detecta manipulación del texto cifrado (GCM autentica)', () => {
    const crypto = new CryptoService();
    const cifrado = crypto.encrypt('dato íntegro');
    const alterado = `${cifrado.slice(0, -4)}AAAA`;
    expect(() => crypto.decrypt(alterado)).toThrow();
  });

  it('rechaza un formato desconocido', () => {
    const crypto = new CryptoService();
    expect(() => crypto.decrypt('no-es-un-payload')).toThrow(/no reconocido/);
  });

  it('compara en tiempo constante sin fallar por longitudes distintas', () => {
    const crypto = new CryptoService();
    expect(crypto.safeEquals('abc', 'abc')).toBe(true);
    expect(crypto.safeEquals('abc', 'abd')).toBe(false);
    expect(crypto.safeEquals('abc', 'abcdef')).toBe(false);
  });

  it('genera tokens opacos de longitud suficiente', () => {
    const crypto = new CryptoService();
    const token = crypto.generateToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(crypto.generateToken()).not.toBe(token);
  });
});

describe('IdempotencyService — hash del cuerpo', () => {
  const service = new IdempotencyService({} as never);

  it('el orden de las llaves no cambia el hash', () => {
    const a = service.hashRequest({ items: [1, 2], total: '100.00', customer: 'x' });
    const b = service.hashRequest({ customer: 'x', total: '100.00', items: [1, 2] });
    expect(a).toBe(b);
  });

  it('un cuerpo distinto produce un hash distinto', () => {
    const a = service.hashRequest({ total: '100.00' });
    const b = service.hashRequest({ total: '100.01' });
    expect(a).not.toBe(b);
  });

  it('el orden de un arreglo SÍ importa: [1,2] no es [2,1]', () => {
    expect(service.hashRequest({ items: [1, 2] })).not.toBe(
      service.hashRequest({ items: [2, 1] }),
    );
  });

  it('trata undefined y ausente como lo mismo', () => {
    expect(service.hashRequest({ a: 1, b: undefined })).toBe(service.hashRequest({ a: 1 }));
  });

  it('maneja anidamiento profundo', () => {
    const a = service.hashRequest({ x: { y: { z: [{ q: 1, p: 2 }] } } });
    const b = service.hashRequest({ x: { y: { z: [{ p: 2, q: 1 }] } } });
    expect(a).toBe(b);
  });
});

describe('AuditService — diff de cambios', () => {
  const audit = new AuditService({} as never);

  it('registra solo lo que cambió', () => {
    const changes = audit.diff(
      { basePrice: '899.00', name: 'Faja X', isActive: true },
      { basePrice: '999.00', name: 'Faja X', isActive: true },
    );
    expect(changes).toEqual({ basePrice: { before: '899.00', after: '999.00' } });
  });

  it('normaliza Decimal: 430.6100 y 430.61 son el mismo importe', () => {
    // Prisma devuelve Decimal, no string. Sin normalizar, un cambio de escala
    // aparecería como una modificación de precio que nunca ocurrió.
    const decimal = (v: string) => ({ toFixed: () => v, toString: () => v });

    expect(audit.diff({ cost: decimal('430.6100') }, { cost: decimal('430.61') })).toBeUndefined();

    expect(audit.diff({ cost: decimal('430.61') }, { cost: decimal('470.00') })).toEqual({
      cost: { before: '430.61', after: '470' },
    });
  });

  it('sin cambios devuelve undefined', () => {
    expect(audit.diff({ a: 1 }, { a: 1 })).toBeUndefined();
  });

  it('NUNCA incluye contraseñas, PIN ni tokens', () => {
    const changes = audit.diff(
      { name: 'A', passwordHash: 'viejo', pinHash: 'x', refreshToken: 't' },
      { name: 'B', passwordHash: 'nuevo', pinHash: 'y', refreshToken: 'u' },
    );
    expect(changes).toEqual({ name: { before: 'A', after: 'B' } });
    expect(JSON.stringify(changes)).not.toContain('nuevo');
  });

  it('normaliza fechas para no reportar cambios falsos', () => {
    const fecha = new Date('2026-09-05T12:00:00Z');
    expect(audit.diff({ at: fecha }, { at: new Date(fecha) })).toBeUndefined();
  });

  it('detecta el paso de un valor a null', () => {
    expect(audit.diff({ phone: '5551234567' }, { phone: null })).toEqual({
      phone: { before: '5551234567', after: null },
    });
  });
});

describe('Errores de dominio', () => {
  it('el error de existencia lleva el detalle POR LÍNEA', () => {
    const error = new InsufficientStockError([
      {
        variantId: '01900000-0000-7000-8000-000000000001',
        sku: 'FJ-0012-NEG-M',
        name: 'Faja Postquirúrgica X - Negro / M',
        requested: '3.000',
        available: '1.000',
      },
    ]);

    expect(error.httpStatus).toBe(409);
    expect(error.code).toBe('INSUFFICIENT_STOCK');
    // Lo que permite a la web decir "solo queda 1" en vez de un genérico.
    expect(error.details).toHaveLength(1);
    expect((error.details as { sku: string }[])[0]!.sku).toBe('FJ-0012-NEG-M');
  });

  it('el conflicto de versión explica qué hacer', () => {
    const error = new VersionConflictError('el producto', 3, 5);
    expect(error.httpStatus).toBe(409);
    expect(error.message).toContain('Vuelve a cargarlo');
    expect(error.details).toMatchObject({ expectedVersion: 3, actualVersion: 5 });
  });

  it('el error de permiso no revela información interna', () => {
    const error = new ForbiddenError();
    expect(error.httpStatus).toBe(403);
    expect(error.message).toBe('No tienes permiso para realizar esta acción');
  });
});
