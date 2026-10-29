# 03 — Inventario, costeo y búsqueda

Este documento describe el módulo más importante del sistema.

## 1. El principio: el stock no se edita, se mueve

En Eleventa y en la mayoría de los POS tradicionales, el stock es un número en una columna.
Cuando ese número está mal, no hay forma de saber por qué. Aquí el diseño es el opuesto:

```
   ┌─────────────────────────────────────────────────────────────┐
   │  stock_ledger   (INMUTABLE, append-only)                    │
   │  La verdad histórica. Cada fila es un hecho que ocurrió.    │
   │  NUNCA se actualiza. NUNCA se borra.                        │
   └───────────────────────────┬─────────────────────────────────┘
                               │ se agrega
                               ↓
   ┌─────────────────────────────────────────────────────────────┐
   │  stock_balances  (DERIVADO, cacheado)                       │
   │  El saldo de ahora mismo. Existe solo por velocidad.        │
   │  Reconstruible al 100% desde el ledger.                     │
   └─────────────────────────────────────────────────────────────┘
```

**Consecuencia práctica:** ante cualquier duda ("¿por qué tengo 3 y deberían ser 5?"), el
Kardex responde con nombre, hora, documento y motivo. No hay conversación posible sobre un
número sin historia.

**Consecuencia técnica:** existe un comando de verificación que recalcula todos los saldos
desde cero y compara. Si alguna vez discrepa, hay un bug — y el ledger permite reparar el
saldo sin perder información.

## 2. El único escritor

```typescript
// apps/api/src/modules/inventory/stock.service.ts
//
// ESTE ES EL ÚNICO CÓDIGO DEL SISTEMA QUE ESCRIBE EXISTENCIAS.

interface StockMovement {
  variantId: string;
  warehouseId: string;
  condition: 'GOOD' | 'DAMAGED' | 'QUARANTINE';
  direction: 'IN' | 'OUT';
  qty: Decimal;
  movementType: MovementType;
  unitCost?: Decimal;          // obligatorio cuando direction = IN
  reasonCode?: string;
  notes?: string;
}

interface StockContext {
  referenceType: ReferenceType;
  referenceId: string;
  referenceFolio: string;
  userId: string;
  channelId: string;
  terminalId?: string;
  requestId: string;
  allowNegative?: boolean;     // solo con permiso 'inventory.allow_negative'
}

async apply(tx: Transaction, movements: StockMovement[], ctx: StockContext): Promise<Ledger[]>
```

Lo que hace, en orden estricto:

```
1. Ordena los movimientos por (variant_id, warehouse_id, condition)
   → orden determinista de bloqueo = imposible que dos transacciones
     se bloqueen mutuamente en sentido contrario (deadlock)

2. SELECT … FROM stock_balances WHERE … FOR UPDATE
   → bloquea todas las filas afectadas de una vez
   → una segunda transacción sobre las mismas filas ESPERA aquí

3. Por cada movimiento:
     qty_before = balance.qty_on_hand
     qty_after  = qty_before ± qty
     si qty_after < 0 y no allowNegative  →  InsufficientStockError (409)
     si direction = OUT y qty_after < qty_reserved → ReservedStockError (409)
     recalcula el costo promedio ponderado (solo en entradas)

4. INSERT en stock_ledger  (con qty_before, qty_after, avg_cost_after)

5. UPDATE stock_balances   (qty_on_hand, avg_cost, last_movement_at)

6. OutboxService.publish('STOCK_CHANGED', …)   ← misma transacción

7. Si el nuevo saldo cruza min_stock → publica 'LOW_STOCK_REACHED'
```

Todo dentro de la transacción que le pasa el caso de uso. `StockService` **no abre ni cierra
transacciones**: se une a la del documento que lo invoca. Así, si la venta falla al cobrar,
el descuento de inventario se revierte sin código de compensación.

## 3. El Kardex

El Kardex no es un reporte que se calcula: es una consulta directa a `stock_ledger`.

```
Faja Postquirúrgica Modelo X — Negro / M   (SKU: FJ-0012-NEG-M)
Almacén: Tienda Principal

Fecha        Hora   Movimiento        Ref.          Entrada  Salida  Stock  Costo   Usuario
──────────────────────────────────────────────────────────────────────────────────────────
05/09/2026   09:12  Carga inicial     INIT-0001        20.0       -   20.0  400.00  Sistema
05/09/2026   11:40  Venta             A-001-000045        -     1.0   19.0  400.00  María
05/09/2026   13:05  Compra recibida   REC-000012       30.0       -   49.0  450.00  Jesús
                                      ↑ costo promedio pasa a 430.61
05/09/2026   16:22  Venta web         W-000003            -     2.0   47.0  430.61  API/WEB
06/09/2026   10:15  Devolución        DEV-000002        1.0       -   48.0  400.00  María
                                      ↑ regresa al costo con el que salió
06/09/2026   18:00  Ajuste (merma)    AJU-000004          -     1.0   47.0  430.61  Jesús
                                      Motivo: producto dañado en bodega
──────────────────────────────────────────────────────────────────────────────────────────
                                                Saldo actual: 47.0   Valor: $20,238.67
```

