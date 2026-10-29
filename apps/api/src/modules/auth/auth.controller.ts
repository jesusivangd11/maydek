import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedUser, PermissionCode } from '@pv/shared-types';
import { UnauthenticatedError } from '../../core/errors/domain-errors';
import { env } from '../../config/env';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/permissions.decorator';
import { AuthorizeDto, ChangePasswordDto, LoginDto, PinLoginDto } from './dto/auth.dto';

/**
 * Los decoradores se evalúan al cargar la clase, así que el límite se lee aquí
 * y no dentro de un método.
 */
const AUTH_LIMIT = env().THROTTLE_AUTH_LIMIT;

const REFRESH_COOKIE = 'pv_refresh';

@ApiTags('Autenticación')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * El token de refresco viaja en cookie httpOnly, nunca en el cuerpo ni en
   * localStorage: así un XSS no puede leerlo.
   */
  private setRefreshCookie(res: Response, token: string): void {
    const config = env();
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: config.COOKIE_SECURE ?? config.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 30 * 24 * 3_600_000,
    });
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Límite estricto: es el endpoint que se ataca por fuerza bruta. Estrecha el
  // bucket global solo para esta ruta.
  @Throttle({ default: { limit: AUTH_LIMIT, ttl: 60_000 } })
  @ApiOperation({ summary: 'Iniciar sesión con correo y contraseña' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent'),
    });

    this.setRefreshCookie(res, result.refreshToken);

    const { refreshToken: _omitted, ...body } = result;
    return body;
  }

  @Public()
  @Post('pin')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: AUTH_LIMIT * 2, ttl: 60_000 } })
  @ApiOperation({ summary: 'Identificarse en el POS con PIN' })
  async loginWithPin(
    @Body() dto: PinLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.loginWithPin(dto.terminalId, dto.pin, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent'),
    });

    this.setRefreshCookie(res, result.refreshToken);

    const { refreshToken: _omitted, ...body } = result;
    return body;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar el token de acceso (rotación)' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token) throw new UnauthenticatedError('No hay sesión activa');

    const result = await this.auth.refresh(token, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent'),
    });

    this.setRefreshCookie(res, result.refreshToken);

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        roles: result.user.roles,
        permissions: result.user.permissions,
        branchIds: result.user.branchIds,
      },
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cerrar sesión' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (token) await this.auth.logout(token);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Get('me')
  @ApiOperation({
    summary: 'Usuario en sesión, con sus permisos efectivos y sucursales',
  })
  me(@CurrentUser() user: AuthenticatedUser) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roles: user.roles,
      permissions: user.permissions,
      branchIds: user.branchIds,
      terminalId: user.terminalId,
    };
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: AUTH_LIMIT * 2, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Autorización de supervisor con PIN para una acción restringida',
  })
  async authorize(@Body() dto: AuthorizeDto) {
    const result = await this.auth.authorize(
      dto.branchId,
      dto.pin,
      dto.permission as PermissionCode,
      dto.reason,
    );
    return { authorizedBy: result };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cambiar la propia contraseña' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changeOwnPassword(user.id, dto.currentPassword, dto.newPassword);
  }
}
