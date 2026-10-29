import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Principal } from '@pv/shared-types';

/**
 * Contexto de la petición en curso.
 *
 * Lo consumen la auditoría y el kardex para saber QUIÉN hizo cada cosa, desde
 * dónde y en qué petición, sin arrastrar esos datos por la firma de cada
 * función del dominio.
 *
 * El `requestId` correlaciona toda la cadena: log de entrada, consultas,
 * asientos de inventario, registros de auditoría y jobs disparados después
 * del commit.
 */
export interface RequestContext {
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
  principal?: Principal;
  branchId?: string;
  terminalId?: string;
  channelId?: string;
  /** Usuario que autorizó con su PIN una acción que excedía el permiso del cajero. */
  authorizedByUserId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Muta el contexto actual. Se usa cuando la identidad se resuelve DESPUÉS de
 * crear el contexto (el guard de autenticación corre después del middleware).
 */
export function setContextValues(values: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (current) Object.assign(current, values);
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Se respeta el X-Request-Id entrante para poder seguir una petición que
    // nació en la página web y terminó aquí.
    const incoming = req.header('x-request-id');
    const requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();

    (req as Request & { id: string }).id = requestId;
    res.setHeader('X-Request-Id', requestId);

    const context: RequestContext = {
      requestId,
      ipAddress: req.ip,
      userAgent: req.header('user-agent'),
    };

    runWithContext(context, () => next());
  }
}
