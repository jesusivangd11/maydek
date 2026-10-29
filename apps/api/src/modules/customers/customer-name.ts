import { CustomerType } from '@prisma/client';

/**
 * Nombre presentable de un cliente.
 *
 * El modelo guarda las partes por separado —nombre, apellido, razón social—
 * porque una persona y una empresa no se nombran igual, y el RFC y el CFDI
 * necesitan los campos separados. Pero el ticket, el POS y el historial solo
 * quieren una cadena. Esta función es la ÚNICA que decide cómo se arma, para
 * que el mismo cliente no aparezca escrito de dos maneras distintas.
 */
export interface CustomerNameParts {
  type?: CustomerType | null;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
  fiscalName?: string | null;
}

export function customerDisplayName(customer: CustomerNameParts | null | undefined): string {
  if (!customer) return 'Público en general';

  if (customer.type === CustomerType.COMPANY) {
    return (
      customer.businessName?.trim() ||
      customer.fiscalName?.trim() ||
      'Empresa sin nombre'
    );
  }

  const full = [customer.firstName, customer.lastName]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');

  return full || customer.businessName?.trim() || customer.fiscalName?.trim() || 'Sin nombre';
}

/** Campos mínimos que hay que traer de la base para poder armar el nombre. */
export const CUSTOMER_NAME_SELECT = {
  type: true,
  firstName: true,
  lastName: true,
  businessName: true,
  fiscalName: true,
} as const;
