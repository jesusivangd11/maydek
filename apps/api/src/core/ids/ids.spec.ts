import { describe, expect, it } from 'vitest';
import { isSupportedUuid, isValidId, newId } from './index';

describe('newId — UUID v7', () => {
  it('genera identificadores válidos', () => {
    const id = newId();
    expect(isValidId(id)).toBe(true);
    expect(isSupportedUuid(id)).toBe(true);
  });

  it('no repite', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });

  it('es ordenable por tiempo: el orden lexicográfico es el cronológico', async () => {
    const primero = newId();
    await new Promise((r) => setTimeout(r, 5));
    const segundo = newId();
    expect(primero < segundo).toBe(true);
  });

  it('rechaza valores que no son UUID', () => {
    expect(isValidId('abc')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId(null)).toBe(false);
    expect(isValidId(123)).toBe(false);
  });
});
