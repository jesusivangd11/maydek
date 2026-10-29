import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TimeZoneService } from '../../src/core/time/timezone.service';

/**
 * ZONA HORARIA CONFIGURABLE
 *
 * Ninguna zona está escrita en el código. La empresa declara la suya y cada
 * sucursal puede tener otra; una sucursal sin zona propia hereda la de la
 * empresa. Abrir una sucursal en otro estado no requiere tocar código.
 *
 * Se prueba contra PostgreSQL real porque la herencia empresa→sucursal se
 * resuelve con una consulta, y porque los TIMESTAMPTZ deben ir y volver en UTC.
 */

const OWNER_URL = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const id = () => uuidv7();

/** El servicio solo necesita `prisma.client`; se le pasa el cliente directo. */
const tz = new TimeZoneService({ client: owner } as never);

let companyId: string;
let branchHereda: string;
let branchPropia: string;

beforeAll(async () => {
  await owner.$connect();

  const company = await owner.company.create({
    data: { id: id(), name: `TZ ${Date.now()}`, timezone: 'America/Chihuahua' },
  });
  companyId = company.id;

  // Sucursal SIN zona propia: hereda la de la empresa.
  const a = await owner.branch.create({
    data: {
      id: id(),
      companyId,
      code: `TZA${Date.now() % 1000}`,
      name: 'Chihuahua centro',
      timezone: null,
      businessDayCutoff: '00:00',
    },
  });
  branchHereda = a.id;

  // Sucursal en la franja fronteriza: zona propia CON horario de verano.
  const b = await owner.branch.create({
    data: {
      id: id(),
      companyId,
      code: `TZB${Date.now() % 1000}`,
      name: 'Ciudad Juárez',
      timezone: 'America/Ciudad_Juarez',
      businessDayCutoff: '04:00',
    },
  });
  branchPropia = b.id;
}, 60_000);

afterAll(async () => {
  await owner.$disconnect();
});

describe('Validación de zonas horarias', () => {
  it('acepta zonas IANA reales', () => {
    for (const zona of [
      'America/Chihuahua',
      'America/Ciudad_Juarez',
      'America/Mexico_City',
      'UTC',
      'America/Bogota',
    ]) {
      expect(tz.isValid(zona), zona).toBe(true);
    }
  });

  it('rechaza lo que no es una zona IANA', () => {
    for (const zona of ['', 'Mexico/Chihuahua', 'GMT-6', 'Hora del Centro', 'xyz']) {
      expect(tz.isValid(zona), zona).toBe(false);
    }
  });

  it('el error explica cómo corregirlo', () => {
    expect(() => tz.assertValid('Hora del Centro')).toThrow(/no es una zona horaria válida/);
    expect(() => tz.assertValid('Hora del Centro')).toThrow(/America\/Chihuahua/);
  });
});

describe('Herencia empresa → sucursal', () => {
  it('una sucursal sin zona propia hereda la de la empresa', async () => {
    expect(await tz.forBranch(branchHereda)).toBe('America/Chihuahua');
  });

  it('una sucursal con zona propia NO hereda', async () => {
    expect(await tz.forBranch(branchPropia)).toBe('America/Ciudad_Juarez');
  });

  it('cambiar la zona de la empresa se refleja en quien hereda', async () => {
    await owner.company.update({
      where: { id: companyId },
      data: { timezone: 'America/Mexico_City' },
    });
    tz.invalidate();

    expect(await tz.forBranch(branchHereda)).toBe('America/Mexico_City');
    // La que tiene zona propia no se ve afectada.
    expect(await tz.forBranch(branchPropia)).toBe('America/Ciudad_Juarez');

    await owner.company.update({
      where: { id: companyId },
      data: { timezone: 'America/Chihuahua' },
    });
    tz.invalidate();
  });

  it('la base rechaza una empresa sin zona horaria', async () => {
    await expect(
      owner.$executeRaw`
        INSERT INTO companies (id, name, timezone, currency, created_at, updated_at)
        VALUES (${id()}::uuid, 'Sin zona', '', 'MXN', now(), now())
      `,
    ).rejects.toThrow(/chk_company_timezone_no_vacia|violates check constraint/i);
  });

  it('la base rechaza una hora de corte con formato inválido', async () => {
    await expect(
      owner.branch.create({
        data: {
          id: id(),
          companyId,
          code: `BAD${Date.now() % 1000}`,
          name: 'Corte inválido',
          businessDayCutoff: '25:99',
        },
      }),
    ).rejects.toThrow(/chk_branch_cutoff_formato|violates check constraint/i);
  });
});