Cada renglón es clicable y lleva al documento que lo originó. Filtros: rango de fechas,
almacén, tipo de movimiento, usuario, canal. Exportable a Excel, CSV y PDF.

## 4. Costeo: promedio ponderado móvil

**Método elegido: promedio ponderado (WAC) por (variante, almacén).**

```
Estado:      10 piezas a $400 promedio        →  valor $4,000
Entra:       30 piezas a $450                 →  valor $13,500
                                                 ──────────────
Nuevo:       40 piezas                           valor $17,500
Promedio:    $17,500 / 40 = $437.50
```

**Por qué promedio y no PEPS (FIFO):** PEPS obliga a mantener capas de costo por lote y a
consumirlas en orden, lo que multiplica la complejidad de cada venta y de cada devolución.
Para fajas —producto no perecedero, sin caducidad, con costos que varían de forma gradual—
el promedio da un margen prácticamente idéntico con una fracción del riesgo de bugs.

El esquema deja la puerta abierta: `stock_ledger` ya guarda `unit_cost` por movimiento, que
es exactamente lo que PEPS necesitaría. Migrar después es posible sin perder historia.

### Lo que garantiza tu requisito 35

Tu preocupación era que una venta hecha cuando el costo era $400 no cambie al subir el costo
a $470. Se resuelve en dos capas independientes:

1. **`sale_items.unit_cost` se copia en el momento de la venta.** Es un dato de la venta,
   no una referencia al producto. Nada lo puede alterar después.
2. **`stock_ledger.avg_cost_after` congela el costo de cada movimiento.** El histórico de
   costos es reconstruible movimiento por movimiento.

Además, `supplier_prices` conserva el costo negociado con cada proveedor a lo largo del
tiempo, con la recepción que lo originó.

**Regla de la devolución:** un producto devuelto reingresa al **costo con el que salió**
(el de `sale_items.unit_cost`), no al promedio actual. De lo contrario una devolución
inflaría o desinflaría artificialmente el valor del inventario.

## 5. Los tipos de stock, en la práctica

Tu ejemplo del requisito 3, ejecutado por el sistema:

```
Faja X / Negro / M · Almacén: Tienda Principal

  stock_balances (condition = GOOD)
    qty_on_hand   = 20
    qty_reserved  =  3      ← pedido web #W-1042, estado COMMITTED
    qty_available = 17      ← columna generada: 20 − 3

  stock_balances (condition = DAMAGED)
    qty_on_hand   =  1      ← devolución en mal estado

  Almacén TRANSIT (destino: Sucursal Norte)
    qty_on_hand   =  5      ← transferencia enviada, no recibida

  ─────────────────────────────────────────────
  Físico total (esta tienda) : 21   (20 GOOD + 1 DAMAGED)
  Vendible en mostrador      : 17
  Lo que responde la API web : 17   ← GET /public/v1/stock
  En tránsito a otra sucursal:  5
```

La API pública **siempre** responde `available`, nunca `on_hand`. Esta única decisión evita
la clase de error más común en integraciones de e-commerce: la web vende lo que ya estaba
apartado para otro pedido.

## 6. Motor de búsqueda

Es el punto donde explícitamente quieres superar a los sistemas tradicionales, así que va
resuelto en dos niveles.

### Nivel 1 — Servidor (la verdad, tolerante a errores)

Cada variante mantiene, por trigger, dos columnas de búsqueda:

```sql
search_text = normalizar(
  nombre_producto || ' ' || sufijo_variante || ' ' || sku || ' ' ||
  codigos_barras  || ' ' || marca || ' ' || categoria || ' ' ||
  valores_opcion  || ' ' || sku_proveedor || ' ' || sinonimos
)
-- normalizar() = minúsculas + unaccent() + colapsar espacios

search_document = to_tsvector('spanish', search_text)
```

**Diccionario de sinónimos y abreviaturas** (tabla editable desde el panel, no código):

```
postquirurgica  → post, postqx, pqx, cirugia
reductora       → reduct, faja reductora
levanta gluteos → levantacola, push up, levanta pompa
negro           → negra, neg, black
beige           → bge, piel, nude, cafe claro
chica           → s, ch, small
mediana         → m, med, medium
grande          → l, g, large
extra grande    → xl, eg, xg
```

