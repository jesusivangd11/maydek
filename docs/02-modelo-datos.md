# 02 — Modelo de base de datos

## Convenciones aplicadas a todas las tablas

| Convención | Regla |
|---|---|
| Llave primaria | `id UUID` v7 (ordenable por tiempo, seguro de exponer, generable offline) |
| Folios visibles | Columna aparte (`folio TEXT`), generada por secuencia por sucursal y tipo de documento. `A-001-000123` |
| Dinero | `NUMERIC(14,4)`. **Jamás** `FLOAT` o `DOUBLE` |
| Cantidades | `NUMERIC(14,3)` (permite media pieza, metros, kilos) |
| Fechas | `TIMESTAMPTZ`, **siempre en UTC**. Se presentan en la zona horaria de la **sucursal** del documento (`branches.timezone`, o la de la empresa si es NULL). Ninguna zona está escrita en el código |
| Auditoría de fila | `created_at`, `updated_at`, `created_by`, `updated_by` |
| Borrado | `deleted_at TIMESTAMPTZ NULL` (archivado). **Nunca `DELETE` en tablas con historial** |
| Concurrencia optimista | `version INT` en entidades editables (productos, precios) → `If-Match` |
| Enumerados | Tipos `ENUM` de PostgreSQL, no cadenas libres |

---

## Mapa general de entidades

```
ORGANIZACIÓN               CATÁLOGO                    INVENTARIO
┌──────────────┐          ┌──────────────┐           ┌──────────────────┐
│ companies    │          │ categories   │           │ stock_balances   │◄─┐
│ branches     │          │ brands       │           │ (saldo derivado) │  │
│ warehouses   │──┐       │ products     │           └──────────────────┘  │
│ terminals    │  │       │  └ variants  │──────┬───►┌──────────────────┐  │
└──────────────┘  │       │ attributes   │      │    │ stock_ledger     │──┘
                  │       │ barcodes     │      │    │ (INMUTABLE=Kardex)│
SEGURIDAD         │       │ units        │      │    └──────────────────┘
┌──────────────┐  │       └──────────────┘      │    ┌──────────────────┐
│ users        │  │                             ├───►│ reservations     │
│ roles        │  │       PRECIOS               │    │ stock_counts     │
│ permissions  │  │       ┌──────────────┐      │    │ transfers        │
│ sessions     │  │       │ price_lists  │──────┤    └──────────────────┘
│ api_clients  │  │       │ price_items  │      │
└──────────────┘  │       │ promotions   │      │    COMPRAS
                  │       │ tax_rates    │      │    ┌──────────────────┐
VENTAS            │       └──────────────┘      ├───►│ suppliers        │
┌──────────────┐  │                             │    │ purchase_orders  │
│ sales        │◄─┤       CAJA                  │    │ purchase_items   │
│ sale_items   │──┘       ┌──────────────┐      │    │ receipts         │
│ payments     │          │ cash_sessions│      │    │ supplier_prices  │
│ returns      │          │ cash_moves   │      │    └──────────────────┘
│ return_items │          │ payment_meth │      │
│ held_sales   │          └──────────────┘      │    CLIENTES
└──────────────┘                                └───►┌──────────────────┐
                                                     │ customers        │
INTEGRACIÓN                    PLATAFORMA            │ account_entries  │
┌──────────────────┐          ┌──────────────────┐   │ credit_notes     │
│ channels         │          │ audit_logs       │   └──────────────────┘
│ webhook_endpoints│          │ outbox_events    │
│ webhook_deliveries│         │ idempotency_keys │
│ external_orders  │          │ sequences        │
│ integrations     │          │ settings · files │
└──────────────────┘          │ import_jobs      │
                              └──────────────────┘
```

---

## 1. Organización y ubicaciones

Aunque hoy exista **una sola tienda**, el diseño es multi-sucursal desde el inicio.
Añadir la dimensión después obligaría a migrar cada movimiento histórico de inventario:
es de las poquísimas cosas que sí conviene pagar por adelantado. La interfaz, en cambio,
esconde el selector de sucursal mientras solo haya una.

```sql
companies            -- la empresa (razón social, RFC, régimen fiscal, logo, config fiscal)
branches             -- sucursales: código, nombre, dirección, teléfono, timezone,
                     -- serie de folios, hora de corte del día operativo
warehouses           -- almacenes: branch_id, código, nombre, tipo
                     -- tipo ∈ (SALES_FLOOR, STORAGE, TRANSIT, DAMAGED, VIRTUAL)
terminals            -- cajas físicas: branch_id, nombre, device_token, impresora,
                     -- última sesión de caja, estado
```

`warehouses.type = TRANSIT` es un almacén virtual por sucursal destino: ahí vive el
**stock en tránsito** entre el envío y la recepción de una transferencia. Así el stock
en tránsito no es un caso especial en el código: es un almacén más, y el kardex cuadra solo.

