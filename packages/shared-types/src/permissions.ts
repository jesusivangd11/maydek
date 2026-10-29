/**
 * Catálogo de permisos del sistema.
 *
 * Fuente única de verdad: el backend los aplica con `PermissionsGuard` y los
 * frontends los reciben en `/auth/me`. Ocultar un botón NO es un control de
 * seguridad; el control real es el guard del servidor.
 *
 * Se siembran en la base con `prisma/seed`, para que puedan agruparse en roles
 * a la medida desde la interfaz sin desplegar código.
 */

export const PERMISSIONS = {
  // ── CATÁLOGO ───────────────────────────────────────────────────────────────
  PRODUCT_VIEW: 'product.view',
  PRODUCT_CREATE: 'product.create',
  PRODUCT_UPDATE: 'product.update',
  PRODUCT_ARCHIVE: 'product.archive',
  /** Ver el costo es un permiso APARTE de ver el producto. */
  PRODUCT_COST_VIEW: 'product.cost.view',
  PRODUCT_PRICE_UPDATE: 'product.price.update',
  CATEGORY_MANAGE: 'category.manage',
  BRAND_MANAGE: 'brand.manage',
  BARCODE_MANAGE: 'barcode.manage',

  // ── INVENTARIO ─────────────────────────────────────────────────────────────
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_KARDEX_VIEW: 'inventory.kardex.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_COUNT_CREATE: 'inventory.count.create',
  INVENTORY_COUNT_APPLY: 'inventory.count.apply',
  INVENTORY_TRANSFER_CREATE: 'inventory.transfer.create',
  INVENTORY_TRANSFER_RECEIVE: 'inventory.transfer.receive',
  /** Vender por debajo de cero. Peligroso: solo gerencia. */
  INVENTORY_ALLOW_NEGATIVE: 'inventory.allow_negative',

  // ── VENTAS ─────────────────────────────────────────────────────────────────
  SALE_CREATE: 'sale.create',
  SALE_VIEW: 'sale.view',
  SALE_VIEW_ALL: 'sale.view_all',
  SALE_DISCOUNT_APPLY: 'sale.discount.apply',
  SALE_DISCOUNT_UNLIMITED: 'sale.discount.unlimited',
  SALE_PRICE_OVERRIDE: 'sale.price_override',
  SALE_CANCEL: 'sale.cancel',
  SALE_REPRINT: 'sale.reprint',
  SALE_HOLD: 'sale.hold',

  // ── DEVOLUCIONES ───────────────────────────────────────────────────────────
  RETURN_CREATE: 'return.create',
  RETURN_APPROVE: 'return.approve',
  RETURN_REFUND_CASH: 'return.refund_cash',
  RETURN_OVERRIDE_WINDOW: 'return.override_window',

  // ── CAJA ───────────────────────────────────────────────────────────────────
  CASH_OPEN: 'cash.open',
  CASH_CLOSE: 'cash.close',
  CASH_MOVEMENT_CREATE: 'cash.movement.create',
  CASH_WITHDRAWAL: 'cash.withdrawal',
  CASH_REPORT_X: 'cash.report.x',
  CASH_REPORT_Z: 'cash.report.z',
  CASH_CLOSE_WITH_DIFFERENCE: 'cash.close_with_difference',

  // ── COMPRAS ────────────────────────────────────────────────────────────────
  PURCHASE_VIEW: 'purchase.view',
  PURCHASE_CREATE: 'purchase.create',
  PURCHASE_APPROVE: 'purchase.approve',
  PURCHASE_RECEIVE: 'purchase.receive',
  PURCHASE_COST_UPDATE: 'purchase.cost.update',
  SUPPLIER_VIEW: 'supplier.view',
  SUPPLIER_MANAGE: 'supplier.manage',

  // ── CLIENTES ───────────────────────────────────────────────────────────────
  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_UPDATE: 'customer.update',
  CUSTOMER_CREDIT_MANAGE: 'customer.credit.manage',
  CUSTOMER_ACCOUNT_VIEW: 'customer.account.view',

  // ── PRECIOS ────────────────────────────────────────────────────────────────
  PRICING_VIEW: 'pricing.view',
  PRICING_LIST_MANAGE: 'pricing.list.manage',
  PRICING_PROMOTION_MANAGE: 'pricing.promotion.manage',

  // ── REPORTES ───────────────────────────────────────────────────────────────
  REPORT_SALES: 'report.sales',
  REPORT_INVENTORY: 'report.inventory',
  REPORT_PURCHASES: 'report.purchases',
  /** Ver utilidad implica ver costos. */
  REPORT_PROFIT: 'report.profit',
  REPORT_CASH: 'report.cash',
  REPORT_AUDIT: 'report.audit',
  REPORT_EXPORT: 'report.export',

  // ── ADMINISTRACIÓN ─────────────────────────────────────────────────────────
  USER_VIEW: 'user.view',
  USER_MANAGE: 'user.manage',
  ROLE_MANAGE: 'role.manage',
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_MANAGE: 'settings.manage',
  BRANCH_MANAGE: 'branch.manage',
  WAREHOUSE_MANAGE: 'warehouse.manage',
  TERMINAL_MANAGE: 'terminal.manage',
  API_CLIENT_MANAGE: 'api_client.manage',
  WEBHOOK_MANAGE: 'webhook.manage',
  IMPORT_EXECUTE: 'import.execute',
  BACKUP_MANAGE: 'backup.manage',
  AUDIT_VIEW: 'audit.view',
  /** Atender los tickets que llegan desde la página web. */
  SUPPORT_MANAGE: 'support.manage',

  // ── FISCAL (D2 — se usa en la Fase 13) ─────────────────────────────────────
  FISCAL_VIEW: 'fiscal.view',
  FISCAL_STAMP: 'fiscal.stamp',
  FISCAL_CANCEL: 'fiscal.cancel',
  FISCAL_CONFIGURE: 'fiscal.configure',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: PermissionCode[] = Object.values(PERMISSIONS);

/** Permisos que la interfaz marca en rojo al asignarlos a un rol. */
export const SENSITIVE_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.PRODUCT_COST_VIEW,
  PERMISSIONS.INVENTORY_ADJUST,
  PERMISSIONS.INVENTORY_ALLOW_NEGATIVE,
  PERMISSIONS.SALE_CANCEL,
  PERMISSIONS.SALE_DISCOUNT_UNLIMITED,
  PERMISSIONS.SALE_PRICE_OVERRIDE,
  PERMISSIONS.RETURN_REFUND_CASH,
  PERMISSIONS.RETURN_OVERRIDE_WINDOW,
  PERMISSIONS.CASH_WITHDRAWAL,
  PERMISSIONS.CASH_CLOSE_WITH_DIFFERENCE,
  PERMISSIONS.PURCHASE_COST_UPDATE,
  PERMISSIONS.REPORT_PROFIT,
  PERMISSIONS.USER_MANAGE,
  PERMISSIONS.ROLE_MANAGE,
  PERMISSIONS.API_CLIENT_MANAGE,
  PERMISSIONS.BACKUP_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.FISCAL_STAMP,
  PERMISSIONS.FISCAL_CANCEL,
];

export const PERMISSION_GROUPS: Record<string, string> = {
  product: 'Catálogo',
  category: 'Catálogo',
  brand: 'Catálogo',
  barcode: 'Catálogo',
  inventory: 'Inventario',
  sale: 'Ventas',
  return: 'Devoluciones',
  cash: 'Caja',
  purchase: 'Compras',
  supplier: 'Compras',
  customer: 'Clientes',
  pricing: 'Precios',
  report: 'Reportes',
  user: 'Administración',
  role: 'Administración',
  settings: 'Administración',
  branch: 'Administración',
  warehouse: 'Administración',
  terminal: 'Administración',
  api_client: 'Integración',
  webhook: 'Integración',
  import: 'Administración',
  backup: 'Administración',
  audit: 'Administración',
  support: 'Soporte',
  fiscal: 'Fiscal',
};

export function permissionGroupOf(code: string): string {
  const prefix = code.split('.')[0] ?? '';
  return PERMISSION_GROUPS[prefix] ?? 'Otros';
}
