import { useEffect, useState } from 'react';
import { api, type StoreSettings } from './api';

/**
 * Configuración de la tienda, leída una vez por sesión y compartida.
 *
 * El ticket impreso, la pantalla de venta y la de Configuración la consultan.
 * Se guarda en memoria del módulo: imprimir no puede esperar a la red.
 */

export const DEFAULT_SETTINGS: StoreSettings = {
  'business.name': '',
  'business.legalName': '',
  'business.rfc': '',
  'business.address': '',
  'business.phone': '',
  'business.email': '',
  'ticket.header': '',
  'ticket.footer': '¡Gracias por su compra!',
  'ticket.paper': '80',
  'ticket.showSku': false,
  'ticket.showCashier': true,
  'ticket.showCustomer': true,
  'ticket.showSavings': true,
  'ticket.autoPrint': false,
  'ticket.copies': 1,
  'sales.allowNegativeStock': true,
  'sales.wholesalePriceListId': '',
  'sales.confirmRemove': true,
};

let current: StoreSettings = DEFAULT_SETTINGS;
const listeners = new Set<(s: StoreSettings) => void>();

export function getSettings(): StoreSettings {
  return current;
}

export function setSettings(next: StoreSettings): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Pide la configuración al servidor. Si falla, se queda la que había. */
export async function loadSettings(): Promise<StoreSettings> {
  try {
    setSettings({ ...DEFAULT_SETTINGS, ...(await api.getSettings()) });
  } catch {
    // Sin red o sin sesión: los valores por defecto sirven para vender.
  }
  return current;
}

export function useStoreSettings(): StoreSettings {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