`warehouses.type = DAMAGED` cumple el mismo papel para la **mercancía dañada**.

---

## 2. Seguridad y usuarios

```sql
users                -- email, password_hash (argon2id), pin_hash (POS), nombre,
                     -- estado, mfa_secret, last_login_at, failed_attempts, locked_until
roles                -- nombre, descripción, is_system (los del sistema no se borran)
permissions          -- code ('sale.create'), grupo, descripción
role_permissions     -- role_id + permission_id
user_roles           -- user_id + role_id
user_branches        -- a qué sucursales tiene acceso cada usuario
sessions             -- refresh tokens: hash, user_agent, ip, expires_at, revoked_at
api_clients          -- clientes máquina (la página web): nombre, tipo, canal, estado
api_keys             -- key_prefix, key_hash, scopes[], last_used_at, expires_at, revoked_at
```

**Por qué `permissions` es una tabla y no un enum en código:** permite crear roles a la
medida desde la interfaz sin desplegar. El catálogo de códigos sí se versiona en el `seed`.

**`pin_hash`:** en el POS, el cajero no teclea correo y contraseña en cada venta. La
terminal se autentica con su `device_token`; el cajero se identifica con un PIN de 4 a 6
dígitos. El mismo mecanismo sirve para la **autorización de supervisor**: cuando un cajero
intenta una acción restringida (descuento mayor al permitido, cancelar un ticket), el
sistema pide el PIN de alguien con ese permiso y lo registra en auditoría como
`authorized_by_user_id`.

---

## 3. Catálogo

```sql
brands               -- nombre, slug, logo, estado
categories           -- nombre, slug, parent_id (jerarquía), orden, imagen, estado
units                -- unidad de medida: código (PZA, PAR, CAJA), nombre, decimales permitidos
tax_rates            -- nombre (IVA 16%), tasa, tipo (RATE/EXEMPT/ZERO), código SAT

products             -- ── el producto "padre" ──
  id, sku_base, name, short_name, description,
  brand_id, category_id, unit_id, tax_rate_id, default_supplier_id,
  has_variants BOOL,
  weight_grams, length_mm, width_mm, height_mm,
  is_active, is_web_visible,          -- publicable en la web sin borrarlo del POS
  track_stock BOOL,                   -- false para servicios
  attributes JSONB,                   -- campos flexibles sin migración
  version INT, created_at, updated_at, deleted_at

product_options      -- ejes de variación del producto: "Color", "Talla", orden
product_option_values-- valores: "Negro", "Beige" / "S", "M", "L", "XL"

product_variants     -- ── LO QUE REALMENTE SE VENDE Y SE INVENTARÍA ──
  id, product_id,
  sku UNIQUE,                         -- único entre variantes no archivadas
  supplier_sku,                       -- código del proveedor
  name_suffix,                        -- "Negro / M"
  cost NUMERIC(14,4),                 -- costo promedio actual (derivado del kardex)
  last_cost NUMERIC(14,4),            -- último costo de compra
  base_price NUMERIC(14,4),           -- precio de lista público
  image_url, position,
  min_stock, max_stock, reorder_point,
  location_hint,                      -- "Pasillo 3 / Anaquel B"
  weight_grams,                       -- hereda del producto si es NULL
  is_active, is_web_visible,
  search_document TSVECTOR,           -- ← mantenido por trigger
  search_text TEXT,                   -- ← texto normalizado para trigram
  version INT, created_at, updated_at, deleted_at

variant_option_values-- variant_id + option_value_id (define la combinación)
barcodes             -- variant_id, code UNIQUE, type (EAN13/UPC/CODE128/INTERNAL),
                     -- is_primary. UN VARIANTE PUEDE TENER VARIOS CÓDIGOS
product_images       -- product_id o variant_id, url, alt, posición, es_principal
product_suppliers    -- variant_id + supplier_id: supplier_sku, último costo,
                     -- tiempo de entrega, cantidad mínima de pedido
```

### Decisión: variantes obligatorias internamente

