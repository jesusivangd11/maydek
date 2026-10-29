import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { PERMISSIONS, ROLE_DEFINITIONS, ROLES, type PermissionCode } from '@pv/shared-types';
import { describe, expect, it } from 'vitest';
import { ForbiddenError, UnauthenticatedError } from '../../src/core/errors/domain-errors';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
} from '../../src/modules/auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../../src/modules/auth/guards/permissions.guard';

/**
 * Estas pruebas son el corazón del requisito "permisos aplicados realmente en
 * el backend, no solamente ocultando opciones en la interfaz".
 */

function makeContext(user: unknown, metadata: Record<string, unknown>): {
  context: ExecutionContext;
  guard: PermissionsGuard;
} {
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;

  const context = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { context, guard: new PermissionsGuard(reflector) };
}

function userWith(permissions: PermissionCode[]) {
  return {
    kind: 'user' as const,
    id: '01900000-0000-7000-8000-000000000001',
    email: 'cajero@test.local',
    name: 'Cajero',
    roles: [ROLES.CASHIER],
    permissions,
    branchIds: ['01900000-0000-7000-8000-0000000000b1'],
  };
}

describe('PermissionsGuard', () => {
  it('deja pasar los endpoints marcados como públicos, incluso sin sesión', () => {
    const { guard, context } = makeContext(undefined, { [IS_PUBLIC_KEY]: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rechaza sin sesión cuando el endpoint no es público', () => {
    const { guard, context } = makeContext(undefined, {});
    expect(() => guard.canActivate(context)).toThrow(UnauthenticatedError);
  });

  it('permite el acceso cuando el usuario tiene el permiso exigido', () => {
    const { guard, context } = makeContext(userWith([PERMISSIONS.SALE_CREATE]), {
      [PERMISSIONS_KEY]: [PERMISSIONS.SALE_CREATE],
      [PERMISSIONS_MODE_KEY]: 'all',
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('BLOQUEA cuando le falta el permiso, aunque esté autenticado', () => {
    const { guard, context } = makeContext(userWith([PERMISSIONS.SALE_CREATE]), {
      [PERMISSIONS_KEY]: [PERMISSIONS.PRODUCT_COST_VIEW],
      [PERMISSIONS_MODE_KEY]: 'all',
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('en modo "all" exige TODOS los permisos', () => {
    const { guard, context } = makeContext(userWith([PERMISSIONS.SALE_CREATE]), {
      [PERMISSIONS_KEY]: [PERMISSIONS.SALE_CREATE, PERMISSIONS.CASH_OPEN],
      [PERMISSIONS_MODE_KEY]: 'all',
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('en modo "any" basta con uno', () => {
    const { guard, context } = makeContext(userWith([PERMISSIONS.SALE_CREATE]), {
      [PERMISSIONS_KEY]: [PERMISSIONS.SALE_CREATE, PERMISSIONS.CASH_OPEN],
      [PERMISSIONS_MODE_KEY]: 'any',
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('informa cuál es el permiso que falta, para poder pedir autorización', () => {
    const { guard, context } = makeContext(userWith([]), {
      [PERMISSIONS_KEY]: [PERMISSIONS.RETURN_REFUND_CASH],
      [PERMISSIONS_MODE_KEY]: 'all',
    });

    try {
      guard.canActivate(context);
      expect.unreachable('debió lanzar ForbiddenError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).details).toMatchObject({
        requiredPermission: PERMISSIONS.RETURN_REFUND_CASH,
      });
    }
  });

  it('una llave de API no puede alcanzar endpoints del panel administrativo', () => {
    const apiClient = {
      kind: 'api_client' as const,
      id: '01900000-0000-7000-8000-0000000000c1',
      name: 'Página web',
      scopes: ['catalog:read', 'stock:read'],
    };

    const { guard, context } = makeContext(apiClient, {
      [PERMISSIONS_KEY]: [PERMISSIONS.PRODUCT_COST_VIEW],
      [PERMISSIONS_MODE_KEY]: 'all',
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenError);
  });

  it('un endpoint sin permisos declarados solo exige estar autenticado', () => {
    const { guard, context } = makeContext(userWith([]), {});
    expect(guard.canActivate(context)).toBe(true);
  });
});

describe('Definición de roles — lo que el requisito 19 exige del Cajero', () => {
  const cashier = ROLE_DEFINITIONS.find((r) => r.code === ROLES.CASHIER)!;
  const admin = ROLE_DEFINITIONS.find((r) => r.code === ROLES.ADMIN)!;
  const manager = ROLE_DEFINITIONS.find((r) => r.code === ROLES.MANAGER)!;

  it('el Cajero PUEDE vender, cobrar y operar su caja', () => {
    for (const permission of [
      PERMISSIONS.SALE_CREATE,
      PERMISSIONS.SALE_REPRINT,
      PERMISSIONS.SALE_HOLD,
      PERMISSIONS.CASH_OPEN,
      PERMISSIONS.CASH_CLOSE,
      PERMISSIONS.RETURN_CREATE,
    ]) {
      expect(cashier.permissions, `falta ${permission}`).toContain(permission);
    }
  });

  it('el Cajero NO PUEDE ver costos ni utilidad', () => {
    expect(cashier.permissions).not.toContain(PERMISSIONS.PRODUCT_COST_VIEW);
    expect(cashier.permissions).not.toContain(PERMISSIONS.REPORT_PROFIT);
  });

  it('el Cajero NO PUEDE ajustar inventario manualmente', () => {
    expect(cashier.permissions).not.toContain(PERMISSIONS.INVENTORY_ADJUST);
    expect(cashier.permissions).not.toContain(PERMISSIONS.INVENTORY_ALLOW_NEGATIVE);
  });

  it('el Cajero NO PUEDE archivar productos ni cambiar precios de lista', () => {
    expect(cashier.permissions).not.toContain(PERMISSIONS.PRODUCT_ARCHIVE);
    expect(cashier.permissions).not.toContain(PERMISSIONS.PRODUCT_PRICE_UPDATE);
    expect(cashier.permissions).not.toContain(PERMISSIONS.PRICING_LIST_MANAGE);
  });

  it('el Cajero NO PUEDE cancelar ventas ni devolver efectivo sin autorización', () => {
    expect(cashier.permissions).not.toContain(PERMISSIONS.SALE_CANCEL);
    expect(cashier.permissions).not.toContain(PERMISSIONS.RETURN_REFUND_CASH);
    expect(cashier.permissions).not.toContain(PERMISSIONS.CASH_CLOSE_WITH_DIFFERENCE);
  });

  it('el Cajero NO PUEDE ver ventas de otros ni administrar usuarios', () => {
    expect(cashier.permissions).not.toContain(PERMISSIONS.SALE_VIEW_ALL);
    expect(cashier.permissions).not.toContain(PERMISSIONS.USER_MANAGE);
  });

  it('el Administrador tiene todos los permisos', () => {
    expect(admin.permissions.length).toBe(Object.values(PERMISSIONS).length);
  });

  it('el Gerente tiene todo salvo usuarios, respaldos, API y config fiscal', () => {
    for (const excluded of [
      PERMISSIONS.USER_MANAGE,
      PERMISSIONS.ROLE_MANAGE,
      PERMISSIONS.API_CLIENT_MANAGE,
      PERMISSIONS.BACKUP_MANAGE,
      PERMISSIONS.FISCAL_CONFIGURE,
    ]) {
      expect(manager.permissions, `no debería tener ${excluded}`).not.toContain(excluded);
    }
    expect(manager.permissions).toContain(PERMISSIONS.PRODUCT_COST_VIEW);
    expect(manager.permissions).toContain(PERMISSIONS.REPORT_PROFIT);
  });

  it('los 6 roles están definidos y ningún permiso está inventado', () => {
    expect(ROLE_DEFINITIONS).toHaveLength(6);
    const valid = new Set<string>(Object.values(PERMISSIONS));
    for (const role of ROLE_DEFINITIONS) {
      for (const permission of role.permissions) {
        expect(valid.has(permission), `${role.code}: permiso inexistente ${permission}`).toBe(true);
      }
    }
  });
});
