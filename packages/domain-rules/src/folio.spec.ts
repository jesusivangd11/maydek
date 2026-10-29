import { describe, expect, it } from 'vitest';
import { DOC_SERIES, formatFolio, parseFolioInput } from './folio';

describe('formatFolio', () => {
  it('arma el folio documentado', () => {
    expect(formatFolio({ branchCode: 'A', series: DOC_SERIES.SALE, value: 123 })).toBe(
      'A-001-000123',
    );
  });

  it('respeta el relleno solicitado', () => {
    expect(formatFolio({ branchCode: 'A', series: 'DEV', value: 2, padding: 6 })).toBe(
      'A-DEV-000002',
    );
  });

  it('omite la sucursal en documentos que no la llevan', () => {
    expect(formatFolio({ branchCode: null, series: 'REC', value: 12 })).toBe('REC-000012');
  });

  it('no trunca consecutivos mayores al relleno', () => {
    expect(formatFolio({ branchCode: 'A', series: '001', value: 1234567n })).toBe(
      'A-001-1234567',
    );
  });
});

describe('parseFolioInput', () => {
  it('interpreta el folio completo', () => {
    expect(parseFolioInput('A-001-000045')).toEqual({
      branchCode: 'A',
      series: '001',
      consecutive: '000045',
      partial: false,
    });
  });

  it('interpreta serie y consecutivo', () => {
    expect(parseFolioInput('REC-000012')).toEqual({
      series: 'REC',
      consecutive: '000012',
      partial: false,
    });
  });

  it('marca como parcial el consecutivo suelto que teclea el cajero', () => {
    expect(parseFolioInput('45')).toEqual({ consecutive: '45', partial: true });
  });

  it('normaliza mayúsculas y espacios', () => {
    expect(parseFolioInput('  a-001-000045 ').branchCode).toBe('A');
  });

  it('no falla con basura: devuelve parcial para que la búsqueda decida', () => {
    expect(parseFolioInput('???').partial).toBe(true);
    expect(parseFolioInput('').partial).toBe(true);
  });
});
