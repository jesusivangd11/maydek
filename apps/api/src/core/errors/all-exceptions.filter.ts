import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ERROR_CODES, type ApiErrorBody } from '@pv/shared-types';
import { DomainError } from './domain-errors';

/**
 * Filtro global de excepciones.
 *
 *   Al cliente → código estable, mensaje entendible, request_id.
 *   Al log     → todo el detalle, con el mismo request_id para correlacionar.
 *
 * Nunca sale un stack trace, ni SQL, ni un nombre de tabla. Un mensaje de error
 * de la base de datos es un mapa del esquema para quien lo lea.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as { id?: string }).id ?? request.header('x-request-id');

    const { status, body, logLevel, internal } = this.translate(exception);

    if (requestId) body.error.request_id = requestId;

    const logContext = {
      requestId,
      method: request.method,
      url: request.originalUrl,
      status,
      code: body.error.code,
      userId: (request as { user?: { id?: string } }).user?.id,
    };

    if (logLevel === 'error') {
      this.logger.error(
        { ...logContext, err: internal ?? exception },
        `${body.error.code}: ${body.error.message}`,
      );
    } else {
      this.logger.warn(logContext, `${body.error.code}: ${body.error.message}`);
    }

    // Idempotencia en curso: se le dice al cliente cuándo reintentar.
    if (body.error.code === ERROR_CODES.IDEMPOTENCY_IN_PROGRESS) {
      const details = body.error.details as { retryAfterSeconds?: number } | undefined;
      response.setHeader('Retry-After', String(details?.retryAfterSeconds ?? 2));
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    body: ApiErrorBody;
    logLevel: 'warn' | 'error';
    internal?: unknown;
  } {
    // ── 1 · Errores de dominio: el caso normal ──
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        logLevel: exception.httpStatus >= 500 ? 'error' : 'warn',
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details !== undefined ? { details: exception.details } : {}),
          },
        },
      };
    }

    // ── 2 · Excepciones de Nest (incluye la validación de DTOs) ──
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      let message = exception.message;
      let details: unknown;

      if (typeof payload === 'object' && payload !== null) {
        const p = payload as { message?: unknown; error?: unknown };
        if (Array.isArray(p.message)) {
          message = 'Los datos enviados no son válidos';
          details = p.message;
        } else if (typeof p.message === 'string') {
          message = p.message;
        }
      }

      return {
        status,
        logLevel: status >= 500 ? 'error' : 'warn',
        body: {
          error: {
            code: this.codeForStatus(status),
            message,
            ...(details !== undefined ? { details } : {}),
          },
        },
      };
    }

    // ── 3 · Errores de PostgreSQL vía Prisma ──
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      // Es un bug nuestro: consulta mal construida. Al cliente no le decimos nada.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        logLevel: 'error',
        internal: exception,
        body: {
          error: {
            code: ERROR_CODES.INTERNAL_ERROR,
            message: 'Ocurrió un error al procesar la solicitud',
          },
        },
      };
    }

    // ── 4 · Cualquier otra cosa ──
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      logLevel: 'error',
      internal: exception,
      body: {
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Ocurrió un error al procesar la solicitud',
        },
      },
    };
  }

  private translatePrisma(e: Prisma.PrismaClientKnownRequestError): {
    status: number;
    body: ApiErrorBody;
    logLevel: 'warn' | 'error';
    internal?: unknown;
  } {
    switch (e.code) {
      // Violación de restricción única
      case 'P2002': {
        const target = (e.meta?.target as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        return {
          status: HttpStatus.CONFLICT,
          logLevel: 'warn',
          body: {
            error: {
              code: ERROR_CODES.CONFLICT,
              message: 'Ya existe un registro con esos datos',
              details: { fields },
            },
          },
        };
      }

      // Llave foránea inválida
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          logLevel: 'warn',
          body: {
            error: {
              code: ERROR_CODES.VALIDATION_ERROR,
              message: 'Uno de los registros relacionados no existe',
            },
          },
        };

      // Restricción CHECK: aquí caen los CHECK del inventario.
      // Si esto ocurre es un BUG nuestro que la base atrapó a tiempo — por eso
      // se registra como error, no como aviso.
      case 'P2004':
        return {
          status: HttpStatus.CONFLICT,
          logLevel: 'error',
          internal: e,
          body: {
            error: {
              code: ERROR_CODES.CONFLICT,
              message: 'La operación viola una regla de integridad del sistema',
            },
          },
        };

      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          logLevel: 'warn',
          body: {
            error: {
              code: ERROR_CODES.NOT_FOUND,
              message: 'No se encontró el registro solicitado',
            },
          },
        };

      // Tiempo de espera agotado (lock_timeout / statement_timeout)
      case 'P2024':
      case 'P2034':
        return {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          logLevel: 'warn',
          body: {
            error: {
              code: ERROR_CODES.LOCK_TIMEOUT,
              message: 'La operación tardó demasiado. Vuelve a intentar.',
            },
          },
        };

      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          logLevel: 'error',
          internal: e,
          body: {
            error: {
              code: ERROR_CODES.INTERNAL_ERROR,
              message: 'Ocurrió un error al procesar la solicitud',
            },
          },
        };
    }
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case 400:
        return ERROR_CODES.VALIDATION_ERROR;
      case 401:
        return ERROR_CODES.UNAUTHENTICATED;
      case 403:
        return ERROR_CODES.FORBIDDEN;
      case 404:
        return ERROR_CODES.NOT_FOUND;
      case 409:
        return ERROR_CODES.CONFLICT;
      case 429:
        return ERROR_CODES.RATE_LIMITED;
      default:
        return status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_ERROR;
    }
  }
}
