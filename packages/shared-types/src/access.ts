/**
 * Cómo se entra al sistema: USUARIO + CLAVE.
 *
 *   · Usuario: corto, sin importar mayúsculas («Carla» = «carla»). Se guarda y
 *     se busca siempre en minúsculas.
 *   · Clave: a elección de cada persona, un PIN de al menos 4 dígitos
 *     («2580») o una contraseña de al menos 8 caracteres. La clave SÍ distingue
 *     mayúsculas: es lo único que protege la cuenta.
 *
 * Las pantallas tienen una copia mínima de estas reglas (apps/pos/src/lib/
 * access.ts) para avisar antes de enviar; el servidor es quien manda.
 */

/** 3 a 32 caracteres: letras, números, punto, guion y guion bajo. */
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export const PIN_PATTERN = /^\d{4,12}$/;
export const PASSWORD_MIN_LENGTH = 8;
export const ACCESS_KEY_MAX_LENGTH = 200;

export const ACCESS_KEY_MESSAGE =
  'La clave debe ser un PIN de al menos 4 dígitos o una contraseña de al menos 8 caracteres';

export const USERNAME_MESSAGE =
  'El usuario debe tener de 3 a 32 caracteres: letras, números, punto, guion o guion bajo';

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isPin(key: string): boolean {
  return PIN_PATTERN.test(key);
}

export function isValidAccessKey(key: string): boolean {
  return key.length <= ACCESS_KEY_MAX_LENGTH && (isPin(key) || key.length >= PASSWORD_MIN_LENGTH);
}
