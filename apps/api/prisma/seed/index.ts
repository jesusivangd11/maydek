import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { v7 as uuidv7 } from 'uuid';
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
  SENSITIVE_PERMISSIONS,
  permissionGroupOf,
} from '@pv/shared-types';
import { DOC_TYPES } from '@pv/domain-rules';

/**
 * Semilla inicial.
 *
 * IDEMPOTENTE: se puede ejecutar tantas veces como haga falta. Usa `upsert` en
 * todo, así que no duplica ni pisa datos que ya hayan cambiado en producción.
 *
 * Deja el sistema en estado utilizable:
 *   catálogos base → permisos → roles → empresa → sucursal → almacén →
 *   terminal → folios → usuario administrador
 */

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const NODE_ENV = process.env.NODE_ENV ?? 'development';
for (const file of [`.env.${NODE_ENV}.local`, `.env.${NODE_ENV}`, '.env']) {
  loadEnv({ path: path.join(ROOT, file), override: false, quiet: true });
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL },
  },
});

const id = () => uuidv7();

function step(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Catálogos del SAT (D2 — preparación fiscal, ver docs/11-facturacion-cfdi.md)
// ═══════════════════════════════════════════════════════════════════════════

const SAT_TAX_REGIMES = [
  { code: '601', name: 'General de Ley Personas Morales', person: false, company: true },
  { code: '603', name: 'Personas Morales con Fines no Lucrativos', person: false, company: true },
  { code: '605', name: 'Sueldos y Salarios e Ingresos Asimilados a Salarios', person: true, company: false },
  { code: '612', name: 'Personas Físicas con Actividades Empresariales y Profesionales', person: true, company: false },
  { code: '616', name: 'Sin obligaciones fiscales', person: true, company: true },
  { code: '621', name: 'Incorporación Fiscal', person: true, company: false },
  { code: '626', name: 'Régimen Simplificado de Confianza', person: true, company: true },
];

const SAT_CFDI_USES = [
  { code: 'G01', name: 'Adquisición de mercancías' },
  { code: 'G03', name: 'Gastos en general' },
  { code: 'I08', name: 'Otra maquinaria y equipo' },
  { code: 'S01', name: 'Sin efectos fiscales' },
  { code: 'D01', name: 'Honorarios médicos, dentales y gastos hospitalarios' },
  { code: 'P01', name: 'Por definir' },
];

/** Claves que cubren un catálogo de fajas y prendas de compresión. */
const SAT_PRODUCT_KEYS = [
  { code: '53102500', name: 'Ropa interior y prendas de vestir de soporte' },
  { code: '53102502', name: 'Fajas y prendas de compresión' },
  { code: '42142500', name: 'Prendas y soportes post-quirúrgicos' },
  { code: '53102700', name: 'Ropa deportiva' },
  { code: '01010101', name: 'No existe en el catálogo' },
];

const SAT_UNIT_KEYS = [
  { code: 'H87', name: 'Pieza', symbol: 'pza' },
  { code: 'XBX', name: 'Caja', symbol: 'caja' },
  { code: 'PR', name: 'Par', symbol: 'par' },
  { code: 'E48', name: 'Unidad de servicio', symbol: 'serv' },
];

const SAT_PAYMENT_FORMS = [
  { code: '01', name: 'Efectivo' },
  { code: '02', name: 'Cheque nominativo' },
  { code: '03', name: 'Transferencia electrónica de fondos' },
  { code: '04', name: 'Tarjeta de crédito' },
  { code: '28', name: 'Tarjeta de débito' },
  { code: '99', name: 'Por definir' },
];

async function seedSatCatalogs() {
  step('Catálogos del SAT (preparación fiscal)');

  for (const r of SAT_TAX_REGIMES) {
    await prisma.satTaxRegime.upsert({
      where: { code: r.code },
      update: { name: r.name },
      create: {
        id: id(),
        code: r.code,
        name: r.name,
        appliesToPerson: r.person,
        appliesToCompany: r.company,
      },
    });
  }

  for (const u of SAT_CFDI_USES) {
    await prisma.satCfdiUse.upsert({
      where: { code: u.code },
      update: { name: u.name },
      create: { id: id(), code: u.code, name: u.name },
    });
  }

  for (const p of SAT_PRODUCT_KEYS) {
    await prisma.satProductKey.upsert({
      where: { code: p.code },
      update: { name: p.name },
      create: { id: id(), code: p.code, name: p.name },
    });
  }

  for (const u of SAT_UNIT_KEYS) {
    await prisma.satUnitKey.upsert({
      where: { code: u.code },
      update: { name: u.name, symbol: u.symbol },
      create: { id: id(), code: u.code, name: u.name, symbol: u.symbol },
    });
  }

  for (const f of SAT_PAYMENT_FORMS) {
    await prisma.satPaymentForm.upsert({
      where: { code: f.code },
      update: { name: f.name },
      create: { id: id(), code: f.code, name: f.name },
    });
  }

  console.log(
    `   ✓ ${SAT_TAX_REGIMES.length} regímenes · ${SAT_CFDI_USES.length} usos de CFDI · ` +
      `${SAT_PRODUCT_KEYS.length} claves de producto · ${SAT_UNIT_KEYS.length} unidades · ` +
      `${SAT_PAYMENT_FORMS.length} formas de pago`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Permisos y roles
// ═══════════════════════════════════════════════════════════════════════════

/** Nombre legible a partir del código: 'product.cost.view' → 'Ver costo'. */
const PERMISSION_NAMES: Record<string, string> = {
  'product.cost.view': 'Ver el costo de los productos',
  'product.price.update': 'Cambiar precios',
  'inventory.adjust': 'Ajustar existencias manualmente',
  'inventory.allow_negative': 'Vender por debajo de cero',
  'sale.discount.unlimited': 'Aplicar descuentos sin límite',
  'sale.price_override': 'Cambiar el precio en el ticket',
  'sale.cancel': 'Cancelar ventas',
  'return.refund_cash': 'Devolver dinero en efectivo',
  'return.override_window': 'Aceptar devoluciones fuera de plazo',
  'cash.close_with_difference': 'Cerrar caja con diferencia',
  'report.profit': 'Ver reportes de utilidad',
  'user.manage': 'Administrar usuarios',
  'role.manage': 'Administrar roles y permisos',
  'backup.manage': 'Administrar respaldos',
  'fiscal.stamp': 'Timbrar facturas',
  'fiscal.cancel': 'Cancelar facturas',
};

function humanize(code: string): string {
  if (PERMISSION_NAMES[code]) return PERMISSION_NAMES[code]!;
  const parts = code.split('.');
  const action = parts[parts.length - 1] ?? '';
  const resource = parts.slice(0, -1).join(' ');
  const verbs: Record<string, string> = {
    view: 'Ver',
    create: 'Crear',
    update: 'Modificar',
    archive: 'Archivar',
    manage: 'Administrar',
    apply: 'Aplicar',
    approve: 'Aprobar',
    receive: 'Recibir',
    open: 'Abrir',
    close: 'Cerrar',
    execute: 'Ejecutar',
    hold: 'Suspender',
    reprint: 'Reimprimir',
  };
  return `${verbs[action] ?? action} ${resource}`.trim();
}

async function seedPermissions() {
  step('Permisos');

  for (const code of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code },
      update: {
        group: permissionGroupOf(code),
        name: humanize(code),
        isSensitive: SENSITIVE_PERMISSIONS.includes(code),
      },
      create: {
        id: id(),
        code,
        group: permissionGroupOf(code),
        name: humanize(code),
        isSensitive: SENSITIVE_PERMISSIONS.includes(code),
      },
    });
  }

  console.log(
    `   ✓ ${ALL_PERMISSIONS.length} permisos (${SENSITIVE_PERMISSIONS.length} marcados como sensibles)`,
  );
}

