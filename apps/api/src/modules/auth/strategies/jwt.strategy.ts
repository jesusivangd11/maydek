import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser } from '@pv/shared-types';
import { UnauthenticatedError } from '../../../core/errors/domain-errors';
import { setContextValues } from '../../../core/request-context/request-context';
import { env } from '../../../config/env';
import { AuthService } from '../auth.service';

interface JwtPayload {
  sub: string;
  email: string;
  terminalId?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly auth: AuthService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env().JWT_ACCESS_SECRET,
    });
  }

  /**
   * Los permisos se resuelven contra la BASE en cada petición, no se leen del
   * token. Si a alguien se le retira un permiso, lo pierde de inmediato y no
   * cuando caduque su token de 15 minutos.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const principal = await this.auth.buildPrincipal(payload.sub).catch(() => null);

    if (!principal) {
      throw new UnauthenticatedError('La sesión ya no es válida');
    }

    if (payload.terminalId) principal.terminalId = payload.terminalId;

    // Se enriquece el contexto para la auditoría y el kardex.
    setContextValues({
      principal,
      terminalId: principal.terminalId,
      branchId: principal.branchIds[0],
    });

    return principal;
  }
}