Un producto sin variantes visibles **sí tiene una variante interna** ("variante por
defecto"). El inventario, las ventas y las compras **siempre** apuntan a
`product_variant_id`, nunca a `product_id`.

Esto elimina la fuente número uno de bugs en sistemas de POS con variantes: el código
condicional `if (producto.tieneVariantes) … else …` repartido por todos lados. La interfaz
oculta la variante cuando solo hay una; el motor nunca la ve como caso especial.

### Códigos de barras como tabla aparte

Los proveedores reutilizan y cambian códigos EAN. Un variante puede acumular el código de
fábrica más uno interno impreso por ti. Modelarlo como columna única en `product_variants`
obliga a decidir cuál conservar; como tabla, ambos escanean correctamente.

Restricción: `UNIQUE(code)` global entre códigos no archivados. Si al dar de alta se
detecta un duplicado, el sistema muestra **a qué variante pertenece** en vez de un error seco.

---

## 4. Inventario — el núcleo

### `stock_ledger` — el asiento inmutable (el Kardex *es* esta tabla)

```sql
stock_ledger
  id UUID,
  occurred_at TIMESTAMPTZ NOT NULL,      -- clave de particionado (por mes)
  variant_id, warehouse_id, condition,   -- condition ∈ (GOOD, DAMAGED, QUARANTINE)

  movement_type,     -- PURCHASE_RECEIPT · SALE · SALE_CANCEL · RETURN_IN · RETURN_OUT
                     -- ADJUSTMENT_IN · ADJUSTMENT_OUT · COUNT_CORRECTION
                     -- TRANSFER_OUT · TRANSFER_IN · DAMAGE · SCRAP · INITIAL_LOAD
  direction,         -- IN | OUT
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),

  qty_before NUMERIC(14,3) NOT NULL,     -- ← cantidad anterior (requisito §2)
  qty_after  NUMERIC(14,3) NOT NULL,     -- ← cantidad resultante

  unit_cost NUMERIC(14,4),               -- costo de ESTE movimiento
  avg_cost_after NUMERIC(14,4),          -- costo promedio tras el movimiento
  total_cost NUMERIC(14,4),

  reason_code,                           -- motivo tipificado
  notes TEXT,                            -- motivo libre

  reference_type,                        -- SALE · PURCHASE · RETURN · TRANSFER · ADJUSTMENT
  reference_id UUID,                     -- id del documento origen
  reference_folio TEXT,                  -- folio legible, desnormalizado a propósito

  channel_id,                            -- POS · WEB · MERCADO_LIBRE…
  user_id,                               -- quién
  terminal_id,                           -- desde dónde
  request_id,                            -- correlación con logs

  created_at
```

**Reglas de hierro:**

- La tabla es **append-only**. El rol de aplicación tiene `INSERT` y `SELECT`; **no** tiene
  `UPDATE` ni `DELETE`. Se hace cumplir con `GRANT`, no con disciplina.
- Corregir un error = **asiento contrario**, nunca editar el original.
- Particionada por mes sobre `occurred_at` (`PARTITION BY RANGE`). Un año de operación
  intensa cabe holgadamente; el particionado mantiene los índices pequeños y hace que
  purgar o archivar años viejos sea instantáneo.

Índices: `(variant_id, warehouse_id, occurred_at DESC)` para el kardex de un producto,
`(reference_type, reference_id)` para "qué movió esta venta", `(occurred_at)` para reportes.

### `stock_balances` — el saldo (derivado, cacheado, reconstruible)

```sql
stock_balances
  variant_id, warehouse_id, condition,   -- PK compuesta
  qty_on_hand   NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_reserved  NUMERIC(14,3) NOT NULL DEFAULT 0,
  avg_cost      NUMERIC(14,4) NOT NULL DEFAULT 0,
  last_movement_at, updated_at,

  CONSTRAINT chk_no_negativo   CHECK (qty_on_hand  >= 0),
  CONSTRAINT chk_res_positiva  CHECK (qty_reserved >= 0),
  CONSTRAINT chk_res_cubierta  CHECK (qty_reserved <= qty_on_hand)
```

`qty_available` es **columna generada**: `qty_on_hand - qty_reserved`. No se almacena
como dato independiente porque un valor duplicado siempre termina desincronizándose.

Estas tres restricciones `CHECK` son la última línea de defensa. Si un bug futuro intenta
sobrevender, PostgreSQL aborta la transacción. **Preferimos un error 500 ruidoso a
inventario silenciosamente corrupto.**

Existe un job de verificación (nocturno y bajo demanda) que recalcula el saldo desde el
ledger y reporta cualquier discrepancia. En operación normal debe reportar cero siempre.

### `reservations` — el apartado de existencias

```sql
reservations
  id, variant_id, warehouse_id,
  qty NUMERIC(14,3),
  status,        -- HELD · COMMITTED · CONSUMED · RELEASED · EXPIRED
  purpose,       -- WEB_ORDER · LAYAWAY(apartado) · TRANSFER · QUOTE · MANUAL
  channel_id, customer_id,
  reference_type, reference_id, reference_folio,
  expires_at,    -- NULL en COMMITTED (no expira)
  created_by, released_by, released_reason,
  created_at, updated_at
```

Esto resuelve la distinción que pediste entre **reservado** y **comprometido**: no son dos
mecanismos, son dos estados del mismo:

| Concepto tuyo | Estado | Expira | Ejemplo |
|---|---|---|---|
| Reservado | `HELD` | Sí (TTL, típico 20 min) | Pedido web en checkout, sin pagar |
| Comprometido | `COMMITTED` | No | Pedido web pagado, pendiente de surtir |
| Apartado | `COMMITTED` + `purpose=LAYAWAY` | No | Cliente dejó anticipo en mostrador |

Un sweeper corre cada minuto y libera las `HELD` vencidas.

### Los siete tipos de stock que pediste

| Tu concepto | Cómo se calcula |
|---|---|
| **Físico** | `SUM(qty_on_hand)` en el almacén, todas las condiciones |
| **Disponible** | `qty_on_hand − qty_reserved` con `condition = GOOD` ← **esto consulta la web** |
| **Reservado** | `qty_reserved` (reservas `HELD`) |
| **Comprometido** | `qty_reserved` de reservas `COMMITTED` |
| **En tránsito** | `qty_on_hand` en el almacén `type = TRANSIT` del destino |
| **Dañado** | `qty_on_hand` con `condition = DAMAGED` |
| **Apartado** | Reservas `COMMITTED` con `purpose = LAYAWAY` |

Ninguno es una columna suelta: todos se derivan de dos tablas. No pueden contradecirse.

### Conteos y transferencias

```sql
stock_counts         -- conteo físico: almacén, alcance, estado (DRAFT/COUNTING/REVIEW/APPLIED)
stock_count_items    -- variante, cantidad de sistema, cantidad contada, diferencia,
                     -- costo de la diferencia, contado_por
stock_transfers      -- origen, destino, estado (DRAFT/SENT/PARTIAL/RECEIVED/CANCELLED),
                     -- folio, enviado_por, recibido_por, fechas
stock_transfer_items -- variante, cantidad enviada, cantidad recibida, diferencia
```

Un conteo físico **no edita cantidades**: al aplicarse genera asientos `COUNT_CORRECTION`
por cada diferencia. El faltante queda registrado, con su costo y su responsable.

---

## 5. Precios

```sql
price_lists          -- nombre (Público, Mayoreo, Distribuidor, Especial), código,
                     -- moneda, incluye_impuesto BOOL, prioridad, estado
price_list_items     -- price_list_id, variant_id,
                     -- price, min_qty (precio por volumen),
                     -- valid_from, valid_to (precios temporales)
customer_price_lists -- lista asignada a un cliente específico
promotions           -- nombre, tipo, vigencia, canales aplicables, prioridad,
                     -- tope de usos, acumulable BOOL
promotion_rules      -- condiciones: producto/categoría/marca/monto mínimo/cantidad
promotion_actions    -- efecto: % descuento, monto fijo, precio fijo, NxM, regalo
```

### Problema detectado en tus requisitos

Pediste columnas `precio_mayoreo`, `precio_distribuidor` y `precio_especial` **dentro del
producto**, y además un sistema de listas de precios. Son dos modelos del mismo dato, y
convivir garantiza que se contradigan: alguien actualizará el campo del producto y no la
lista, y el POS y la web mostrarán precios distintos.

**Propuesta:** una sola fuente, `price_lists`. Las cuatro listas se crean en el `seed`, y
la pantalla de producto muestra las cuatro casillas de siempre — solo que escriben en
`price_list_items`. La experiencia que quieres se conserva; la contradicción desaparece.

### Resolución de precio (orden de precedencia)

```
1. Promoción activa aplicable      (mayor prioridad, respeta acumulables)
2. Precio por volumen              (price_list_items.min_qty ≤ cantidad)
3. Lista asignada al cliente
4. Lista asignada al canal         (la web puede tener su propia lista)
5. Lista pública (por defecto)
6. product_variants.base_price     (última red de seguridad)
```

Un único servicio, `PricingService.resolve(variant, qty, customer, channel, date)`,
implementa esta cadena. **POS, web y cotizaciones llaman al mismo código**; es imposible
que un canal calcule distinto.

---

## 6. Ventas

```sql
sales
  id, folio UNIQUE, branch_id, warehouse_id, terminal_id,
  channel_id,                        -- POS · WEB · MERCADO_LIBRE…
  customer_id NULL,                  -- venta de mostrador sin cliente
  user_id,                           -- cajero
  cash_session_id NULL,              -- sesión de caja (NULL si es venta web)
  price_list_id,

  status,        -- DRAFT · COMPLETED · CANCELLED · PARTIALLY_RETURNED · RETURNED
  fulfillment,   -- IMMEDIATE (mostrador) · PENDING · SHIPPED · DELIVERED

  subtotal, discount_total, tax_total, total,
  cost_total,                        -- ← COGS congelado al momento de la venta
  rounding_adjustment,               -- redondeo de efectivo
  paid_total, change_given, balance_due,

  external_order_id,                 -- id del pedido en el canal externo
  idempotency_key,
  notes, metadata JSONB,
  cancelled_at, cancelled_by, cancel_reason,
  occurred_at, created_at, updated_at

sale_items
  id, sale_id, line_number,
  variant_id,
  -- ↓ FOTOGRAFÍA INMUTABLE del momento de la venta
  sku_snapshot, name_snapshot, barcode_snapshot,
  qty, unit_price, unit_cost,        -- ← costo congelado (requisito §35)
  discount_amount, discount_percent, discount_reason, discount_by_user_id,
  tax_rate, tax_amount,
  line_subtotal, line_total,
  promotion_id NULL, price_list_id,
  returned_qty NUMERIC(14,3) DEFAULT 0,   -- acumulado devuelto
  warehouse_id

held_sales           -- ventas suspendidas: carrito serializado, nombre, terminal,
                     -- usuario, creada_en, expira_en
```

**Por qué los campos `_snapshot`:** dentro de dos años el producto puede haberse renombrado,
cambiado de SKU o archivado. La reimpresión de un ticket antiguo debe mostrar lo que el
cliente compró ese día, no el estado actual del catálogo. Es la misma razón por la que
`unit_cost` se copia: cumple tu requisito 35 de forma estructural, no por convención.

### Devoluciones

```sql
returns
  id, folio UNIQUE, sale_id NOT NULL,     -- SIEMPRE ligada a la venta original
  branch_id, warehouse_id, channel_id, user_id, cash_session_id,
  type,          -- REFUND (dinero) · EXCHANGE (cambio) · STORE_CREDIT (crédito a favor)
  status,        -- PENDING · COMPLETED · REJECTED
  subtotal, tax_total, total,
  restock BOOL,                           -- ¿regresa a inventario vendible?
  reason_code, notes,
  authorized_by_user_id,                  -- quien autorizó con su PIN
  exchange_sale_id NULL,                  -- si el cambio generó una venta nueva
  idempotency_key, occurred_at, created_at

return_items
  id, return_id, sale_item_id,            -- línea original
  variant_id, qty,
  unit_price, unit_cost,                  -- los MISMOS de la venta original
  tax_amount, line_total,
  condition,                              -- GOOD (a vender) · DAMAGED (a merma)
  reason_code
```

`return_items.condition` decide el destino del inventario: `GOOD` regresa al almacén de
venta; `DAMAGED` entra al almacén de mermas. Sin esto, una faja devuelta usada vuelve a
mostrarse como vendible.

**Restricción crítica:** `SUM(return_items.qty) <= sale_items.qty` por línea. Se valida en
transacción con bloqueo de la línea original, para que dos devoluciones simultáneas del
mismo ticket no puedan devolver más de lo vendido.

---

## 7. Pagos y caja

```sql
payment_methods      -- código (CASH, CARD, TRANSFER, CREDIT, STORE_CREDIT),
                     -- nombre, tipo, afecta_caja BOOL, requiere_referencia BOOL,
                     -- comisión %, cuenta contable, estado, orden
payments
  id, sale_id NULL, return_id NULL, customer_id NULL,
  payment_method_id, amount, currency,
  reference,                        -- autorización, últimos 4 dígitos, folio de transferencia
  status,                           -- PENDING · CAPTURED · REFUNDED · VOIDED
  cash_session_id, user_id, channel_id,
  external_payment_id, metadata JSONB, occurred_at
```

**El pago mixto sale gratis:** una venta tiene N pagos. `Efectivo 500 + Tarjeta 1000` son
simplemente dos filas. La validación es `SUM(payments.amount) >= sale.total` y el cambio se
calcula solo sobre la parte en efectivo.

```sql
cash_sessions        -- turno de caja
  id, folio, terminal_id, branch_id, opened_by, closed_by,
  opened_at, closed_at,
  opening_float,                    -- fondo inicial
  status,                           -- OPEN · CLOSED · SUSPENDED
  expected_cash, counted_cash, difference,   -- ← arqueo
  expected_by_method JSONB,         -- esperado por método de pago
  counted_by_method JSONB,
  z_report_at, z_report_number,
  notes

cash_movements       -- todo lo que entra o sale de la caja
  id, cash_session_id, type,
  -- type ∈ OPENING · SALE · RETURN_REFUND · CASH_IN · CASH_OUT
  --        WITHDRAWAL(retiro) · EXPENSE · CLOSING · ADJUSTMENT
  amount, payment_method_id,
  reference_type, reference_id, reference_folio,
  reason, user_id, authorized_by_user_id, occurred_at
```

Igual que el inventario, **la caja es un libro de asientos**. `expected_cash` no se guarda
como valor editable: se calcula como `opening_float + SUM(cash_movements)`. El arqueo
compara ese cálculo con lo contado y la diferencia queda registrada con nombre y hora.

---

## 8. Compras y proveedores

```sql
suppliers
  id, code, business_name, trade_name, rfc,
  contact_name, phone, email, address JSONB,
  payment_terms,                    -- contado, 15 días, 30 días
  credit_limit, currency, lead_time_days,
  notes, is_active, created_at, deleted_at

purchase_orders
  id, folio UNIQUE, supplier_id, branch_id, warehouse_id,
  status,        -- DRAFT · SENT · PARTIALLY_RECEIVED · RECEIVED · CANCELLED · CLOSED
  expected_date, currency, exchange_rate,
  subtotal, tax_total, shipping_cost, other_costs, total,
  notes, created_by, approved_by, approved_at

purchase_order_items
  id, purchase_order_id, variant_id,
  qty_ordered, qty_received,        -- ← el pendiente es la resta
  unit_cost, discount, tax_rate, tax_amount, line_total,
  supplier_sku

purchase_receipts     -- una ORDEN puede tener VARIAS RECEPCIONES
  id, folio, purchase_order_id NULL,   -- NULL = compra directa sin orden previa
  supplier_id, warehouse_id,
  received_at, received_by,
  supplier_invoice_number, supplier_invoice_date,
  freight_cost, other_landed_costs,    -- se prorratean al costo unitario
  status, notes

purchase_receipt_items
  id, receipt_id, purchase_order_item_id NULL,
  variant_id, qty_received,
  unit_cost, landed_unit_cost,         -- costo con flete prorrateado
  condition,                           -- GOOD · DAMAGED
  lot_number, expiry_date              -- reservado para futuro

supplier_prices       -- HISTORIAL DE COSTOS por proveedor (requisito §13 y §35)
  id, supplier_id, variant_id,
  cost, currency, valid_from, valid_to,
  purchase_receipt_id,                 -- de qué recepción salió
  created_at
```

Tu ejemplo del requisito 12 queda cubierto de forma natural: se ordenan 100, se reciben 80.
`qty_ordered = 100`, `qty_received = 80`, el estado pasa a `PARTIALLY_RECEIVED`, el
pendiente (20) es una resta y **solo entran 80 al inventario**, porque el asiento del ledger
lo genera la *recepción*, no la orden.

**Costos de importación (`landed cost`):** el flete y los gastos de aduana se prorratean
entre las líneas de la recepción (por valor o por peso) para obtener el costo real. Para una
distribuidora que importa de Colombia esto no es un lujo: sin ello, el margen calculado es
sistemáticamente optimista.

---

## 9. Clientes

```sql
customers
  id, code, type (PERSON/COMPANY),
  first_name, last_name, business_name,
  rfc, tax_regime, cfdi_use,          -- datos fiscales
  phone, email, address JSONB,
  price_list_id NULL,                 -- lista de precios propia
  credit_limit, credit_days,
  is_active, notes, tags[],
  -- métricas derivadas (materializadas, refrescadas por evento)
  total_purchased, purchase_count, last_purchase_at, average_ticket,
  created_at, updated_at, deleted_at

customer_account_entries    -- CUENTA CORRIENTE (libro de asientos, no un saldo editable)
  id, customer_id,
  type,        -- CHARGE(venta a crédito) · PAYMENT · CREDIT_NOTE · ADJUSTMENT · REFUND
  amount, balance_after,
  reference_type, reference_id, reference_folio,
  due_date, notes, user_id, occurred_at

credit_notes         -- crédito a favor por devolución
  id, folio, customer_id, return_id,
  amount, used_amount, balance,
  expires_at, status, created_at
```

**Problema detectado.** Pediste un campo `saldo` en el cliente. Un saldo como columna
editable es el mismo error que un stock como columna editable: en cuanto haya dos
operaciones simultáneas, o un abono que se registró mal, el número deja de ser explicable
y nadie sabe reconstruirlo.

**Propuesta:** misma medicina que el inventario. El saldo es `SUM(customer_account_entries)`.
Cada cargo y cada abono son un asiento con fecha, usuario y referencia. Cuando el cliente
reclame, hay un estado de cuenta que se imprime, no una cifra que defender.

---

## 10. Canales e integración

```sql
channels             -- POS · WEB · MERCADO_LIBRE · WHATSAPP · TELEFONO
  id, code UNIQUE, name, type, is_active,
  default_price_list_id, default_warehouse_id,
  reservation_ttl_minutes,          -- cada canal puede reservar distinto
  auto_confirm BOOL, config JSONB

external_orders      -- pedidos entrantes de un canal, ANTES de volverse venta
  id, channel_id, external_id, external_number,
  status,      -- RECEIVED · RESERVED · PAID · FULFILLED · CANCELLED · FAILED
  raw_payload JSONB,                -- lo que mandó el canal, tal cual
  customer_data JSONB,
  sale_id NULL,                     -- venta generada, si ya se confirmó
  reservation_ids UUID[],
  idempotency_key, error_message,
  received_at, processed_at
  UNIQUE (channel_id, external_id)  -- ← segunda barrera contra pedidos duplicados

integrations         -- configuración por integración: credenciales cifradas, mapeos, estado
```

`external_orders` es un buzón. Guardar el pedido crudo antes de procesarlo permite
reprocesar sin pedirle nada al canal cuando algo falla, y deja evidencia de qué mandó
exactamente la web el día de la discusión.

---

## 11. Plataforma

```sql
outbox_events        -- eventos escritos EN LA MISMA TRANSACCIÓN que el dato
  id, event_type, aggregate_type, aggregate_id,
  payload JSONB, metadata JSONB,
  occurred_at, published_at NULL, attempts,
  UNIQUE (id)                       -- el id ES la clave de idempotencia del consumidor

webhook_endpoints
  id, api_client_id, url, secret,   -- secreto para firma HMAC-SHA256
  event_types[], is_active,
  headers JSONB, description,
  failure_count, disabled_at, disabled_reason

webhook_deliveries
  id, endpoint_id, outbox_event_id,
  status,      -- PENDING · DELIVERING · SUCCESS · FAILED · EXHAUSTED
  attempt, max_attempts,
  request_body, response_status, response_body, error_message,
  next_retry_at, delivered_at, duration_ms

idempotency_keys
  key, api_client_id, endpoint, request_hash,
  status,      -- IN_PROGRESS · COMPLETED · FAILED
  response_status, response_body JSONB, resource_id,
  created_at, expires_at,
  PRIMARY KEY (api_client_id, key)

audit_logs           -- particionada por mes
  id, occurred_at,
  user_id, api_client_id, impersonated_by,
  action,      -- 'product.price.update', 'stock.adjust', 'sale.cancel'…
  entity_type, entity_id, entity_label,
  changes JSONB,                    -- { campo: { before, after } }
  reason, authorized_by_user_id,
  ip_address, user_agent, request_id, channel_id, branch_id

sequences            -- folios: scope(branch+doc_type), prefijo, siguiente, relleno
settings             -- configuración clave/valor por empresa y sucursal, tipada
files                -- archivos en S3: ruta, mime, tamaño, hash, propietario, uso
import_jobs          -- importación: tipo, archivo, estado, mapeo, total, ok, errores
import_rows          -- fila, datos crudos, datos parseados, estado, error, acción
notifications        -- alertas internas: bajo stock, webhook caído, diferencia de caja
report_snapshots     -- resultados de reportes pesados, cacheados
```

**`audit_logs` es inmutable igual que el ledger:** el rol de aplicación solo tiene `INSERT`
y `SELECT`. Un registro de auditoría que se puede editar no sirve para auditar nada.

---

## 12. Índices críticos

```sql
-- BÚSQUEDA (lo que define la experiencia del POS)
CREATE INDEX idx_variants_fts     ON product_variants USING GIN (search_document);
CREATE INDEX idx_variants_trgm    ON product_variants USING GIN (search_text gin_trgm_ops);
CREATE UNIQUE INDEX idx_variant_sku ON product_variants (sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_barcode    ON barcodes (code)         WHERE deleted_at IS NULL;
CREATE INDEX idx_variants_active   ON product_variants (is_active, product_id)
                                   WHERE deleted_at IS NULL;

-- INVENTARIO
CREATE INDEX idx_ledger_variant ON stock_ledger (variant_id, warehouse_id, occurred_at DESC);
CREATE INDEX idx_ledger_ref     ON stock_ledger (reference_type, reference_id);
CREATE INDEX idx_balance_low    ON stock_balances (warehouse_id, variant_id)
                                WHERE qty_on_hand <= 0;
CREATE INDEX idx_reservations_exp ON reservations (expires_at)
                                WHERE status = 'HELD';

-- VENTAS Y REPORTES
CREATE INDEX idx_sales_date     ON sales (branch_id, occurred_at DESC)
                                WHERE status = 'COMPLETED';
CREATE INDEX idx_sales_channel  ON sales (channel_id, occurred_at DESC);
CREATE INDEX idx_sales_customer ON sales (customer_id, occurred_at DESC);
CREATE UNIQUE INDEX idx_sales_folio ON sales (branch_id, folio);
CREATE INDEX idx_sale_items_var ON sale_items (variant_id, sale_id);

-- PLATAFORMA
CREATE INDEX idx_outbox_pending ON outbox_events (occurred_at)
                                WHERE published_at IS NULL;
CREATE INDEX idx_wh_retry       ON webhook_deliveries (next_retry_at)
                                WHERE status IN ('PENDING','FAILED');
CREATE INDEX idx_audit_entity   ON audit_logs (entity_type, entity_id, occurred_at DESC);
```

Los **índices parciales** (`WHERE`) son la razón principal por la que elegí PostgreSQL:
el índice de webhooks pendientes solo contiene las filas pendientes, no los millones
entregados. Se mantiene diminuto y rápido para siempre.

---

## 13. Recuento de entidades

> **Nota sobre el conteo.** Un borrador anterior de este documento encabezaba esta
> sección con «52 tablas». Ese número era **simplemente incorrecto**: un conteo hecho a
> ojo al redactar el resumen, que ni siquiera cuadraba con el desglose por dominio que
> aparecía debajo (sumaba 72). El inventario que sigue está **verificado contra la base
> de datos real** con `information_schema`, no estimado.

## Inventario verificado

**76 tablas** = **71 del modelo operativo** + **5 catálogos del SAT**.

Los 5 catálogos del SAT son consecuencia directa de la decisión **D2** (preparar la
facturación CFDI sin implementarla todavía) y se añadieron *después* del diseño original.
Por eso se cuentan aparte: sin D2, el sistema tendría 71 tablas.

| Dominio | Tablas | Detalle |
|---|---:|---|
| **Organización y configuración** | 8 | `companies` · `branches` · `warehouses` · `terminals` · `settings` · `sequences` · `files` · `exchange_rates` |
| **Seguridad** | 9 | `users` · `roles` · `permissions` · `role_permissions` · `user_roles` · `user_branches` · `sessions` · `api_clients` · `api_keys` |
| **Catálogo** | 12 | `brands` · `categories` · `units` · `tax_rates` · `products` · `product_options` · `product_option_values` · `product_variants` · `variant_option_values` · `barcodes` · `product_images` · `product_suppliers` |
| **Inventario** | 7 | `stock_balances` · `stock_ledger` · `reservations` · `stock_counts` · `stock_count_items` · `stock_transfers` · `stock_transfer_items` |
| **Precios** | 5 | `price_lists` · `price_list_items` · `promotions` · `promotion_rules` · `promotion_actions` |
| **Ventas y devoluciones** | 5 | `sales` · `sale_items` · `held_sales` · `returns` · `return_items` |
| **Caja y pagos** | 4 | `payment_methods` · `payments` · `cash_sessions` · `cash_movements` |
| **Compras** | 7 | `suppliers` · `purchase_orders` · `purchase_order_items` · `purchase_receipts` · `purchase_receipt_items` · `supplier_prices` · `landed_costs` |
| **Clientes** | 3 | `customers` · `customer_account_entries` · `credit_notes` |
| **Canales e integración** | 5 | `channels` · `external_orders` · `integrations` · `webhook_endpoints` · `webhook_deliveries` |
| **Plataforma** | 6 | `outbox_events` · `idempotency_keys` · `audit_logs` · `import_jobs` · `import_rows` · `notifications` |
| **Subtotal operativo** | **71** | |
| **Catálogos del SAT (D2)** | 5 | `sat_tax_regimes` · `sat_cfdi_uses` · `sat_product_keys` · `sat_unit_keys` · `sat_payment_forms` |
| **TOTAL** | **76** | |

A esas 76 se suma `_prisma_migrations`, que crea y administra Prisma para llevar el
control de qué migraciones se aplicaron. No es del modelo y no se cuenta.

### Ninguna tabla existe para inflar el número

Cada tabla responde a un requisito concreto. Las que a primera vista parecen «de más»
son de tres tipos, todas necesarias:

**Tablas puente (relaciones N a N).** No son opcionales: son la forma en que una base
relacional expresa «muchos a muchos».

| Tabla | Existe porque |
|---|---|
| `role_permissions` | Un rol tiene N permisos y un permiso está en N roles |
| `user_roles` | Un usuario puede tener varios roles a la vez |
| `user_branches` | Requisito 16: acceso por sucursal |
| `variant_option_values` | Una variante es la intersección de N opciones (Color × Talla) |

**Tablas de detalle (renglones de un documento).** Un documento con líneas necesita dos
tablas; meterlas en un JSON haría imposible consultar «cuánto se vendió de este SKU».

`sale_items` · `return_items` · `purchase_order_items` · `purchase_receipt_items` ·
`stock_count_items` · `stock_transfer_items` · `price_list_items` · `import_rows` ·
`promotion_rules` · `promotion_actions`

**Tablas de historial (el corazón del diseño).** Son las que convierten números editables
en libros auditables, y son la razón de ser del sistema:

| Tabla | Sustituye a |
|---|---|
| `stock_ledger` | Un campo `stock` que nadie puede explicar |
| `customer_account_entries` | Un campo `saldo` que nadie puede reconstruir (P2) |
| `cash_movements` | Un `efectivo_esperado` capturado a mano |
| `supplier_prices` | Un `último_costo` que borra su propia historia |
| `audit_logs` | Nada — antes no existía el rastro |
| `exchange_rates` | Un tipo de cambio tecleado que nadie puede justificar |
| `landed_costs` | Un `otros_gastos` que impide saber cuánto costó la aduana |

Las que no pertenecen a la Fase 1 se llenan en su fase, pero **el esquema completo se
crea desde el inicio**: añadir la dimensión después obligaría a reescribir historial de
inventario ya existente.
