import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient, StockCondition } from '@prisma/client';
import * as argon2 from 'argon2';
import { v7 as uuidv7 } from 'uuid';

/**
 * DATOS DE DESARROLLO. No es la semilla de producción.
 *
 * `prisma/seed/index.ts` siembra lo que el sistema NECESITA para arrancar:
 * catálogos del SAT, permisos, roles, la empresa y su primer administrador.
 * Eso va a producción.
 *
 * Este archivo siembra lo que hace falta para PROBAR: productos inventados,
 * clientes de mentira, existencia ficticia y usuarios de prueba con
 * contraseñas conocidas. Eso NO puede acabar en producción, y por eso:
 *
 *   · Se niega a ejecutarse con NODE_ENV=production.
 *   · Todo lo que crea lleva la marca `metadata.seed = "dev"` o el prefijo
 *     DEV- en el código, para poder identificarlo y borrarlo después.
 *
 *     pnpm db:seed:dev
 */

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const NODE_ENV = process.env.NODE_ENV ?? 'development';

for (const file of [`.env.${NODE_ENV}.local`, `.env.${NODE_ENV}`, '.env']) {
  loadEnv({ path: path.join(ROOT, file), override: false, quiet: true });
}

if (NODE_ENV === 'production') {
  console.error('\n✖ La semilla de desarrollo NO se ejecuta en producción.\n');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL },
  },
});

const id = () => uuidv7();

function step(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

const ARGON = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 } as const;

// ═══════════════════════════════════════════════════════════════════════════
//  Catálogo de prueba — una distribuidora de fajas y ropa de compresión
// ═══════════════════════════════════════════════════════════════════════════

interface DevProduct {
  sku: string;
  name: string;
  category: string;
  price: string;
  cost: string;
  stock: string;
  minStock: string;
  barcode?: string;
  tallas?: string[];
}

const CATEGORIES = [
  'Fajas postquirúrgicas',
  'Fajas deportivas',
  'Ropa de compresión',
  'Accesorios',
  'Servicios',
];

const PRODUCTS: DevProduct[] = [
  // Fajas postquirúrgicas — con tallas, para ejercitar los variantes
  {
    sku: 'FJP-001',
    name: 'Faja postquirúrgica completa',
    category: 'Fajas postquirúrgicas',
    price: '1250.00',
    cost: '620.00',
    stock: '12',
    minStock: '4',
    tallas: ['CH', 'M', 'G', 'XG'],
  },
  {
    sku: 'FJP-002',
    name: 'Faja postquirúrgica corta',
    category: 'Fajas postquirúrgicas',
    price: '890.00',
    cost: '430.00',
    stock: '8',
    minStock: '4',
    tallas: ['CH', 'M', 'G'],
  },
  {
    sku: 'FJP-003',
    name: 'Faja abdominal post parto',
    category: 'Fajas postquirúrgicas',
    price: '750.00',
    cost: '360.00',
    stock: '3',
    minStock: '5',
    tallas: ['M', 'G'],
  },
  // Deportivas — producto simple, sin tallas
  {
    sku: 'FJD-010',
    name: 'Faja deportiva de látex',
    category: 'Fajas deportivas',
    price: '580.00',
    cost: '245.00',
    stock: '20',
    minStock: '6',
    barcode: '7501234500101',
  },
  {
    sku: 'FJD-011',
    name: 'Cinturón lumbar de neopreno',
    category: 'Fajas deportivas',
    price: '420.00',
    cost: '175.00',
    stock: '15',
    minStock: '5',
    barcode: '7501234500118',
  },
  {
    sku: 'FJD-012',
    name: 'Faja moldeadora cintura',
    category: 'Fajas deportivas',
    price: '650.00',
    cost: '290.00',
    stock: '2',
    minStock: '6',
    barcode: '7501234500125',
  },
  // Compresión
  {
    sku: 'RPC-020',
    name: 'Medias de compresión graduada',
    category: 'Ropa de compresión',
    price: '480.00',
    cost: '210.00',
    stock: '25',
    minStock: '8',
    barcode: '7501234500200',
  },
  {
    sku: 'RPC-021',
    name: 'Camiseta de compresión',
    category: 'Ropa de compresión',
    price: '520.00',
    cost: '235.00',
    stock: '14',
    minStock: '5',
    barcode: '7501234500217',
  },
  {
    sku: 'RPC-022',
    name: 'Body reductor manga larga',
    category: 'Ropa de compresión',
    price: '980.00',
    cost: '470.00',
    stock: '7',
    minStock: '3',
    barcode: '7501234500224',
  },
  // Accesorios — rotación alta, precios bajos
  {
    sku: 'ACC-030',
    name: 'Tabla abdominal de espuma',
    category: 'Accesorios',
    price: '180.00',
    cost: '65.00',
    stock: '40',
    minStock: '10',
    barcode: '7501234500309',
  },
  {
    sku: 'ACC-031',
    name: 'Espuma moldeadora lumbar',
    category: 'Accesorios',
    price: '150.00',
    cost: '52.00',
    stock: '35',
    minStock: '10',
    barcode: '7501234500316',
  },
  {
    sku: 'ACC-032',
    name: 'Cojín post operatorio',
    category: 'Accesorios',
    price: '320.00',
    cost: '130.00',
    stock: '0',
    minStock: '4',
    barcode: '7501234500323',
  },
  {
    sku: 'ACC-033',
    name: 'Bolsa de tela con logotipo',
    category: 'Accesorios',
    price: '45.00',
    cost: '14.00',
    stock: '120',
    minStock: '20',
    barcode: '7501234500330',
  },
  {
    sku: 'ACC-034',
    name: 'Gel reductor 250 ml',
    category: 'Accesorios',
    price: '260.00',
    cost: '98.00',
    stock: '18',
    minStock: '6',
    barcode: '7501234500347',
  },
];