Esto es lo que hace que **"post m"** encuentre la faja postquirúrgica talla M, y que
**"negra m"** encuentre las negras en mediana. La normalización de acentos hace que
"postquirurgica" y "postquirúrgica" sean la misma consulta.

**Consulta con puntuación por relevancia:**

```sql
WITH q AS (SELECT normalizar($1) AS termino)
SELECT v.*,
  (  CASE WHEN b.code = $1                    THEN 1000 ELSE 0 END   -- código exacto
   + CASE WHEN v.sku  = $1                    THEN  900 ELSE 0 END   -- SKU exacto
   + CASE WHEN v.sku ILIKE $1 || '%'          THEN  500 ELSE 0 END   -- SKU parcial: "FJ-00"
   + ts_rank(v.search_document, plainto_tsquery('spanish', q.termino)) * 100
   + similarity(v.search_text, q.termino) * 50                       -- difusa (typos)
   + CASE WHEN sb.qty_available > 0           THEN   20 ELSE 0 END   -- con existencia arriba
   + CASE WHEN v.is_active                    THEN   10 ELSE 0 END
  ) AS score
FROM product_variants v
  LEFT JOIN barcodes b ON b.variant_id = v.id
  LEFT JOIN stock_balances sb ON …
WHERE v.deleted_at IS NULL
  AND ( v.search_document @@ plainto_tsquery('spanish', (SELECT termino FROM q))
        OR v.search_text % (SELECT termino FROM q)      -- operador trigram
        OR v.sku ILIKE $1 || '%'
        OR b.code = $1 )
ORDER BY score DESC
LIMIT 50;
```

**Multi-token con AND implícito:** "negra m" se divide en `negra` + `m` y exige que *ambos*
aparezcan, con relajación automática a OR ponderado si el AND no devuelve nada.

Rendimiento medido esperado: **menos de 30 ms con 100 000 variantes** gracias a los índices
GIN. El plan de consulta se verifica con `EXPLAIN ANALYZE` en las pruebas.

### Nivel 2 — POS (instantáneo, sin red)

El servidor rápido no basta: 30 ms de consulta más 60 ms de red más renderizado se sienten
lentos cuando se teclea letra por letra.

```
Al abrir turno:
  GET /catalog/snapshot?since=<última_sincronización>
    → ~2 MB comprimidos para 20 000 variantes
    → se guarda en IndexedDB
    → se construye índice uFuzzy en memoria

Mientras el cajero teclea:
  filtrado local           → 0 ms de red, resultados en el mismo cuadro de teclas
  muestra stock cacheado   → con marca de "hace N segundos"

Al agregar la línea al ticket:
  POST /sales/validate-line  → el servidor confirma existencia y precio REALES
  (la única verdad que importa es la del momento del cobro)

Sincronización incremental:
  cada 60 s (o por evento SSE) trae solo lo cambiado
```

Este es el diseño que hace que el POS se sienta más rápido que Eleventa: **no espera al
servidor para mostrar, pero nunca confía en el caché para cobrar.**

### Escáner de código de barras

El lector USB actúa como teclado. El POS distingue escáner de humano por la velocidad
entre pulsaciones (más de 50 caracteres por segundo) y, al detectar `Enter` tras una
ráfaga rápida:

1. Busca coincidencia exacta en `barcodes` (local, instantáneo).
2. Si hay una sola → agrega la línea directamente. **Sin clics.**
3. Si hay varias → muestra el desambiguador.
4. Si no hay ninguna → ofrece "crear producto con este código".

Funciona con el cursor en cualquier parte de la pantalla; el cajero no tiene que hacer clic
en el campo de búsqueda primero. Es un detalle pequeño que cambia la velocidad del mostrador.

## 7. Alertas de inventario

Generadas por evento (no por consulta periódica), visibles en el panel y opcionalmente
por correo o WhatsApp:

| Alerta | Disparador |
|---|---|
| Bajo stock | `qty_available <= reorder_point` |
| Agotado | `qty_available = 0` y el producto está activo |
| Sin movimiento | Sin ventas en N días (configurable) y con existencia |
| Sobrestock | `qty_on_hand > max_stock` |
| Diferencia de conteo | Conteo físico aplicado con diferencia mayor a un umbral |
| Costo anómalo | Recepción con costo que se desvía más de X % del promedio |
| Margen negativo | Precio de venta por debajo del costo promedio |

El último es especialmente útil cuando sube el costo de importación y los precios de venta
se quedan atrás: el sistema avisa antes de que se vendan cien piezas perdiendo dinero.
