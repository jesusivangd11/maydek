import { PERMISSIONS, type PermissionCode, ALL_PERMISSIONS } from './permissions';

/**
 * Los 6 roles del sistema (docs/06-seguridad.md).
 * Son `isSystem`: no se pueden eliminar. Sus permisos SÍ se pueden ajustar
 * desde la interfaz, salvo el de Administrador.
 */
export const ROLES = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  WAREHOUSE: 'WAREHOUSE',
  SALES: 'SALES',
  READONLY: 'READONLY',
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

const P = PERMISSIONS;

/** Cajero: puede vender; NO puede tocar costos, inventario ni precios. */
const CASHIER_PERMISSIONS: PermissionCode[] = [
  P.PRODUCT_VIEW,
  P.INVENTORY_VIEW,
  P.PRICING_VIEW,
  P.CUSTOMER_VIEW,
  P.CUSTOMER_CREATE,
  P.SALE_CREATE,
  P.SALE_VIEW,
  P.SALE_DISCOUNT_APPLY,
  P.SALE_REPRINT,
  P.SALE_HOLD,
  P.RETURN_CREATE,
  P.CASH_OPEN,
  P.CASH_CLOSE,
  P.CASH_MOVEMENT_CREATE,
  P.CASH_REPORT_X,
  P.CASH_REPORT_Z,
];

/** Almacén: inventario y recepción; sin ventas ni precios. */
const WAREHOUSE_PERMISSIONS: PermissionCode[] = [
  P.PRODUCT_VIEW,
  P.PRODUCT_CREATE,
  P.PRODUCT_UPDATE,
  P.BARCODE_MANAGE,
  P.CATEGORY_MANAGE,
  P.BRAND_MANAGE,
  P.INVENTORY_VIEW,
  P.INVENTORY_KARDEX_VIEW,
  P.INVENTORY_ADJUST,
  P.INVENTORY_COUNT_CREATE,
  P.INVENTORY_COUNT_APPLY,
  P.INVENTORY_TRANSFER_CREATE,
  P.INVENTORY_TRANSFER_RECEIVE,
  P.PURCHASE_VIEW,
  P.PURCHASE_RECEIVE,
  P.SUPPLIER_VIEW,
  P.REPORT_INVENTORY,
];

/** Ventas: consulta y cotiza; no cobra. */
const SALES_PERMISSIONS: PermissionCode[] = [
  P.PRODUCT_VIEW,
  P.INVENTORY_VIEW,
  P.PRICING_VIEW,
  P.CUSTOMER_VIEW,
  P.CUSTOMER_CREATE,
  P.CUSTOMER_UPDATE,
  P.CUSTOMER_ACCOUNT_VIEW,
  P.SALE_VIEW,
  P.REPORT_SALES,
];

/** Solo lectura: para contador o auditor externo. Sin utilidad ni costos. */
const READONLY_PERMISSIONS: PermissionCode[] = [
  P.PRODUCT_VIEW,
  P.INVENTORY_VIEW,
  P.INVENTORY_KARDEX_VIEW,
  P.PRICING_VIEW,
  P.CUSTOMER_VIEW,
  P.CUSTOMER_ACCOUNT_VIEW,
  P.SALE_VIEW,
  P.SALE_VIEW_ALL,
  P.PURCHASE_VIEW,
  P.SUPPLIER_VIEW,
  P.REPORT_SALES,
  P.REPORT_INVENTORY,
  P.REPORT_PURCHASES,
  P.REPORT_CASH,
];

/** Gerente: todo salvo administración de usuarios, respaldos y llaves de API. */
const MANAGER_EXCLUDED: PermissionCode[] = [
  P.USER_MANAGE,
  P.ROLE_MANAGE,
  P.API_CLIENT_MANAGE,
  P.WEBHOOK_MANAGE,
  P.BACKUP_MANAGE,
  P.FISCAL_CONFIGURE,
];

const MANAGER_PERMISSIONS: PermissionCode[] = ALL_PERMISSIONS.filter(
  (p) => !MANAGER_EXCLUDED.includes(p),
);

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  description: string;
  permissions: PermissionCode[];
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: ROLES.ADMIN,
    name: 'Administrador',
    description:
      'Acceso total. MFA obligatorio. No se puede eliminar el último administrador.',
    permissions: ALL_PERMISSIONS,
  },
  {
    code: ROLES.MANAGER,
    name: 'Gerente',
    description:
      'Todo excepto gestión de usuarios, respaldos, llaves de API y configuración fiscal.',
    permissions: MANAGER_PERMISSIONS,
  },
  {
    code: ROLES.CASHIER,
    name: 'Cajero',
    description:
      'Vende, cobra y opera su caja. No ve costos ni utilidad, no ajusta inventario, no archiva productos, no cambia precios de lista.',
    permissions: CASHIER_PERMISSIONS,
  },
  {
    code: ROLES.WAREHOUSE,
    name: 'Almacén',
    description:
      'Inventario, conteos, transferencias y recepción de compras. Sin ventas ni precios.',
    permissions: WAREHOUSE_PERMISSIONS,
  },
  {
    code: ROLES.SALES,
    name: 'Ventas',
    description:
      'Consulta catálogo y existencias, gestiona clientes y cotiza. No cobra.',
    permissions: SALES_PERMISSIONS,
  },
  {
    code: ROLES.READONLY,
    name: 'Solo lectura',
    description:
      'Consulta y reportes sin utilidad ni costos. Para contadores o auditores externos.',
    permissions: READONLY_PERMISSIONS,
  },
];
