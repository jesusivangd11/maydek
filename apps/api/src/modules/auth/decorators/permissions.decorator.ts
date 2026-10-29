import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { PermissionCode } from '@pv/shared-types';

export const PERMISSIONS_KEY = 'pv:permissions';
export const PERMISSIONS_MODE_KEY = 'pv:permissions_mode';
export const IS_PUBLIC_KEY = 'pv:public';

export type PermissionsMode = 'all' | 'any';

/**
 * Exige TODOS los permisos indicados.
 *
 *   @RequirePermission(PERMISSIONS.PRODUCT_COST_VIEW)
 *   @RequirePermission(PERMISSIONS.SALE_CREATE, PERMISSIONS.CASH_OPEN)
 */
export function RequirePermission(...permissions: PermissionCode[]) {
  return applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'all' satisfies PermissionsMode),
  );
}

/** Basta con UNO de los permisos indicados. */
export function RequireAnyPermission(...permissions: PermissionCode[]) {
  return applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'any' satisfies PermissionsMode),
  );
}

/**
 * Endpoint público: sin autenticación.
 * Úsalo con cuidado y solo donde de verdad corresponda (login, salud).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
