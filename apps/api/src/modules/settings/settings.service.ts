import { Injectable } from '@nestjs/common';
import { SettingValueType } from '@prisma/client';
import { AUDIT_ACTIONS, type AuthenticatedUser } from '@pv/shared-types';
import { AuditService } from '../../core/audit/audit.service';
import { PrismaService } from '../../core/database/prisma.service';
import { ValidationError } from '../../core/errors/domain-errors';
import { newId } from '../../core/ids';

/**
 * CONFIGURACIÓN DE LA TIENDA.
 *
 * Lo que el dueño cambia sin tocar código: los datos que salen en el ticket,
 * cómo se imprime y las reglas de venta. Vive en la tabla `settings` como
 * pares clave/valor globales (sin empresa ni sucursal: hoy hay una tienda por
 * instalación).
 *
 * Cada clave declara su tipo y su valor por defecto aquí. Una clave que no
 * está en este catálogo no se puede guardar: la configuración no es un cajón
 * de sastre.
 */

type Kind = 'string' | 'boolean' | 'number';

const CATALOG = {
  // ── Datos del negocio (encabezado del ticket) ──
  'business.name': { kind: 'string', default: '', max: 120 },
  'business.legalName': { kind: 'string', default: '', max: 160 },
  'business.rfc': { kind: 'string', default: '', max: 13 },
  'business.address': { kind: 'string', default: '', max: 300 },
  'business.phone': { kind: 'string', default: '', max: 40 },
  'business.email': { kind: 'string', default: '', max: 160 },

  // ── Ticket ──
  'ticket.header': { kind: 'string', default: '', max: 400 },
  'ticket.footer': { kind: 'string', default: '¡Gracias por su compra!', max: 400 },
  'ticket.paper': { kind: 'string', default: '80', options: ['58', '80'] },
  'ticket.showSku': { kind: 'boolean', default: false },
  'ticket.showCashier': { kind: 'boolean', default: true },
  'ticket.showCustomer': { kind: 'boolean', default: true },
  'ticket.showSavings': { kind: 'boolean', default: true },
  'ticket.autoPrint': { kind: 'boolean', default: false },
  'ticket.copies': { kind: 'number', default: 1, min: 1, max: 3 },

  // ── Ventas ──
  /** Vender aunque el sistema diga 0: la existencia queda en negativo. */
  'sales.allowNegativeStock': { kind: 'boolean', default: true },
  /** Lista de precios que aplica la tecla de mayoreo (F11). Vacío = la lista MAYOREO. */
  'sales.wholesalePriceListId': { kind: 'string', default: '', max: 36 },
  /** Pedir confirmación al quitar artículos del ticket. */
  'sales.confirmRemove': { kind: 'boolean', default: true },
} as const satisfies Record<
  string,
  { kind: Kind; default: string | boolean | number; max?: number; min?: number; options?: readonly string[] }
>;

export type SettingKey = keyof typeof CATALOG;
export type SettingsMap = { [K in SettingKey]: (typeof CATALOG)[K]['default'] extends boolean
  ? boolean
  : (typeof CATALOG)[K]['default'] extends number
    ? number
    : string };

const VALUE_TYPE: Record<Kind, SettingValueType> = {
  string: SettingValueType.STRING,
  boolean: SettingValueType.BOOLEAN,
  number: SettingValueType.NUMBER,
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Todas las claves con su valor efectivo (guardado o por defecto). */
  async getAll(): Promise<SettingsMap> {
    const rows = await this.prisma.client.setting.findMany({
      where: { companyId: null, branchId: null, key: { in: Object.keys(CATALOG) } },
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((r) => [r.key, r.value]));

    const result: Record<string, string | boolean | number> = {};
    for (const [key, spec] of Object.entries(CATALOG)) {
      result[key] = stored.has(key) ? parse(spec.kind, stored.get(key) ?? null, spec.default) : spec.default;
    }

    // Sin nombre comercial capturado, el de la empresa: el ticket nunca sale sin encabezado.
    if (!result['business.name']) {
      const company = await this.prisma.client.company.findFirst({ select: { name: true } });
      result['business.name'] = company?.name ?? '';
    }

    return result as SettingsMap;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
    const row = await this.prisma.client.setting.findFirst({
      where: { companyId: null, branchId: null, key },
      select: { value: true },
    });
    const spec = CATALOG[key];
    return (row ? parse(spec.kind, row.value, spec.default) : spec.default) as SettingsMap[K];
  }

  /** Guarda solo las claves recibidas; las demás quedan como estaban. */
  async update(changes: Record<string, unknown>, actor: AuthenticatedUser): Promise<SettingsMap> {
    const entries = Object.entries(changes);
    for (const [key, value] of entries) {
      const spec = (CATALOG as Record<string, (typeof CATALOG)[SettingKey]>)[key];
      if (!spec) throw new ValidationError(`La opción «${key}» no existe`);
      validate(key, spec, value);
    }

    const before = await this.getAll();

    await this.prisma.transaction(async (tx) => {
      for (const [key, value] of entries) {
        const spec = CATALOG[key as SettingKey];
        const text = String(typeof value === 'string' ? value.trim() : value);
        const existing = await tx.setting.findFirst({
          where: { companyId: null, branchId: null, key },
          select: { id: true },
        });
        if (existing) {
          await tx.setting.update({
            where: { id: existing.id },
            data: { value: text, updatedById: actor.id },
          });
        } else {
          await tx.setting.create({
            data: {
              id: newId(),
              key,
              value: text,
              valueType: VALUE_TYPE[spec.kind],
              updatedById: actor.id,
            },
          });
        }
      }

      await this.audit.record({
        action: AUDIT_ACTIONS.SETTINGS_UPDATE,
        entityType: 'settings',
        entityLabel: 'Configuración de la tienda',
        userId: actor.id,
        before: Object.fromEntries(entries.map(([k]) => [k, before[k as SettingKey]])),
        after: Object.fromEntries(entries),
      });
    });

    return this.getAll();
  }
}

function parse(kind: Kind, raw: string | null, fallback: string | boolean | number) {
  if (raw === null) return fallback;
  if (kind === 'boolean') return raw === 'true';
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}

function validate(
  key: string,
  spec: { kind: Kind; max?: number; min?: number; options?: readonly string[] },
  value: unknown,
) {
  if (spec.kind === 'boolean' && typeof value !== 'boolean') {
    throw new ValidationError(`«${key}» debe ser sí o no`);
  }
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError(`«${key}» debe ser un número`);
    }
    if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
      throw new ValidationError(`«${key}» debe estar entre ${spec.min} y ${spec.max}`);
    }
  }
  if (spec.kind === 'string') {
    if (typeof value !== 'string') throw new ValidationError(`«${key}» debe ser texto`);
    if (spec.max !== undefined && value.length > spec.max) {
      throw new ValidationError(`«${key}» admite hasta ${spec.max} caracteres`);
    }
    if (spec.options && !spec.options.includes(value)) {
      throw new ValidationError(`«${key}» debe ser ${spec.options.join(' o ')}`);
    }
  }
}
