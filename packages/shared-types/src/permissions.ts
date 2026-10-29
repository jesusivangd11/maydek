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

/** Nombre en español de cada permiso, tal como lo ve quien asigna privilegios. */
export const PERMISSION_NAMES: Record<PermissionCode, string> = {
  'product.view': 'Ver productos',
  'product.create': 'Dar de alta productos',
  'product.update': 'Modificar productos',
  'product.archive': 'Archivar productos',
  'product.cost.view': 'Ver el costo de los productos',
  'product.price.update': 'Cambiar precios',
  'category.manage': 'Administrar categorías',
  'brand.manage': 'Administrar marcas',
  'barcode.manage': 'Administrar códigos de barras',
  'inventory.view': 'Ver inventario',
  'inventory.kardex.view': 'Ver movimientos (kárdex)',
  'inventory.adjust': 'Ajustar existencias manualmente',
  'inventory.count.create': 'Capturar conteos físicos',
  'inventory.count.apply': 'Aplicar conteos físicos',
  'inventory.transfer.create': 'Enviar traspasos',
  'inventory.transfer.receive': 'Recibir traspasos',
  'inventory.allow_negative': 'Vender por debajo de cero',
  'sale.create': 'Vender',
  'sale.view': 'Ver sus ventas',
  'sale.view_all': 'Ver las ventas de todos',
  'sale.discount.apply': 'Aplicar descuentos',
  'sale.discount.unlimited': 'Aplicar descuentos sin límite',
  'sale.price_override': 'Cambiar el precio en el ticket',
  'sale.cancel': 'Cancelar ventas',
  'sale.reprint': 'Reimprimir tickets',
  'sale.hold': 'Dejar ventas pendientes',
  'return.create': 'Registrar devoluciones',
  'return.approve': 'Aprobar devoluciones',
  'return.refund_cash': 'Devolver dinero en efectivo',
  'return.override_window': 'Aceptar devoluciones fuera de plazo',
  'cash.open': 'Abrir caja',
  'cash.close': 'Hacer corte de caja',
  'cash.movement.create': 'Registrar entradas y salidas de efectivo',
  'cash.withdrawal': 'Retirar efectivo',
  'cash.report.x': 'Ver corte parcial (X)',
  'cash.report.z': 'Ver corte final (Z)',
  'cash.close_with_difference': 'Cerrar caja con diferencia',
  'purchase.view': 'Ver compras',
  'purchase.create': 'Capturar compras',
  'purchase.approve': 'Aprobar compras',
  'purchase.receive': 'Recibir mercancía',
  'purchase.cost.update': 'Cambiar costos al comprar',
  'supplier.view': 'Ver proveedores',
  'supplier.manage': 'Administrar proveedores',
  'customer.view': 'Ver clientes',
  'customer.create': 'Dar de alta clientes',
  'customer.update': 'Modificar clientes',
  'customer.credit.manage': 'Administrar crédito de clientes',
  'customer.account.view': 'Ver estado de cuenta de clientes',
  'pricing.view': 'Ver listas de precios',
  'pricing.list.manage': 'Administrar listas de precios',
  'pricing.promotion.manage': 'Administrar promociones',
  'report.sales': 'Ver reportes de ventas',
  'report.inventory': 'Ver reportes de inventario',
  'report.purchases': 'Ver reportes de compras',
  'report.profit': 'Ver reportes de utilidad',
  'report.cash': 'Ver reportes de caja',
  'report.audit': 'Ver reporte de auditoría',
  'report.export': 'Exportar reportes',
  'user.view': 'Ver usuarios',
  'user.manage': 'Administrar usuarios',
  'role.manage': 'Administrar roles y permisos',
  'settings.view': 'Ver configuración',
  'settings.manage': 'Cambiar configuración',
  'branch.manage': 'Administrar sucursales',
  'warehouse.manage': 'Administrar almacenes',
  'terminal.manage': 'Administrar cajas (terminales)',
  'api_client.manage': 'Administrar accesos de integración',
  'webhook.manage': 'Administrar avisos automáticos',
  'import.execute': 'Importar datos',
  'backup.manage': 'Administrar respaldos',
  'audit.view': 'Ver bitácora de auditoría',
  'support.manage': 'Atender tickets de soporte',
  'fiscal.view': 'Ver facturas',
  'fiscal.stamp': 'Timbrar facturas',
  'fiscal.cancel': 'Cancelar facturas',
  'fiscal.configure': 'Configurar facturación',
};

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
