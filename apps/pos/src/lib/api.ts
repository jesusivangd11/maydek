/**
 * Cliente del API.
 *
 * En la Fase 9 se sustituye por un cliente GENERADO desde el contrato OpenAPI:
 * así, cambiar el API rompe la compilación del frontend en CI en vez de romper
 * la tienda en producción. Este cliente escrito a mano es el mínimo para
 * trabajar mientras tanto.
 *
 * El token de acceso vive en memoria, nunca en localStorage: un XSS no puede
 * leerlo. El de refresco viaja en cookie httpOnly, que el navegador manda solo.
 */

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3100/api/v1';

export interface ApiErrorBody {
  error: { code: string; message: string; request_id?: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Interno: evita bucles infinitos al renovar el token. */
  skipRefresh?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    // Necesario para que viaje la cookie del token de refresco.
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  // 401: se intenta renovar UNA vez y se repite la petición original.
  if (response.status === 401 && !options.skipRefresh) {
    const renewed = await tryRefresh();
    if (renewed) {
      return request<T>(path, { ...options, skipRefresh: true });
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as ApiErrorBody | T | null;

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? 'Ocurrió un error inesperado',
      error?.request_id,
      error?.details,
    );
  }

  return payload as T;
}

async function tryRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) return false;

    const data = (await response.json()) as { accessToken: string };
    setAccessToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tipos del dominio
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  branchIds: string[];
  mustChangePassword?: boolean;
}

export interface CatalogItem {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  productName: string;
  barcode: string | null;
  category: { id: string; name: string } | null;
  unit: string;
  imageUrl: string | null;
  unitPrice: string;
  priceIncludesTax: boolean;
  taxRate: string;
  trackStock: boolean;
  qtyAvailable: string;
  isOut: boolean;
  /** Mínimo configurado en la variante. `null` = sin umbral definido. */
  minStock: string | null;
  /** Hay existencia, pero está en el mínimo o por debajo. */
  isLow: boolean;
  cost?: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  isActive: boolean;
  productCount: number;
}

export interface CashSession {
  id: string;
  folio: string;
  status: 'OPEN' | 'CLOSED' | 'SUSPENDED';
  branch: { id: string; name: string };
  terminal: { id: string; name: string; code: string };
  openedBy: { id: string; name: string };
  closedBy: { id: string; name: string } | null;
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  expectedCash: string;
  countedCash: string | null;
  difference: string | null;
  differenceReason: string | null;
  totalsByMethod: { code: string; name: string; affectsCash: boolean; total: string }[];
  sales: { count: number; total: string; average: string };
  movements: {
    id: string;
    type: string;
    amount: string;
    reason: string | null;
    reference: string | null;
    occurredAt: string;
    user: { id: string; name: string };
  }[];
}

export interface SaleSummary {
  id: string;
  folio: string;
  status: string;
  occurredAt: string;
  total: string;
  itemCount: number;
  cashier: { id: string; name: string } | null;
  customer: { id: string; name: string } | null;
  paymentMethods: string[];
}

export interface SaleDetail {
  id: string;
  folio: string;
  status: string;
  occurredAt: string;
  branch: { id: string; name: string; code: string };
  issuer?: {
    name: string;
    legalName: string | null;
    rfc: string | null;
    phone: string | null;
    address: string | null;
  };
  balanceDue?: string;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  terminal: { id: string; name: string } | null;
  cashier: { id: string; name: string } | null;
  customer: { id: string; name: string; rfc: string | null; phone: string | null } | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  changeGiven: string;
  costTotal?: string;
  profit?: string;
  notes: string | null;
  items: {
    id: string;
    lineNumber: number;
    variantId: string;
    sku: string;
    name: string;
    qty: string;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    lineSubtotal: string;
    lineTotal: string;
    returnedQty: string;
    unitCost?: string;
  }[];
  payments: {
    methodCode: string;
    methodName: string;
    amount: string;
    reference: string | null;
    status?: string;
  }[];
}