async function seedRoles() {
  step('Roles');

  const permissions = await prisma.permission.findMany({ select: { id: true, code: true } });
  const byCode = new Map(permissions.map((p) => [p.code, p.id]));

  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.upsert({
      where: { code: definition.code },
      update: { name: definition.name, description: definition.description, isSystem: true },
      create: {
        id: id(),
        code: definition.code,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });

    // Se reemplazan los permisos por completo: la definición del código es la
    // fuente de verdad para los roles del sistema.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: definition.permissions
        .map((code) => byCode.get(code))
        .filter((permissionId): permissionId is string => Boolean(permissionId))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });

    console.log(
      `   ✓ ${definition.name.padEnd(14)} ${String(definition.permissions.length).padStart(3)} permisos`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Catálogos operativos
// ═══════════════════════════════════════════════════════════════════════════

async function seedOperationalCatalogs() {
  step('Catálogos operativos');

  // ── Unidades de medida ──
  const unitKeys = await prisma.satUnitKey.findMany({ select: { id: true, code: true } });
  const unitKeyByCode = new Map(unitKeys.map((u) => [u.code, u.id]));

  const units = [
    { code: 'PZA', name: 'Pieza', decimals: 0, sat: 'H87' },
    { code: 'PAR', name: 'Par', decimals: 0, sat: 'PR' },
    { code: 'CAJA', name: 'Caja', decimals: 0, sat: 'XBX' },
    { code: 'SERV', name: 'Servicio', decimals: 0, sat: 'E48' },
  ];

  for (const u of units) {
    await prisma.unit.upsert({
      where: { code: u.code },
      update: { name: u.name, satUnitKeyId: unitKeyByCode.get(u.sat) ?? null },
      create: {
        id: id(),
        code: u.code,
        name: u.name,
        decimalPlaces: u.decimals,
        satUnitKeyId: unitKeyByCode.get(u.sat) ?? null,
      },
    });
  }

  // ── Impuestos ──
  const taxes = [
    { code: 'IVA16', name: 'IVA 16 %', kind: 'RATE' as const, rate: '0.160000', sat: '002', isDefault: true },
    { code: 'IVA0', name: 'IVA 0 %', kind: 'ZERO' as const, rate: '0', sat: '002', isDefault: false },
    { code: 'EXENTO', name: 'Exento de IVA', kind: 'EXEMPT' as const, rate: '0', sat: '002', isDefault: false },
  ];

  for (const t of taxes) {
    await prisma.taxRate.upsert({
      where: { code: t.code },
      update: { name: t.name, rate: t.rate, isDefault: t.isDefault },
      create: {
        id: id(),
        code: t.code,
        name: t.name,
        kind: t.kind,
        rate: t.rate,
        satCode: t.sat,
        isDefault: t.isDefault,
      },
    });
  }

  // ── Métodos de pago ──
  const paymentForms = await prisma.satPaymentForm.findMany({ select: { id: true, code: true } });
  const formByCode = new Map(paymentForms.map((f) => [f.code, f.id]));

  const methods = [
    { code: 'CASH', name: 'Efectivo', kind: 'CASH' as const, cash: true, ref: false, change: true, sat: '01', pos: 1 },
    { code: 'CARD_DEBIT', name: 'Tarjeta de débito', kind: 'CARD' as const, cash: false, ref: true, change: false, sat: '28', pos: 2 },
    { code: 'CARD_CREDIT', name: 'Tarjeta de crédito', kind: 'CARD' as const, cash: false, ref: true, change: false, sat: '04', pos: 3 },
    { code: 'TRANSFER', name: 'Transferencia', kind: 'TRANSFER' as const, cash: false, ref: true, change: false, sat: '03', pos: 4 },
    { code: 'CREDIT', name: 'Crédito del cliente', kind: 'CREDIT' as const, cash: false, ref: false, change: false, sat: '99', pos: 5 },
    { code: 'STORE_CREDIT', name: 'Crédito a favor', kind: 'STORE_CREDIT' as const, cash: false, ref: true, change: false, sat: '99', pos: 6 },
  ];

  for (const m of methods) {
    await prisma.paymentMethod.upsert({
      where: { code: m.code },
      update: { name: m.name, satPaymentFormId: formByCode.get(m.sat) ?? null },
      create: {
        id: id(),
        code: m.code,
        name: m.name,
        kind: m.kind,
        affectsCash: m.cash,
        requiresReference: m.ref,
        allowsChange: m.change,
        satPaymentFormId: formByCode.get(m.sat) ?? null,
        position: m.pos,
      },
    });
  }

  // ── Listas de precios (P1: fuente ÚNICA de precios) ──
  const priceLists = [
    { code: 'PUBLICO', name: 'Público general', priority: 0, isDefault: true },
    { code: 'MAYOREO', name: 'Mayoreo', priority: 10, isDefault: false },
    { code: 'DISTRIBUIDOR', name: 'Distribuidor', priority: 20, isDefault: false },
    { code: 'ESPECIAL', name: 'Especial', priority: 30, isDefault: false },
  ];

  for (const list of priceLists) {
    await prisma.priceList.upsert({
      where: { code: list.code },
      update: { name: list.name, priority: list.priority },
      create: {
        id: id(),
        code: list.code,
        name: list.name,
        priority: list.priority,
        isDefault: list.isDefault,
        includesTax: true,
      },
    });
  }

  console.log(
    `   ✓ ${units.length} unidades · ${taxes.length} impuestos · ` +
      `${methods.length} métodos de pago · ${priceLists.length} listas de precios`,
  );
}

async function seedChannels() {
  step('Canales');

  const publicList = await prisma.priceList.findUnique({ where: { code: 'PUBLICO' } });

  const channels = [
    { code: 'POS', name: 'Punto de venta físico', type: 'POS' as const, ttl: 0 },
    { code: 'WEB', name: 'Página web', type: 'WEB' as const, ttl: 20 },
    { code: 'MERCADO_LIBRE', name: 'Mercado Libre', type: 'MARKETPLACE' as const, ttl: 30 },
    { code: 'WHATSAPP', name: 'WhatsApp', type: 'MESSAGING' as const, ttl: 60 },
  ];

  for (const c of channels) {
    await prisma.channel.upsert({
      where: { code: c.code },
      update: { name: c.name },
      create: {
        id: id(),
        code: c.code,
        name: c.name,
        type: c.type,
        reservationTtlMinutes: c.ttl,
        defaultPriceListId: publicList?.id ?? null,
        // Solo el POS arranca activo. Los demás se habilitan en su fase, para
        // que nadie pueda mandar pedidos por un canal sin configurar.
        isActive: c.code === 'POS',
      },
    });
  }

  console.log(`   ✓ ${channels.length} canales (solo POS activo)`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Organización
// ═══════════════════════════════════════════════════════════════════════════

async function seedOrganization() {
  step('Empresa, sucursal, almacenes y terminal');

  const companyName = process.env.SEED_COMPANY_NAME ?? 'Distribuidora de Fajas';
  const branchName = process.env.SEED_BRANCH_NAME ?? 'Tienda Principal';
  const branchCode = process.env.SEED_BRANCH_CODE ?? 'A';

  // La zona horaria NO está escrita en el código: sale de la configuración.
  // Chihuahua (salvo la franja fronteriza) es UTC-6 sin horario de verano
  // desde 2022; Ciudad Juárez sí lo observa y usa America/Ciudad_Juarez.
  // Confundirlas desfasa una hora los cortes de caja medio año.
  const timezone = process.env.SEED_TIMEZONE ?? 'America/Chihuahua';

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(
      `SEED_TIMEZONE="${timezone}" no es una zona horaria IANA válida.
` +
        'Ejemplos: America/Chihuahua, America/Ciudad_Juarez, America/Mexico_City',
    );
  }

  const regime = await prisma.satTaxRegime.findUnique({ where: { code: '626' } });

  let company = await prisma.company.findFirst({ where: { name: companyName } });
  if (!company) {
    company = await prisma.company.create({
      data: {
        id: id(),
        name: companyName,
        legalName: companyName,
        rfc: process.env.SEED_COMPANY_RFC ?? null,
        taxRegimeId: regime?.id ?? null,
        timezone,
        currency: 'MXN',
      },
    });
  }

  let branch = await prisma.branch.findFirst({
    where: { companyId: company.id, code: branchCode },
  });
  if (!branch) {
    branch = await prisma.branch.create({
      data: {
        id: id(),
        companyId: company.id,
        code: branchCode,
        name: branchName,
        // NULL = hereda la zona de la empresa. Solo se fija aquí cuando la
        // sucursal está en otra zona que la matriz.
        timezone: null,
      },
    });
  }

  // D3: hoy tienda y bodega comparten espacio → UN almacén principal.
  // Los almacenes de mermas y tránsito existen desde el inicio porque el
  // motor los necesita (devoluciones dañadas y transferencias futuras).
  const warehouses = [
    { code: 'PRINCIPAL', name: 'Almacén principal', type: 'SALES_FLOOR' as const, isDefault: true },
    { code: 'MERMAS', name: 'Mercancía dañada', type: 'DAMAGED' as const, isDefault: false },
  ];

  for (const w of warehouses) {
    const existing = await prisma.warehouse.findFirst({
      where: { branchId: branch.id, code: w.code },
    });
    if (!existing) {
      await prisma.warehouse.create({
        data: {
          id: id(),
          branchId: branch.id,
          code: w.code,
          name: w.name,
          type: w.type,
          isDefault: w.isDefault,
        },
      });
    }
  }

  const terminalCode = 'CAJA1';
  let terminal = await prisma.terminal.findFirst({
    where: { branchId: branch.id, code: terminalCode },
  });
  if (!terminal) {
    terminal = await prisma.terminal.create({
      data: {
        id: id(),
        branchId: branch.id,
        code: terminalCode,
        name: 'Caja 1',
      },
    });
  }

  // Canal POS y almacén por defecto quedan enlazados.
  const defaultWarehouse = await prisma.warehouse.findFirst({
    where: { branchId: branch.id, isDefault: true },
  });
  if (defaultWarehouse) {
    await prisma.channel.updateMany({
      where: { code: { in: ['POS', 'WEB'] } },
      data: { defaultWarehouseId: defaultWarehouse.id },
    });
  }

  console.log(`   ✓ ${companyName} → ${branchName} (${branchCode})`);
  console.log(`   ✓ Zona horaria: ${timezone} (la sucursal la hereda de la empresa)`);
  console.log(`   ✓ ${warehouses.length} almacenes · terminal ${terminal.name}`);

  return { company, branch, terminal };
}

async function seedSequences(branchId: string, branchCode: string) {
  step('Secuencias de folios');

  const perBranch = [
    DOC_TYPES.SALE,
    DOC_TYPES.RETURN,
    DOC_TYPES.CASH_SESSION,
    DOC_TYPES.PURCHASE_ORDER,
    DOC_TYPES.ADJUSTMENT,
    DOC_TYPES.CREDIT_NOTE,
    DOC_TYPES.INVOICE,
  ];

  const global = [DOC_TYPES.PURCHASE_RECEIPT, DOC_TYPES.STOCK_COUNT, DOC_TYPES.STOCK_TRANSFER];

  for (const docType of perBranch) {
    const existing = await prisma.sequence.findFirst({ where: { branchId, docType } });
    if (!existing) {
      await prisma.sequence.create({
        data: { id: id(), branchId, docType, prefix: branchCode, nextValue: 1, padding: 6 },
      });
    }
  }

  for (const docType of global) {
    const existing = await prisma.sequence.findFirst({ where: { branchId: null, docType } });
    if (!existing) {
      await prisma.sequence.create({
        data: { id: id(), branchId: null, docType, prefix: '', nextValue: 1, padding: 6 },
      });
    }
  }

  console.log(`   ✓ ${perBranch.length} por sucursal · ${global.length} globales`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Usuario administrador
// ═══════════════════════════════════════════════════════════════════════════

async function seedAdminUser(branchId: string) {
  step('Usuario administrador');

  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@distribuidora.local').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin.Cambiar123';
  const name = process.env.SEED_ADMIN_NAME ?? 'Administrador';
  const pin = process.env.SEED_ADMIN_PIN ?? '1234';
  // La app de escritorio crea al administrador con la contraseña que el dueño
  // escribe en el asistente de primer uso: ahí no hay nada que obligar a cambiar.
  const mustChangePassword = process.env.SEED_ADMIN_MUST_CHANGE !== 'false';

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    console.log(`   · ${email} ya existe; no se toca su contraseña`);
    return existing;
  }

  const adminRole = await prisma.role.findUnique({ where: { code: 'ADMIN' } });
  if (!adminRole) throw new Error('No se encontró el rol ADMIN. ¿Corrió seedRoles?');

  const userId = id();

  const user = await prisma.user.create({
    data: {
      id: userId,
      email,
      name,
      passwordHash: await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      }),
      pinHash: await argon2.hash(pin, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      }),
      status: 'ACTIVE',
      // Obliga a cambiarla en el primer acceso: la del .env la conoce
      // cualquiera que lea el repositorio.
      mustChangePassword,
      userRoles: { create: { roleId: adminRole.id } },
      userBranches: { create: { branchId } },
    },
  });

  console.log(`   ✓ ${email}`);
  if (mustChangePassword) {
    console.log(`   ⚠ Contraseña temporal: ${password}`);
    console.log(`   ⚠ PIN temporal de POS: ${pin} — CÁMBIALOS EN EL PRIMER ACCESO`);
  }

  return user;
}

// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Maydek — semilla inicial                                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await seedSatCatalogs();
  await seedPermissions();
  await seedRoles();
  await seedOperationalCatalogs();
  await seedChannels();

  const { branch } = await seedOrganization();
  await seedSequences(branch.id, branch.code);
  await seedAdminUser(branch.id);

  console.log('\n✓ Semilla aplicada. El sistema está listo para arrancar.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\n✗ La semilla falló:\n');
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
