import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import * as argon2 from 'argon2';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';

/**
 * PERMISOS APLICADOS DE VERDAD EN EL BACKEND
 *
 * Estas pruebas levantan el API REAL y hacen peticiones HTTP REALES. No usan
 * el guard aislado ni un doble: montan Nest completo, con sus guards globales,
 * su filtro de excepciones y su base de datos.
 *
 * Es la única forma de comprobar lo que pediste: que un usuario sin permiso
 * **no pueda ejecutar la operación llamando directamente al API**, sin pasar
 * por la interfaz que le oculta el botón.
 */

const OWNER_URL = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const id = () => uuidv7();
const PASSWORD = 'Prueba.Segura2026';

let app: INestApplication;
let http: ReturnType<typeof request>;

let adminToken: string;
let cashierToken: string;
let cashierId: string;

async function crearUsuario(
  email: string,
  roleCode: string,
  branchId: string,
): Promise<string> {
  const role = await owner.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`Falta el rol ${roleCode}: ¿se ejecutó el seed?`);

  const userId = id();
  await owner.user.create({
    data: {
      id: userId,
      email,
      name: `Usuario ${roleCode}`,
      passwordHash: await argon2.hash(PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      }),
      status: 'ACTIVE',
      mustChangePassword: false,
      userRoles: { create: { roleId: role.id } },
      userBranches: { create: { branchId } },
    },
  });
  return userId;
}

async function login(email: string): Promise<string> {
  const res = await http.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`Login falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

beforeAll(async () => {
  await owner.$connect();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  http = request(app.getHttpServer());

  // La sucursal la deja el seed; si no existe, se crea.
  let branch = await owner.branch.findFirst({ where: { deletedAt: null } });
  if (!branch) {
    const company = await owner.company.create({
      data: { id: id(), name: 'E2E', timezone: 'America/Chihuahua' },
    });
    branch = await owner.branch.create({
      data: { id: id(), companyId: company.id, code: 'E2E', name: 'E2E' },
    });
  }

  const sufijo = Date.now();
  const adminEmail = `admin.e2e.${sufijo}@test.local`;
  const cashierEmail = `cajero.e2e.${sufijo}@test.local`;

  await crearUsuario(adminEmail, 'ADMIN', branch.id);
  cashierId = await crearUsuario(cashierEmail, 'CASHIER', branch.id);

  adminToken = await login(adminEmail);
  cashierToken = await login(cashierEmail);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await owner.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════

describe('Autenticación por HTTP', () => {
  it('rechaza credenciales incorrectas sin revelar si el correo existe', async () => {
    const res = await http
      .post('/api/v1/auth/login')
      .send({ email: 'no.existe@test.local', password: 'loquesea123' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    // El mismo mensaje que con contraseña incorrecta: no filtra qué correos existen.
    expect(res.body.error.message).toBe('Correo o contraseña incorrectos');
  });

  it('un endpoint protegido sin token responde 401', async () => {
    const res = await http.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('un token inventado responde 401', async () => {
    const res = await http
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer no.es.un.token.valido');
    expect(res.status).toBe(401);
  });

  it('toda respuesta trae X-Request-Id para poder rastrearla', async () => {
    const res = await http.get('/api/v1/health');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('la respuesta de error incluye el request_id', async () => {
    const res = await http.get('/api/v1/auth/me');
    expect(res.body.error.request_id).toBeTruthy();
  });
});

describe('El API NUNCA devuelve secretos', () => {
  it('/auth/me no expone hashes de contraseña ni PIN', async () => {
    const res = await http
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(200);
    const texto = JSON.stringify(res.body);
    expect(texto).not.toMatch(/passwordHash|password_hash|pinHash|pin_hash|argon2/i);
  });

  it('el listado de usuarios tampoco los expone', async () => {
    const res = await http
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|pinHash|\$argon2/i);
  });
});

describe('★ Un cajero NO puede saltarse sus permisos llamando al API', () => {
  it('el cajero SÍ puede consultar su propia sesión', async () => {
    const res = await http
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('CASHIER');
    expect(res.body.permissions).toContain('sale.create');
  });

  it('el cajero NO tiene los permisos restringidos', async () => {
    const res = await http
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${cashierToken}`);

    for (const prohibido of [
      'product.cost.view',
      'report.profit',
      'inventory.adjust',
      'sale.cancel',
      'user.manage',
      'role.manage',
    ]) {
      expect(res.body.permissions, `no debería tener ${prohibido}`).not.toContain(prohibido);
    }
  });

  it('LISTAR USUARIOS: el cajero recibe 403 aunque llame directo al API', async () => {
    const res = await http
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    // El error dice qué permiso falta, para poder pedir autorización.
    expect(res.body.error.details.requiredPermission).toBe('user.view');
  });

  it('CREAR USUARIOS: el cajero recibe 403', async () => {
    const res = await http
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({
        email: `intruso.${Date.now()}@test.local`,
        name: 'Intruso',
        password: 'Password.Larga123',
        roleCodes: ['ADMIN'],
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('AUTOASIGNARSE ADMIN: el cajero recibe 403', async () => {
    const res = await http
      .patch(`/api/v1/users/${cashierId}/roles`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ roleCodes: ['ADMIN'] });

    expect(res.status).toBe(403);

    // Y lo más importante: sus permisos NO cambiaron.
    const me = await http
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(me.body.roles).toEqual(['CASHIER']);
    expect(me.body.permissions).not.toContain('user.manage');
  });

  it('VER EL CATÁLOGO DE PERMISOS: el cajero recibe 403', async () => {
    const res = await http
      .get('/api/v1/users/permissions')
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.details.requiredPermission).toBe('role.manage');
  });

  it('ARCHIVAR UN USUARIO: el cajero recibe 403', async () => {
    const res = await http
      .post(`/api/v1/users/${cashierId}/archive`)
      .set('Authorization', `Bearer ${cashierToken}`);

    expect(res.status).toBe(403);
  });

  it('el administrador SÍ puede hacer todo lo anterior', async () => {
    const usuarios = await http
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(usuarios.status).toBe(200);

    const permisos = await http
      .get('/api/v1/users/permissions')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(permisos.status).toBe(200);

    const roles = await http
      .get('/api/v1/users/roles')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(roles.status).toBe(200);
    expect(roles.body).toHaveLength(6);
  });
});