export interface Customer {
  id: string;
  code: string | null;
  type: 'PERSON' | 'COMPANY';
  name: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  rfc: string | null;
  fiscalName: string | null;
  fiscalPostalCode: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  priceList: { id: string; code: string; name: string } | null;
  creditLimit: string;
  creditDays: number;
  balance: string;
  creditAvailable: string;
  tags: string[];
  notes: string | null;
  totalPurchased: string;
  purchaseCount: number;
  averageTicket: string;
  lastPurchaseAt: string | null;
  isActive: boolean;
}

export interface CustomerDetail extends Customer {
  recentSales: { id: string; folio: string; status: string; total: string; occurredAt: string }[];
  creditNotes: { folio: string; available: string; expiresAt: string | null }[];
}

export interface CustomerInput {
  type?: 'PERSON' | 'COMPANY';
  code?: string;
  firstName?: string;
  lastName?: string;
  businessName?: string;
  rfc?: string;
  fiscalName?: string;
  fiscalPostalCode?: string;
  phone?: string;
  email?: string;
  address?: string;
  priceListId?: string | null;
  creditLimit?: string;
  creditDays?: number;
  notes?: string;
  isActive?: boolean;
}

export interface AccountStatement {
  customer: { id: string; name: string; creditLimit: string };
  balance: string;
  entries: {
    id: string;
    type: string;
    amount: string;
    balanceAfter: string;
    referenceFolio: string | null;
    notes: string | null;
    occurredAt: string;
  }[];
}

export interface HeldSale {
  id: string;
  label: string | null;
  cart: { lines: unknown[]; customer?: { id: string; name: string } | null };
  createdAt: string;
  expiresAt: string | null;
  user?: { id: string; name: string };
}

export interface ReturnDetail {
  id: string;
  folio: string;
  type: 'REFUND' | 'STORE_CREDIT' | 'EXCHANGE';
  occurredAt: string;
  sale: { id: string; folio: string };
  customer: { id: string; name: string } | null;
  reasonCode: string | null;
  total: string;
  items: { id: string; sku: string; name: string; qty: string; lineTotal: string; condition: string }[];
  refunds: { methodCode: string; methodName: string; amount: string }[];
  creditNote: { folio: string; amount: string; expiresAt: string | null } | null;
}

export interface CreditNoteInfo {
  folio: string;
  amount: string;
  available: string;
  status: string;
  expiresAt: string | null;
  customer: { id: string; name: string } | null;
}

export interface PriceList {
  id: string;
  code: string;
  name: string;
  includesTax: boolean;
  isActive: boolean;
  itemCount: number;
  customerCount: number;
}

export interface PriceListItem {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  basePrice: string;
  price: string;
  minQty: string;
}

export interface ProductVariantRow {
  id: string;
  sku: string;
  nameSuffix: string | null;
  barcode?: string | null;
  basePrice: string;
  minStock: string | null;
  isActive: boolean;
  cost?: string;
}

export interface ProductRow {
  id: string;
  name: string;
  skuBase: string | null;
  isActive: boolean;
  trackStock: boolean;
  hasVariants: boolean;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  unit: { code: string; name: string } | null;
  taxRate: string | null;
  variants: ProductVariantRow[];
}

export interface ProductDetail {
  id: string;
  name: string;
  description: string | null;
  skuBase: string | null;
  isActive: boolean;
  trackStock: boolean;
  hasVariants: boolean;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  unit: { id: string; code: string; name: string } | null;
  taxRate: { id: string; code: string; name: string; rate: string } | null;
  variants: (ProductVariantRow & {
    barcodes: { id: string; code: string; isPrimary: boolean }[];
    stock: { warehouseId: string; qtyOnHand: string; qtyAvailable: string }[];
  })[];
}

export interface ProductInput {
  name: string;
  description?: string;
  sku?: string;
  barcode?: string;
  basePrice?: string;
  minStock?: string;
  categoryId?: string;
  unitId?: string;
  taxRateId?: string;
  trackStock?: boolean;
  variants?: { sku: string; nameSuffix?: string; basePrice?: string; minStock?: string; barcode?: string }[];
}

