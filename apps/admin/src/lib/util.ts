import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@pos/lib/api';

/**
 * Utilidades del panel.
 *
 * `useLoad` es el patrón de TODA pantalla de consulta: cargar, mostrar el
 * error en español si falla, y poder recargar después de guardar algo.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'No se pudo conectar con el servidor. Revisa que el sistema esté encendido.';
}

/**
 * Exporta a CSV que Excel abre bien a la primera: BOM UTF-8 para los
 * acentos y punto y coma como separador, que es lo que espera Excel en
 * español de México.
 */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.join(';'), ...rows.map((r) => headers.map((h) => escape(r[h])).join(';'))];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Inicio del día local en ISO, para los filtros de fecha. */
export function startOfDay(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function endOfDay(date: Date): string {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

export function can(permissions: string[], ...codes: string[]): boolean {
  return codes.every((c) => permissions.includes(c));
}
