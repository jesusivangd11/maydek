import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';

/**
 * Cifrado en reposo (AES-256-GCM) para secretos que el sistema debe poder
 * volver a leer: credenciales de integraciones, secretos de webhook y, en la
 * Fase 13, la contraseña del CSD fiscal.
 *
 * Las contraseñas de usuario NO pasan por aquí: se hashean con argon2id y son
 * irrecuperables por diseño.
 *
 * Formato: v1.<iv>.<authTag>.<ciphertext>, todo en base64url. El prefijo de
 * versión permite rotar el algoritmo sin romper lo ya cifrado.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private static readonly VERSION = 'v1';

  constructor() {
    this.key = Buffer.from(env().ENCRYPTION_KEY, 'base64');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY debe ser exactamente 32 bytes en base64');
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      CryptoService.VERSION,
      iv.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split('.');

    if (version !== CryptoService.VERSION || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Formato de dato cifrado no reconocido');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * Comparación en tiempo constante. Evita que un atacante deduzca un secreto
   * midiendo cuánto tarda la comparación en fallar.
   */
  safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /** Token opaco para llaves de API y tokens de terminal. */
  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}