export interface CatalogOptions {
  units: { id: string; code: string; name: string }[];
  taxRates: { id: string; code: string; name: string; rate: string; isDefault: boolean }[];
  brands: { id: string; name: string }[];
}

export interface KardexEntry {
  id: string;
  occurredAt: string;
  movementType: string;
  direction: 'IN' | 'OUT';
  qty: string;
  qtyBefore: string;
  qtyAfter: string;
  unitCost?: string | null;
  referenceType: string | null;
  reference: string | null;
  reasonCode: string | null;
  notes: string | null;
  user: { id: string; name: string } | null;
}

export interface Supplier {
  id: string;
  code: string | null;
  businessName: string;
  tradeName: string | null;
  rfc: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  notes: string | null;
  isActive: boolean;
  orderCount: number;
}

export interface PurchaseOrderRow {
  id: string;
  folio: string;
  status: string;
  supplier: { id: string; businessName: string };
  total: string;
  expectedDate: string | null;
  createdAt: string;
  qtyOrdered: string;
  qtyReceived: string;
}

export interface PurchaseOrderDetail {
  id: string;
  folio: string;
  status: string;
  supplier: { id: string; businessName: string; phone: string | null; email: string | null };
  expectedDate: string | null;
  subtotal: string;
  shippingCost: string;
  total: string;
  notes: string | null;
  createdAt: string;
  items: {
    id: string;
    variantId: string;
    sku: string;
    name: string;
    qtyOrdered: string;
    qtyReceived: string;
    qtyPending: string;
    unitCost: string;
    lineTotal: string;
  }[];
  receipts: { id: string; folio: string; receivedAt: string; supplierInvoiceNumber: string | null }[];
}

export interface PurchaseSuggestion {
  variantId: string;
  sku: string;
  name: string;
  minStock: string;
  available: string;
  suggestedQty: string;
  lastCost: string;
}

export interface Dashboard {
  range: { from: string; to: string; timezone: string };
  sales: { count: number; total: string; averageTicket: string; discount: string; tax: string };
  returns: { count: number; total: string };
  cancelled: { count: number; total: string };
  netTotal: string;
  profit?: { netSales: string; cost: string; grossProfit: string; margin: string };
  byDay: { day: string; count: number; total: string; profit?: string }[];
  byHour: { hour: number; count: number; total: string }[];
  byMethod: { code: string; name: string; count: number; total: string }[];
  byCashier: { id: string; name: string; count: number; total: string }[];
  byCategory: { category: string; qty: string; total: string; profit?: string }[];
  topProducts: { variantId: string; sku: string; name: string; qty: string; total: string; profit?: string }[];
  inventory: { value?: string; units: string; lowStock: number; outOfStock: number };
  receivables: { total: string; customers: number };
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  status: string;
  roles: { code: string; name: string }[];
  lastLoginAt?: string | null;
}