/** Servicio: NO mueve inventario. Sirve para probar `trackStock = false`. */
const SERVICES: DevProduct[] = [
  {
    sku: 'SRV-001',
    name: 'Asesoría de tallaje',
    category: 'Servicios',
    price: '150.00',
    cost: '0',
    stock: '0',
    minStock: '0',
  },
  {
    sku: 'SRV-002',
    name: 'Ajuste y costura',
    category: 'Servicios',
    price: '220.00',
    cost: '0',
    stock: '0',
    minStock: '0',
  },
];

const CUSTOMERS = [
  {
    type: 'PERSON' as const,
    firstName: 'María',
    lastName: 'Hernández Ruiz',
    phone: '6141234567',
    email: 'maria.hernandez@example.com',
  },
  {
    type: 'PERSON' as const,
    firstName: 'José Luis',
    lastName: 'Domínguez',
    phone: '6149876543',
    email: 'jl.dominguez@example.com',
  },
  {
    type: 'PERSON' as const,
    firstName: 'Ana Sofía',
    lastName: 'Ramírez',
    phone: '6145551234',
    email: null,
  },
  {
    type: 'COMPANY' as const,
    businessName: 'Clínica Estética del Norte',
    rfc: 'CEN120523AB1',
    phone: '6144443322',
    email: 'compras@clinicanorte.example.com',
  },
  {
    type: 'COMPANY' as const,
    businessName: 'Farmacias Bienestar SA de CV',
    rfc: 'FBI980714XY9',
    phone: '6142221100',
    email: 'proveedores@fbienestar.example.com',
  },
];

// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  DATOS DE DESARROLLO — no usar en producción                 ║
╚══════════════════════════════════════════════════════════════╝`);

  const branch = await prisma.branch.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (!branch) {
    throw new Error('No hay sucursales. Ejecuta primero `pnpm db:seed`.');
  }

  const warehouse = await prisma.warehouse.findFirst({
    where: { branchId: branch.id, type: 'SALES_FLOOR', isActive: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  });
  if (!warehouse) throw new Error('La sucursal no tiene almacén de piso de venta.');

  const iva = await prisma.taxRate.findFirst({ where: { code: 'IVA16' } });
  const pieza = await prisma.unit.findFirst({ where: { code: 'PZA' } });

  console.log(`   Sucursal: ${branch.name} · Almacén: ${warehouse.name}`);

  const categoryIds = await seedCategories();
  await seedProducts(categoryIds, warehouse.id, iva?.id ?? null, pieza?.id ?? null);
  await seedCustomers();
  await seedUsers(branch.id);

  console.log('\n✓ Datos de desarrollo listos.\n');
}

async function seedCategories(): Promise<Map<string, string>> {
  step('Categorías');
  const ids = new Map<string, string>();

  for (const [index, name] of CATEGORIES.entries()) {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const category = await prisma.category.upsert({
      where: { slug },
      update: { name, position: index },
      create: { id: id(), name, slug, position: index },
    });
    ids.set(name, category.id);
  }

  console.log(`   ✓ ${CATEGORIES.length} categorías`);
  return ids;
}

async function seedProducts(
  categoryIds: Map<string, string>,
  warehouseId: string,
  taxRateId: string | null,
  unitId: string | null,
): Promise<void> {
  step('Productos, variantes y existencia inicial');

  let productCount = 0;
  let variantCount = 0;
  let ledgerCount = 0;

  const all = [
    ...PRODUCTS.map((p) => ({ ...p, trackStock: true })),
    ...SERVICES.map((p) => ({ ...p, trackStock: false })),
  ];

  for (const item of all) {
    const existing = await prisma.productVariant.findFirst({
      where: { sku: { startsWith: item.sku } },
      select: { id: true },
    });
    if (existing) continue;

    const productId = id();
    const hasVariants = (item.tallas?.length ?? 0) > 0;

    await prisma.product.create({
      data: {
        id: productId,
        name: item.name,
        skuBase: item.sku,
        categoryId: categoryIds.get(item.category) ?? null,
        unitId,
        taxRateId: item.trackStock ? taxRateId : null,
        trackStock: item.trackStock,
        hasVariants,
        isActive: true,
        attributes: { seed: 'dev' },
      },
    });
    productCount++;

    const variants = hasVariants
      ? item.tallas!.map((talla, index) => ({
          id: id(),
          sku: `${item.sku}-${talla}`,
          nameSuffix: talla,
          position: index,
        }))
      : [{ id: id(), sku: item.sku, nameSuffix: null, position: 0 }];

    for (const variant of variants) {
      await prisma.productVariant.create({
        data: {
          id: variant.id,
          productId,
          sku: variant.sku,
          nameSuffix: variant.nameSuffix,
          basePrice: item.price,
          cost: item.cost,
          lastCost: item.cost,
          minStock: item.minStock,
          position: variant.position,
          isActive: true,
        },
      });
      variantCount++;

      if (item.barcode && !hasVariants) {
        await prisma.barcode.create({
          data: { id: id(), variantId: variant.id, code: item.barcode, isPrimary: true },
        });
      }

      if (!item.trackStock) continue;

      // La existencia inicial entra por el KARDEX, no tocando el saldo a mano.
      // Así el inventario de prueba es tan auditable como el de producción.
      const qty = hasVariants
        ? (Number(item.stock) / variants.length).toFixed(3)
        : Number(item.stock).toFixed(3);

      if (Number(qty) <= 0) continue;

      await prisma.stockLedger.create({
        data: {
          id: id(),
          occurredAt: new Date(),
          variantId: variant.id,
          warehouseId,
          condition: StockCondition.GOOD,
          movementType: 'INITIAL_LOAD',
          direction: 'IN',
          qty,
          qtyBefore: '0',
          qtyAfter: qty,
          unitCost: item.cost,
          avgCostAfter: item.cost,
          totalCost: (Number(qty) * Number(item.cost)).toFixed(4),
          referenceType: 'IMPORT',
          reasonCode: 'SEED_DEV',
          notes: 'Existencia inicial de datos de desarrollo',
        },
      });
      ledgerCount++;

      await prisma.stockBalance.create({
        data: {
          variantId: variant.id,
          warehouseId,
          condition: StockCondition.GOOD,
          qtyOnHand: qty,
          qtyReserved: '0',
          avgCost: item.cost,
          lastMovementAt: new Date(),
        },
      });
    }
  }

  console.log(
    `   ✓ ${productCount} productos · ${variantCount} variantes · ${ledgerCount} asientos de existencia inicial`,
  );
}

async function seedCustomers(): Promise<void> {
  step('Clientes');
  let created = 0;

  for (const [index, customer] of CUSTOMERS.entries()) {
    const code = `DEV-C${String(index + 1).padStart(3, '0')}`;
    const existing = await prisma.customer.findUnique({ where: { code } });
    if (existing) continue;

    await prisma.customer.create({
      data: {
        id: id(),
        code,
        type: customer.type,
        firstName: 'firstName' in customer ? customer.firstName : null,
        lastName: 'lastName' in customer ? customer.lastName : null,
        businessName: 'businessName' in customer ? customer.businessName : null,
        rfc: 'rfc' in customer ? customer.rfc : null,
        phone: customer.phone,
        email: customer.email ?? null,
        isActive: true,
      },
    });
    created++;
  }

  console.log(`   ✓ ${created} clientes (código DEV-Cxxx)`);
}

async function seedUsers(branchId: string): Promise<void> {
  step('Usuarios de prueba');

  const users = [
    {
      username: 'cajero',
      email: 'cajero@distribuidora.local',
      name: 'Carla Cajera',
      role: 'CASHIER',
      password: 'Cajero.Demo123',
      pin: '2345',
    },
    {
      username: 'gerente',
      email: 'gerente@distribuidora.local',
      name: 'Gerardo Gerente',
      role: 'MANAGER',
      password: 'Gerente.Demo123',
      pin: '3456',
    },
  ];

  for (const user of users) {
    const existing = await prisma.user.findFirst({ where: { email: user.email } });
    if (existing) {
      console.log(`   · ${user.email} ya existe`);
      continue;
    }

    const role = await prisma.role.findUnique({ where: { code: user.role } });
    if (!role) {
      console.log(`   ! No existe el rol ${user.role}; se omite ${user.email}`);
      continue;
    }

    await prisma.user.create({
      data: {
        id: id(),
        username: user.username,
        email: user.email,
        name: user.name,
        passwordHash: await argon2.hash(user.password, ARGON),
        pinHash: await argon2.hash(user.pin, ARGON),
        status: 'ACTIVE',
        // A diferencia del administrador, estos NO obligan a cambiar la
        // contraseña: son cuentas de prueba y se usan para entrar rápido.
        mustChangePassword: false,
        userRoles: { create: { roleId: role.id } },
        userBranches: { create: { branchId } },
      },
    });

    console.log(`   ✓ ${user.username} (${user.email}) · ${user.password} · PIN ${user.pin} · ${user.role}`);
  }
}

main()
  .catch((error) => {
    console.error('\n✖ Falló la semilla de desarrollo:\n', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
