import { ERROR_CODES, type ErrorCode } from '@pv/shared-types';

/**
 * Errores de dominio.
 *
 * El dominio no conoce HTTP: lanza estos errores y el filtro global los traduce
 * a códigos de estado. Así las mismas reglas sirven para el API, para un job
 * en segundo plano o para una importación.
 *
 * Hacia el cliente sale SIEMPRE: código estable, mensaje entendible y
 * request_id. Nunca stack trace, nunca SQL, nunca nombres de tabla.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends DomainError {
  constructor(message = 'Los datos enviados no son válidos', details?: unknown) {
    super(ERROR_CODES.VALIDATION_ERROR, message, 400, details);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Necesitas iniciar sesión para continuar') {
    super(ERROR_CODES.UNAUTHENTICATED, message, 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(
    message = 'No tienes permiso para realizar esta acción',
    details?: { requiredPermission?: string; branchId?: string },
  ) {
    super(ERROR_CODES.FORBIDDEN, message, 403, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super(
      ERROR_CODES.NOT_FOUND,
      id ? `No se encontró ${entity} con identificador ${id}` : `No se encontró ${entity}`,
      404,
      { entity, id },
    );
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) {
    super(ERROR_CODES.CONFLICT, message, 409, details);
  }
}

/** Edición concurrente: alguien más modificó el registro (If-Match / version). */
export class VersionConflictError extends DomainError {
  constructor(entity: string, expected: number, actual: number) {
    super(
      ERROR_CODES.VERSION_CONFLICT,
      `Otra persona modificó ${entity} mientras lo editabas. Vuelve a cargarlo para no perder su cambio.`,
      409,
      { entity, expectedVersion: expected, actualVersion: actual },
    );
  }
}

export interface InsufficientStockLine {
  variantId: string;
  sku?: string;
  name?: string;
  requested: string;
  available: string;
}

/**
 * Detalle POR LÍNEA, a propósito: permite que la web muestre "solo queda 1 de
 * este artículo" en vez de un genérico "no se pudo procesar tu pedido".
 */
export class InsufficientStockError extends DomainError {
  constructor(lines: InsufficientStockLine[]) {
    super(
      ERROR_CODES.INSUFFICIENT_STOCK,
      'No hay existencia suficiente para completar la operación',
      409,
      lines,
    );
  }
}

export class ReservedStockError extends DomainError {
  constructor(lines: InsufficientStockLine[]) {
    super(
      ERROR_CODES.RESERVED_STOCK,
      'La existencia está apartada para otro pedido',
      409,
      lines,
    );
  }
}

export class ReservationExpiredError extends DomainError {
  constructor(reservationId: string) {
    super(
      ERROR_CODES.RESERVATION_EXPIRED,
      'La reserva venció. Vuelve a consultar la existencia disponible.',
      409,
      { reservationId },
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.IDEMPOTENCY_CONFLICT,
      'Ya se usó esta clave de idempotencia con un contenido distinto. Usa una clave nueva.',
      422,
    );
  }
}

export class IdempotencyInProgressError extends DomainError {
  constructor(readonly retryAfterSeconds = 2) {
    super(
      ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
      'Una petición idéntica se está procesando en este momento. Reintenta en unos segundos.',
      409,
      { retryAfterSeconds },
    );
  }
}

export class CashSessionRequiredError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.CASH_SESSION_REQUIRED,
      'Necesitas abrir la caja de esta terminal antes de cobrar',
      409,
    );
  }
}

export class AccountLockedError extends DomainError {
  constructor(until: Date) {
    super(
      ERROR_CODES.ACCOUNT_LOCKED,
      'La cuenta está bloqueada temporalmente por intentos fallidos',
      423,
      { lockedUntil: until.toISOString() },
    );
  }
}

/** Se pide el PIN de alguien con más permisos en vez de bloquear con un error seco. */
export class AuthorizationRequiredError extends DomainError {
  constructor(requiredPermission: string, reason: string) {
    super(
      ERROR_CODES.AUTHORIZATION_REQUIRED,
      'Esta acción necesita la autorización de un supervisor',
      403,
      { requiredPermission, reason },
    );
  }
}

/** El bloqueo de fila no se obtuvo en el tiempo permitido (lock_timeout). */
export class LockTimeoutError extends DomainError {
  constructor() {
    super(
      ERROR_CODES.LOCK_TIMEOUT,
      'La operación tardó demasiado en obtener el bloqueo. Vuelve a intentar.',
      503,
    );
  }
}