export interface SupportTicket {
  id: string;
  folio: string;
  kind: 'SUPPORT' | 'SALES' | 'CONTACT';
  status: 'OPEN' | 'IN_PROGRESS' | 'ANSWERED' | 'CLOSED';
  priority: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  plan: string | null;
  subject: string;
  message: string;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface StockRow {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  category: { id: string; name: string } | null;
  unit: { code: string; name: string } | null;
  trackStock: boolean;
  isActive: boolean;
  price: string;
  qtyOnHand: string;
  qtyAvailable: string;
  minStock: string | null;
  isLow: boolean;
  isOut: boolean;
  lastMovementAt: string | null;
  cost?: string;
  stockValue?: string;
}

export interface SaleLineInput {
  variantId: string;
  qty: string;
  unitPrice?: string;
  discountAmount?: string;
  discountReason?: string;
}

export interface SalePaymentInput {
  methodCode: string;
  amount: string;
  reference?: string;
}

// ═══════════════════════════════════════════════════════════════════════════

export const api = {
  // ── Sesión ──
  login: (email: string, password: string) =>
    request<{ accessToken: string; expiresIn: number; user: SessionUser }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      skipRefresh: true,
    }),

  refresh: () =>
    request<{ accessToken: string; expiresIn: number; user: SessionUser }>('/auth/refresh', {
      method: 'POST',
      skipRefresh: true,
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST', skipRefresh: true }),

  me: () => request<SessionUser>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  // ── Catálogo ──
  posSearch: (params: { q?: string; categoryId?: string; limit?: number; customerId?: string }) =>
    request<{ exactBarcode: boolean; warehouseId: string; data: CatalogItem[] }>(
      `/pos/search${toQuery(params)}`,
    ),

  listCategories: (includeInactive = false) =>
    request<Category[]>(`/categories${toQuery({ includeInactive: includeInactive || undefined })}`),

  createCategory: (body: { name: string; parentId?: string }) =>
    request<Category>('/categories', { method: 'POST', body }),

  updateCategory: (id: string, body: { name?: string; isActive?: boolean }) =>
    request<Category>(`/categories/${id}`, { method: 'PATCH', body }),

  catalogOptions: () => request<CatalogOptions>('/catalog/options'),

  listProducts: (params: { search?: string; categoryId?: string; includeInactive?: boolean; limit?: number; cursor?: string }) =>
    request<{ data: ProductRow[]; nextCursor: string | null }>(`/products${toQuery(params)}`),

  getProduct: (id: string) => request<ProductDetail>(`/products/${id}`),

  createProduct: (body: ProductInput) =>
    request<ProductDetail>('/products', { method: 'POST', body }),

  updateProduct: (
    id: string,
    body: Partial<Omit<ProductInput, 'variants' | 'sku' | 'barcode'>> & { isActive?: boolean },
  ) => request<ProductDetail>(`/products/${id}`, { method: 'PATCH', body }),

  setProductActive: (id: string, active: boolean) =>
    request<ProductDetail>(`/products/${id}/${active ? 'activate' : 'archive'}`, { method: 'POST' }),

  addVariant: (productId: string, body: { sku: string; nameSuffix?: string; basePrice?: string; minStock?: string; barcode?: string }) =>
    request<ProductDetail>(`/products/${productId}/variants`, { method: 'POST', body }),

  updateVariant: (
    id: string,
    body: { sku?: string; nameSuffix?: string; basePrice?: string; minStock?: string; barcode?: string; isActive?: boolean },
  ) => request<ProductDetail>(`/variants/${id}`, { method: 'PATCH', body }),

  // ── Clientes ──
  listCustomers: (params: { search?: string; includeInactive?: boolean; withBalance?: boolean; limit?: number }) =>
    request<{ data: Customer[] }>(`/customers${toQuery(params)}`),

  getCustomer: (id: string) => request<CustomerDetail>(`/customers/${id}`),

  createCustomer: (body: CustomerInput) =>
    request<CustomerDetail>('/customers', { method: 'POST', body }),

  updateCustomer: (id: string, body: CustomerInput) =>
    request<CustomerDetail>(`/customers/${id}`, { method: 'PATCH', body }),

  customerStatement: (id: string) => request<AccountStatement>(`/customers/${id}/statement`),

  customerPayment: (id: string, body: { amount: string; methodCode: string; reference?: string; notes?: string }) =>
    request<AccountStatement>(`/customers/${id}/payments`, { method: 'POST', body }),

  // ── Listas de precios ──
  priceLists: () => request<PriceList[]>('/price-lists'),

  priceListItems: (id: string) => request<PriceListItem[]>(`/price-lists/${id}/items`),

  setPriceListItem: (id: string, body: { variantId: string; price: string; minQty?: string }) =>
    request<PriceListItem[]>(`/price-lists/${id}/items`, { method: 'PUT', body }),

  removePriceListItem: (id: string, itemId: string) =>
    request<PriceListItem[]>(`/price-lists/${id}/items/${itemId}`, { method: 'DELETE' }),

  // ── Caja ──
  currentCashSession: () => request<CashSession | null>('/cash/current'),

  openCashSession: (openingFloat: string, notes?: string) =>
    request<CashSession>('/cash/open', { method: 'POST', body: { openingFloat, notes } }),

  closeCashSession: (body: {
    cashSessionId: string;
    countedCash: string;
    differenceReason?: string;
    notes?: string;
  }) => request<CashSession>('/cash/close', { method: 'POST', body }),

  createCashMovement: (body: {
    cashSessionId: string;
    type: 'CASH_IN' | 'CASH_OUT' | 'WITHDRAWAL' | 'EXPENSE';
    amount: string;
    reason: string;
  }) => request<CashSession>('/cash/movements', { method: 'POST', body }),

  // ── Ventas ──
  createSale: (body: {
    items: SaleLineInput[];
    branchId?: string;
    payments: SalePaymentInput[];
    cashReceived?: string;
    customerId?: string;
    notes?: string;
    idempotencyKey?: string;
  }) => request<SaleDetail>('/sales', { method: 'POST', body }),

  listSales: (params: {
    search?: string;
    limit?: number;
    cursor?: string;
    /** Acotan el rango por fecha de la venta, en ISO-8601. */
    from?: string;
    to?: string;
    /** Cajero que registró la venta. */
    userId?: string;
  }) =>
    request<{ data: SaleSummary[]; nextCursor: string | null }>(`/sales${toQuery(params)}`),

  getSale: (id: string) => request<SaleDetail>(`/sales/${id}`),

  cancelSale: (id: string, body: { reason: string; supervisorPin?: string }) =>
    request<SaleDetail>(`/sales/${id}/cancel`, { method: 'POST', body }),

  // ── Tickets en espera ──
  listHeld: () => request<HeldSale[]>('/sales/held'),

  holdSale: (body: { label?: string; cart: Record<string, unknown> }) =>
    request<HeldSale>('/sales/held', { method: 'POST', body }),

  resumeHeld: (id: string) => request<HeldSale>(`/sales/held/${id}/resume`, { method: 'POST' }),

  discardHeld: (id: string) => request<void>(`/sales/held/${id}`, { method: 'DELETE' }),

  // ── Devoluciones ──
  createReturn: (body: {
    saleId: string;
    items: { saleItemId: string; qty: string; condition?: 'GOOD' | 'DAMAGED' }[];
    type: 'REFUND' | 'STORE_CREDIT';
    refundMethodCode?: string;
    reasonCode: string;
    notes?: string;
    supervisorPin?: string;
    idempotencyKey?: string;
  }) => request<ReturnDetail>('/returns', { method: 'POST', body }),

  listReturns: (params: { saleId?: string; from?: string; to?: string; limit?: number }) =>
    request<{ data: (Omit<ReturnDetail, 'items' | 'refunds' | 'creditNote' | 'customer'> & { cashier: string | null; itemCount: number })[] }>(
      `/returns${toQuery(params)}`,
    ),

  creditNote: (folio: string) =>
    request<CreditNoteInfo>(`/credit-notes/${encodeURIComponent(folio.trim().toUpperCase())}`),

  // ── Inventario ──
  listStock: (params: { search?: string; onlyLow?: boolean; limit?: number; cursor?: string; categoryId?: string }) =>
    request<{ data: StockRow[]; warehouseId: string; nextCursor: string | null }>(
      `/inventory/stock${toQuery(params)}`,
    ),

  kardex: (variantId: string, params: { from?: string; to?: string; limit?: number } = {}) =>
    request<{ variant: { id: string; sku: string; name: string }; warehouseId: string; movements: KardexEntry[] }>(
      `/inventory/kardex/${variantId}${toQuery(params)}`,
    ),

  adjustStock: (body: { lines: { variantId: string; countedQty: string; notes?: string }[]; reasonCode: string; notes?: string }) =>
    request<{ folio: string; adjustments: unknown[] }>('/inventory/adjustments', { method: 'POST', body }),

  // ── Compras ──
  listSuppliers: (search?: string, includeInactive = false) =>
    request<Supplier[]>(`/suppliers${toQuery({ search, includeInactive: includeInactive || undefined })}`),

  createSupplier: (body: Partial<Omit<Supplier, 'id' | 'orderCount'>>) =>
    request<Supplier>('/suppliers', { method: 'POST', body }),

  updateSupplier: (id: string, body: Partial<Omit<Supplier, 'id' | 'orderCount'>>) =>
    request<Supplier>(`/suppliers/${id}`, { method: 'PATCH', body }),

  listPurchaseOrders: (params: { status?: string; supplierId?: string } = {}) =>
    request<PurchaseOrderRow[]>(`/purchase-orders${toQuery(params)}`),

  getPurchaseOrder: (id: string) => request<PurchaseOrderDetail>(`/purchase-orders/${id}`),

  createPurchaseOrder: (body: {
    supplierId: string;
    items: { variantId: string; qty: string; unitCost: string }[];
    expectedDate?: string;
    shippingCost?: string;
    notes?: string;
  }) => request<PurchaseOrderDetail>('/purchase-orders', { method: 'POST', body }),

  approvePurchaseOrder: (id: string) =>
    request<PurchaseOrderDetail>(`/purchase-orders/${id}/approve`, { method: 'POST' }),

  cancelPurchaseOrder: (id: string) =>
    request<PurchaseOrderDetail>(`/purchase-orders/${id}/cancel`, { method: 'POST' }),

  purchaseSuggestions: () => request<PurchaseSuggestion[]>('/purchase-orders/suggestions'),

  receivePurchase: (body: {
    purchaseOrderId?: string;
    supplierId?: string;
    items: { variantId: string; qty: string; unitCost?: string }[];
    freightCost?: string;
    supplierInvoiceNumber?: string;
    notes?: string;
  }) => request<{ id: string; folio: string }>('/purchase-receipts', { method: 'POST', body }),

  listReceipts: () =>
    request<{ id: string; folio: string; receivedAt: string; supplier: { id: string; businessName: string }; purchaseOrder: { id: string; folio: string } | null; supplierInvoiceNumber: string | null; total: string }[]>(
      '/purchase-receipts',
    ),

  // ── Reportes ──
  dashboard: (params: { from?: string; to?: string }) =>
    request<Dashboard>(`/reports/dashboard${toQuery(params)}`),

  productSales: (params: { from?: string; to?: string }) =>
    request<Dashboard['topProducts']>(`/reports/product-sales${toQuery(params)}`),

  inventoryValuation: () =>
    request<{ sku: string; name: string; category: string | null; qty: string; avgCost: string; value: string; price: string }[]>(
      '/reports/inventory-valuation',
    ),

  listCashSessions: () =>
    request<{ data: { id: string; folio: string; status: string; openedAt: string; closedAt: string | null; terminal: string; openedBy: { name: string }; closedBy: { name: string } | null; openingFloat: string; countedCash: string | null; difference: string | null; saleCount: number }[] }>(
      '/cash/sessions',
    ),

  getCashSession: (id: string) => request<CashSession>(`/cash/sessions/${id}`),

  // ── Usuarios ──
  listUsers: () => request<{ data: UserRow[] }>('/users?limit=200'),
  listRoles: () =>
    request<{ id: string; code: string; name: string; permissions: string[] }[]>('/users/roles'),
  createUser: (body: { email: string; name: string; password: string; pin?: string; phone?: string; roleCodes: string[]; mustChangePassword?: boolean }) =>
    request<UserRow>('/users', { method: 'POST', body }),
  updateUser: (id: string, body: { name?: string; phone?: string; status?: string }) =>
    request<UserRow>(`/users/${id}`, { method: 'PATCH', body }),
  setUserRoles: (id: string, roleCodes: string[]) =>
    request<unknown>(`/users/${id}/roles`, { method: 'PATCH', body: { roleCodes } }),
  archiveUser: (id: string) => request<unknown>(`/users/${id}/archive`, { method: 'POST' }),

  // ── Soporte ──
  listTickets: (status?: string) =>
    request<SupportTicket[]>(`/support-tickets${toQuery({ status })}`),

  updateTicket: (id: string, body: { status?: string; priority?: string; answer?: string }) =>
    request<SupportTicket>(`/support-tickets/${id}`, { method: 'PATCH', body }),

  health: () =>
    request<{ status: string; checks: Record<string, unknown> }>('/health/ready'),
};
