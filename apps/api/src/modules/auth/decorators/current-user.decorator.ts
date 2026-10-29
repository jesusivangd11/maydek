import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthenticatedUser, Principal } from '@pv/shared-types';

/** Inyecta el usuario autenticado en el controlador. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user?: Principal }>();
    const principal = request.user;
    if (!principal || principal.kind !== 'user') {
      throw new Error(
        'CurrentUser se usó en un endpoint sin sesión de usuario. Revisa los guards.',
      );
    }
    return principal;
  },
);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<{ user?: Principal }>().user,
);
