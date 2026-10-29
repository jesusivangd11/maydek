import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from 'uuid';

/**
 * UUID v7 para todas las llaves primarias.
 *
 * Por qué v7 y no v4 ni autoincremento:
 *   · Ordenable por tiempo → los índices no se fragmentan al insertar, y
 *     `ORDER BY id` equivale a orden cronológico.
 *   · Seguro de exponer → un autoincremento revela cuántas ventas llevas.
 *   · Generable sin conexión → el POS offline puede crear el id del ticket
 *     antes de sincronizar, y ese mismo id sirve de clave de idempotencia.
 */
export function newId(): string {
  return uuidv7();
}

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && uuidValidate(value);
}

/** Acepta v4 y v7: v4 aparece en datos importados de sistemas anteriores. */
export function isSupportedUuid(value: string): boolean {
  if (!uuidValidate(value)) return false;
  const v = uuidVersion(value);
  return v === 7 || v === 4;
}
