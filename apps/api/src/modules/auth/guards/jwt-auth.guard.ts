import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { UnauthenticatedError } from '../../../core/errors/domain-errors';
import { IS_PUBLIC_KEY } from '../decorators/permissions.decorator';

/**
 * Autenticación por JWT de acceso.
 *
 * Se registra como guard GLOBAL: todo endpoint exige sesión salvo que declare
 * `@Public()`. Es lo contrario de la alternativa —proteger endpoint por
 * endpoint— donde olvidar un decorador deja un agujero abierto.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  override handleRequest<T>(err: unknown, user: T): T {
    if (err || !user) {
      throw new UnauthenticatedError();
    }
    return user;
  }
}