describe('Validación de entrada', () => {
  it('rechaza un campo no declarado en el DTO (cierra la asignación masiva)', async () => {
    const res = await http
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `masivo.${Date.now()}@test.local`,
        name: 'Asignación masiva',
        password: 'Password.Larga123',
        roleCodes: ['CASHIER'],
        // Un campo que el DTO no declara: debe hacer fallar la petición entera.
        status: 'ACTIVE',
        deletedAt: null,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rechaza una contraseña demasiado corta con mensaje entendible', async () => {
    const res = await http
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `corta.${Date.now()}@test.local`,
        name: 'Contraseña corta',
        password: 'corta',
        roleCodes: ['CASHIER'],
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/al menos 10 caracteres/);
  });

  it('rechaza crear un usuario sin ningún rol', async () => {
    const res = await http
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `sinrol.${Date.now()}@test.local`,
        name: 'Sin rol',
        password: 'Password.Larga123',
        roleCodes: [],
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/al menos un rol/);
  });
});

describe('Auditoría desde el API real', () => {
  it('un login exitoso queda registrado', async () => {
    const registros = await owner.auditLog.count({ where: { action: 'auth.login' } });
    expect(registros).toBeGreaterThan(0);
  });

  it('un login fallido también queda registrado', async () => {
    await http
      .post('/api/v1/auth/login')
      .send({ email: 'fallido@test.local', password: 'incorrecta123' });

    const registro = await owner.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityLabel: 'fallido@test.local' },
      orderBy: { occurredAt: 'desc' },
    });

    expect(registro).toBeTruthy();
    expect(registro?.reason).toBe('usuario inexistente');
    // Correlaciona con los logs de la petición.
    expect(registro?.requestId).toBeTruthy();
  });

  it('la auditoría NUNCA contiene la contraseña intentada', async () => {
    const registros = await owner.auditLog.findMany({
      where: { action: { in: ['auth.login', 'auth.login_failed'] } },
      take: 50,
      orderBy: { occurredAt: 'desc' },
    });

    const texto = JSON.stringify(registros);
    expect(texto).not.toContain(PASSWORD);
    expect(texto).not.toContain('incorrecta123');
  });

  it('crear un usuario deja rastro con quién lo hizo', async () => {
    const email = `auditado.${Date.now()}@test.local`;

    const res = await http
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        name: 'Usuario auditado',
        password: 'Password.Larga123',
        roleCodes: ['CASHIER'],
      });
    expect(res.status).toBe(201);

    const registro = await owner.auditLog.findFirst({
      where: { action: 'user.create', entityId: res.body.id },
    });
    expect(registro).toBeTruthy();
    expect(registro?.userId).toBeTruthy();
    expect(registro?.entityLabel).toContain(email);
  });
});

describe('Outbox transaccional desde el API real', () => {
  it('crear un usuario emite USER_CREATED en la misma transacción', async () => {
    const res = await http
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `outbox.${Date.now()}@test.local`,
        name: 'Usuario outbox',
        password: 'Password.Larga123',
        roleCodes: ['SALES'],
      });
    expect(res.status).toBe(201);

    const evento = await owner.outboxEvent.findFirst({
      where: { eventType: 'USER_CREATED', aggregateId: res.body.id },
    });

    expect(evento).toBeTruthy();
    // El evento lleva el request_id: se puede seguir la cadena completa.
    expect((evento?.metadata as { requestId?: string })?.requestId).toBeTruthy();
  });
});

describe('Salud del servicio', () => {
  it('/health responde sin autenticación', async () => {
    const res = await http.get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('/health/ready verifica la base de datos de verdad', async () => {
    const res = await http.get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe('ok');
  });
});
