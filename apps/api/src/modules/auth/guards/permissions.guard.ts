import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionCode, Principal } from '@pv/shared-types';
import { ForbiddenError, UnauthenticatedError } from '../../../core/errors/domain-errors';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
  type PermissionsMode,
} from '../decorators/permissions.decorator';

/**
 * Guard de permisos.
 *
 * ESTE es el control de seguridad. Ocultar un botón en la interfaz no lo es:
 * cualquiera puede llamar al API directamente. Por eso todo endpoint que no sea
 * explícitamente público exige autenticación, y los que declaran permisos los
 * verifican contra los permisos efectivos del usuario resueltos en la base.
 *
 * Un endpoint sin `@RequirePermission` y sin `@Public` queda solo autenticado:
 * es deliberado, para que olvidar el decorador nunca abra un endpoint al mundo.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{ user?: Principal }>();
    const principal = request.user;

    if (!principal) {
      throw new UnauthenticatedError();
    }

    const required = this.reflector.getAllAndOverride<PermissionCode[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    // Los clientes de API no usan permisos de usuario: usan scopes, que valida
    // su propio guard. Aquí se rechazan de plano para que una llave de la web
    // jamás alcance un endpoint del panel administrativo.
    if (principal.kind !== 'user') {
      throw new ForbiddenError(
        'Este endpoint solo admite sesiones de usuario, no llaves de API',
      );
    }

    const mode =
      this.reflector.getAllAndOverride<PermissionsMode>(PERMISSIONS_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'all';

    const owned = new Set(principal.permissions);
    const granted =
      mode === 'any'
        ? required.some((p) => owned.has(p))
        : required.every((p) => owned.has(p));

    if (!granted) {
      const missing = required.filter((p) => !owned.has(p));
      throw new ForbiddenError('No tienes permiso para realizar esta acción', {
        requiredPermission: missing[0],
      });
    }

    return true;
  }
}