describe('Almacenamiento en UTC, presentación en zona local', () => {
  it('un TIMESTAMPTZ va y vuelve como el mismo instante', async () => {
    // 5 de septiembre de 2026, 19:00 en Chihuahua (UTC−6) = 01:00 UTC del día 6.
    const instante = new Date('2026-09-06T01:00:00.000Z');

    const filas = await owner.$queryRaw<{ guardado: Date }[]>`
      SELECT ${instante}::timestamptz AS guardado
    `;
    expect(filas[0]?.guardado.toISOString()).toBe(instante.toISOString());
  });

  it('el MISMO instante se presenta distinto en cada sucursal', () => {
    const instante = new Date('2026-09-06T01:00:00.000Z');

    // Chihuahua es UTC−6 sin horario de verano desde 2022.
    expect(tz.format(instante, 'America/Chihuahua')).toBe('05/09/2026, 19:00');

    // Ciudad Juárez sí observa horario de verano: en septiembre es UTC−6 también,
    // pero en enero sería UTC−7. Por eso no comparten zona.
    expect(tz.formatDate(instante, 'America/Chihuahua')).toBe('05/09/2026');
  });

  it('la fecha civil resuelve a qué día pertenece una venta nocturna', () => {
    // Una venta de las 19:00 del sábado en Chihuahua es domingo en UTC.
    const instante = new Date('2026-09-06T01:00:00.000Z');

    expect(tz.civilDate(instante, 'UTC')).toBe('2026-09-06');
    expect(tz.civilDate(instante, 'America/Chihuahua')).toBe('2026-09-05');
  });

  it('Chihuahua y Ciudad Juárez difieren en invierno', () => {
    // Enero: Ciudad Juárez está en horario estándar (UTC−7), Chihuahua en UTC−6.
    const enero = new Date('2026-01-15T18:00:00.000Z');

    const offsetChihuahua = tz.offsetMinutes(enero, 'America/Chihuahua');
    const offsetJuarez = tz.offsetMinutes(enero, 'America/Ciudad_Juarez');

    expect(offsetChihuahua).toBe(-360); // UTC−6
    expect(offsetJuarez).toBe(-420); // UTC−7

    // Una hora de diferencia: confundirlas desfasa los cortes de caja.
    expect(offsetChihuahua - offsetJuarez).toBe(60);
  });
});

describe('Día operativo', () => {
  it('con corte a medianoche, el día es el natural de la sucursal', () => {
    const { from, to } = tz.businessDayRange('2026-09-05', 'America/Chihuahua', '00:00');

    // 00:00 del 5 en Chihuahua (UTC−6) = 06:00 UTC del 5.
    expect(from.toISOString()).toBe('2026-09-05T06:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-06T06:00:00.000Z');
  });

  it('con corte a las 04:00, una venta de la 01:30 pertenece al día anterior', () => {
    const { from, to } = tz.businessDayRange('2026-09-05', 'America/Chihuahua', '04:00');

    // El "lunes" va de las 04:00 del lunes a las 04:00 del martes.
    expect(from.toISOString()).toBe('2026-09-05T10:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-06T10:00:00.000Z');

    // Una venta a la 01:30 del día 6 en Chihuahua = 07:30 UTC del 6.
    const ventaNocturna = new Date('2026-09-06T07:30:00.000Z');
    expect(ventaNocturna >= from && ventaNocturna < to).toBe(true);
  });

  it('la ventana del día operativo dura exactamente 24 horas', () => {
    const { from, to } = tz.businessDayRange('2026-09-05', 'America/Chihuahua', '06:30');
    expect(to.getTime() - from.getTime()).toBe(24 * 3_600_000);
  });

  it('cada sucursal calcula su propio día operativo', async () => {
    const chihuahua = await tz.currentBusinessDay(branchHereda);
    const juarez = await tz.currentBusinessDay(branchPropia);

    expect(chihuahua.timeZone).toBe('America/Chihuahua');
    expect(juarez.timeZone).toBe('America/Ciudad_Juarez');

    // Cortes distintos → ventanas distintas.
    expect(chihuahua.from.toISOString()).not.toBe(juarez.from.toISOString());
  });

  it('rechaza una hora de corte imposible', () => {
    expect(() => tz.businessDayRange('2026-09-05', 'America/Chihuahua', '99:00')).toThrow(
      /Hora de corte inválida/,
    );
  });
});

describe('Catálogo de zonas para la interfaz', () => {
  it('ofrece las zonas de México con la advertencia del horario de verano', () => {
    const zonas = TimeZoneService.COMMON_MEXICO_ZONES;

    const chihuahua = zonas.find((z) => z.id === 'America/Chihuahua');
    const juarez = zonas.find((z) => z.id === 'America/Ciudad_Juarez');

    expect(chihuahua?.dst).toBe(false);
    expect(juarez?.dst).toBe(true);

    // Todas las ofrecidas deben ser válidas de verdad.
    for (const zona of zonas) {
      expect(tz.isValid(zona.id), zona.id).toBe(true);
    }
  });

  it('lista todas las zonas del sistema para un selector completo', () => {
    const disponibles = tz.listAvailable();
    expect(disponibles.length).toBeGreaterThan(100);
    expect(disponibles).toContain('America/Chihuahua');
    expect(disponibles).toContain('America/Bogota');
  });
});
