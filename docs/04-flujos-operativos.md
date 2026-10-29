# 04 — Flujos operativos

Cada flujo indica explícitamente qué ocurre **dentro de la transacción** (atómico, todo o
nada) y qué ocurre **después del commit** (asíncrono, con reintentos).

---

## 1. Flujo de venta en el POS

```
┌─ CAJERO ────────────────────────────────────────────────────────────┐
│                                                                     │
│  1. Escanea o teclea            → búsqueda LOCAL, resultados al vuelo│
│  2. Agrega línea                → POST /sales/validate-line         │
│                                   el servidor confirma stock + precio│
│  3. Ajusta cantidad / descuento → si excede su límite: PIN supervisor│
│  4. Selecciona cliente (opcional) → recalcula lista de precios       │
│  5. F12 → Cobrar                                                    │
│  6. Captura pagos (mixto permitido)                                 │
│  7. Confirma                    → POST /sales                       │
│                                   Idempotency-Key: <uuid del ticket>│
└─────────────────────────────────────────────────────────────────────┘
                                    │
╔═══════════════════════════════════▼═════════════════════════════════╗
║  TRANSACCIÓN (todo o nada)                                          ║
║                                                                     ║
║   a. Verifica clave de idempotencia    → si existe, devuelve la     ║
║                                          respuesta guardada y sale  ║
║   b. Valida sesión de caja abierta en esta terminal                 ║
║   c. Bloquea saldos: SELECT … FOR UPDATE (orden determinista)       ║
║   d. Recalcula precios EN EL SERVIDOR   ← nunca confía en el cliente║
║   e. Aplica promociones vigentes                                    ║
║   f. Calcula impuestos, descuentos, redondeo de efectivo            ║
║   g. Valida SUM(pagos) >= total                                     ║
║   h. Genera folio (secuencia de la sucursal)                        ║
║   i. INSERT sales + sale_items                                      ║
║        ↳ copia sku, nombre, PRECIO y COSTO (fotografía inmutable)   ║
║   j. INSERT payments                                                ║
║   k. StockService.apply(salidas)  → ledger + saldos                 ║
║   l. Si consume reservas → marca CONSUMED y libera qty_reserved     ║
║   m. INSERT cash_movements (solo la parte en efectivo)              ║
║   n. Si hay venta a crédito → INSERT customer_account_entries       ║
║   o. AuditService.record('sale.create')                             ║
║   p. Outbox: SALE_CREATED, SALE_COMPLETED, STOCK_CHANGED            ║
║   q. Guarda respuesta de idempotencia                               ║
║                                COMMIT                               ║
╚═════════════════════════════════════════════════════════════════════╝
                                    │
┌─ DESPUÉS DEL COMMIT ───────────────▼────────────────────────────────┐
│  · Imprime ticket (print-bridge → ESC/POS) y abre el cajón          │
│  · Relay de outbox → webhooks a la web (STOCK_CHANGED)              │
│  · Actualiza métricas del cliente (total comprado, última compra)   │
│  · Evalúa alertas de bajo stock                                     │
│  · Refresca el dashboard vía SSE                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Decisión clave — el precio se recalcula siempre en el servidor.** El POS muestra un precio
estimado; el servidor calcula el definitivo con el mismo `PricingService` que usa la web.
Si el cliente enviara un precio manipulado, se ignora. Si el precio cambió mientras el
ticket estaba abierto, el sistema avisa antes de cobrar en vez de cobrar mal en silencio.

**Ventas suspendidas:** `held_sales` guarda el carrito serializado. Suspender **no reserva
inventario** (decisión deliberada: un ticket olvidado no debe congelar mercancía). Al
recuperarlo se revalida todo y se avisa de lo que cambió.

---

## 2. Flujo de compra

```
   ┌──────────────┐   opcional    ┌──────────────┐
   │ ORDEN DE     │──────────────►│  RECEPCIÓN   │  ← el inventario entra AQUÍ
   │ COMPRA       │   (se puede   │              │
   │ status: SENT │    recibir    │  1..N por    │
   └──────────────┘    sin orden) │    orden     │
                                  └──────────────┘
```

**La orden de compra NO toca el inventario.** Solo la recepción genera asientos. Esta
separación es lo que hace posible tu ejemplo del requisito 12 sin ningún caso especial:

```
Orden PO-000015 · Proveedor: Fajas Colombia S.A.S.
  Faja X / Negro / M     ordenadas 100    recibidas   0    pendientes 100

  → Llega el primer embarque: 80 piezas
    RECEPCIÓN REC-000031

    TRANSACCIÓN:
      · INSERT purchase_receipts + purchase_receipt_items (80)
      · Prorratea flete y gastos → landed_unit_cost
      · StockService.apply(entrada 80 @ landed_unit_cost)
          → recalcula costo promedio ponderado
      · UPDATE purchase_order_items.qty_received = 80
      · Recalcula estado de la orden → PARTIALLY_RECEIVED
      · INSERT supplier_prices (historial de costo)
      · UPDATE product_variants.last_cost
      · Outbox: PURCHASE_RECEIVED, STOCK_CHANGED
    COMMIT

  Estado resultante:
    ordenadas 100    recibidas  80    pendientes  20
    Inventario: +80   ← únicamente lo recibido
```

Las 20 restantes quedan visibles como pendientes. Se reciben después (segunda recepción,
la orden pasa a `RECEIVED`) o se cierra la orden por faltante definitivo, dejando el motivo
registrado.

**Prorrateo de costos de importación:** flete, aduana y otros gastos de la recepción se
reparten entre las líneas por valor (por defecto) o por peso. El costo que entra al
inventario es el costo **real puesto en bodega**, no el de la factura del proveedor. Para
una distribuidora que importa de Colombia, esta diferencia decide si el margen calculado es
real o ficticio.

---

## 3. Flujo de devolución

```
1. Cajero busca el ticket (folio, escaneo del código del ticket, o por cliente)
2. El sistema muestra las líneas y lo YA devuelto de cada una
3. Selecciona líneas y cantidades  → valida qty <= (vendida − ya devuelta)
4. Por cada línea, indica el estado: BUENO (revende) o DAÑADO (merma)
5. Elige el tipo de resolución
6. Autorización con PIN si el rol lo exige
```

```
╔═ TRANSACCIÓN ═══════════════════════════════════════════════════════╗
║  a. Bloquea sale_items (FOR UPDATE) ← impide devolver dos veces      ║
║     lo mismo desde dos terminales                                    ║
║  b. Valida SUM(devuelto) + nuevo <= vendido                          ║
║  c. INSERT returns + return_items                                    ║
║       ↳ usa el PRECIO y el COSTO ORIGINALES de la venta              ║
║  d. UPDATE sale_items.returned_qty                                   ║
║  e. UPDATE sales.status → PARTIALLY_RETURNED | RETURNED              ║
║  f. StockService.apply(entradas)                                     ║
║       BUENO  → almacén de venta, condition GOOD, al costo original   ║
║       DAÑADO → almacén de mermas, condition DAMAGED                  ║
║  g. Resolución:                                                      ║
║       REFUND       → INSERT payments (negativo) + cash_movements     ║
║       STORE_CREDIT → INSERT credit_notes (crédito a favor)           ║
║       EXCHANGE     → crea venta nueva; la diferencia se cobra o abona║
║  h. Auditoría + Outbox: RETURN_CREATED, STOCK_CHANGED                ║
║                            COMMIT                                    ║
╚══════════════════════════════════════════════════════════════════════╝
```

**Reglas de negocio configurables** (en `settings`, no en código):

- Días máximos para devolver (por defecto 30).
- ¿Se permite devolución en efectivo de una venta pagada con tarjeta? (por defecto no:
  genera crédito a favor).
- Monto a partir del cual se exige autorización de supervisor.
- ¿Se permite devolver productos en promoción?

Las devoluciones de pedidos web entran por la misma ruta, con `channel_id = WEB`, y quedan
en `PENDING` hasta que la mercancía físicamente llega.

---

## 4. Flujo de caja

```
  APERTURA                    OPERACIÓN                     CIERRE
  ────────                    ─────────                     ──────
  Cajero + PIN          Ventas en efectivo (+)         Corte X: reporte
  Fondo inicial   ───►  Ventas con tarjeta (informativo) parcial, NO cierra
  Terminal              Devoluciones (−)           ───►  (se puede repetir)
  status: OPEN          Entradas de efectivo (+)              │
                        Retiros a bóveda (−)                  ▼
                        Gastos (−)                      Corte Z: arqueo
                                                        y cierre definitivo
```

**Arqueo (corte Z):**

```
Sesión CS-000042 · Terminal: Caja 1 · Cajero: María López
Abierta:  05/09/2026 09:00     Cerrada: 05/09/2026 20:15

EFECTIVO
  Fondo inicial                              $  2,000.00
  + Ventas en efectivo         (47 tickets)  $ 38,450.00
  + Entradas de efectivo        (1)          $    500.00
  − Devoluciones en efectivo    (2)          $ −1,200.00
  − Retiros a bóveda            (1)          $−20,000.00
  − Gastos                      (1)          $   −350.00
  ─────────────────────────────────────────────────────
  EFECTIVO ESPERADO                          $ 19,400.00
  EFECTIVO CONTADO                           $ 19,350.00
  DIFERENCIA                                 $    −50.00   ⚠ FALTANTE

OTROS MÉTODOS (informativos, no afectan el cajón)
  Tarjeta                      (31)          $ 52,300.00
  Transferencia                 (4)          $  8,900.00
  Crédito a clientes            (2)          $  3,400.00
  ─────────────────────────────────────────────────────
  VENTA TOTAL DEL TURNO        (84 tickets)  $103,050.00
  Ticket promedio                            $  1,226.79
```

**Reglas:**
- `expected_cash` **nunca** es un campo editable: se calcula sumando `cash_movements`.
- El conteo se captura por denominación (billetes y monedas) y el sistema suma. Menos errores
  que teclear un total.
- Toda diferencia queda registrada con usuario, hora y comentario obligatorio. **No se puede
  cerrar una caja con diferencia sin escribir un motivo.**
- Una diferencia superior al umbral configurado exige PIN de supervisor para cerrar.
- No se puede abrir una sesión nueva en la terminal si hay una anterior sin cerrar.
- El corte Z es irreversible; el corte X se puede sacar las veces que haga falta.

---

## 5. Flujo de reserva (pedidos web)

Este flujo es el corazón de la integración con tu página. Ver también
[`07-concurrencia.md`](07-concurrencia.md).

```
┌── LA WEB ─────────────────────────────────────────────────────────────┐
│                                                                       │
│ 1. Cliente entra al checkout                                          │
│    POST /public/v1/reservations                                       │
│    Idempotency-Key: <uuid del carrito>                                │
│    { items: [{ variant_id, qty }], ttl_minutes: 20 }                  │
│                                                                       │
│    ╔═ TRANSACCIÓN ══════════════════════════════════════════════╗     │
│    ║  bloquea saldos (FOR UPDATE, orden determinista)           ║     │
│    ║  por cada línea: disponible = on_hand − reserved           ║     │
│    ║    si disponible < qty → 409 con el detalle POR LÍNEA      ║     │
│    ║  INSERT reservations (status HELD, expires_at = ahora+20m) ║     │
│    ║  UPDATE stock_balances.qty_reserved += qty                 ║     │
│    ║  Outbox: STOCK_CHANGED                                     ║     │
│    ╚════════════════════════════════════════════════════════════╝     │
│    ← 201 { reservation_id, expires_at, items[] }                      │
│                                                                       │
│ 2a. PAGO APROBADO                                                     │
│     POST /public/v1/orders  { reservation_id, payment, customer }     │
│       → reserva HELD pasa a COMMITTED (deja de expirar)               │
│       → crea external_order (status PAID)                             │
│       → crea sale (channel = WEB, fulfillment = PENDING)              │
│       → CONSUME la reserva: qty_reserved −= qty                       │
│                             qty_on_hand  −= qty   ← salida real       │
│       → Outbox: ORDER_PAID, SALE_CREATED, STOCK_CHANGED               │
│                                                                       │
│ 2b. PAGO RECHAZADO o cliente abandona                                 │
│     DELETE /public/v1/reservations/{id}   → RELEASED                  │
│     …o el sweeper la vence sola a los 20 minutos → EXPIRED            │
│     En ambos casos: qty_reserved −= qty  (el stock vuelve a la venta) │
└───────────────────────────────────────────────────────────────────────┘
```

**Por qué reservar en el checkout y no en el carrito.** Reservar cuando alguien agrega al
carrito congela mercancía por carritos que nunca se pagan (la mayoría). Reservar solo al
entrar al checkout, con vida corta, protege la venta real sin bloquear la tienda. Si tu web
tiene mucho tráfico y poco inventario, la alternativa es reservar con TTL muy corto (5 min)
también en el carrito; es configurable por canal (`channels.reservation_ttl_minutes`).

**El sweeper** corre cada minuto:

```sql
UPDATE reservations SET status = 'EXPIRED', updated_at = now()
WHERE status = 'HELD' AND expires_at < now()
RETURNING variant_id, warehouse_id, qty;
-- y decrementa qty_reserved en la misma transacción
```

---

## 6. Flujo de transferencia entre almacenes

```
  ALMACÉN ORIGEN            EN TRÁNSITO             ALMACÉN DESTINO
  ──────────────            ───────────             ───────────────
  qty_on_hand −= 10  ───►   qty_on_hand += 10  ───► qty_on_hand += 10
  TRANSFER_OUT              (almacén virtual)       TRANSFER_IN
                            TRANSFER_OUT/IN
       │                          │                       │
    ENVÍO                    en camino                RECEPCIÓN
```

La mercancía **nunca desaparece del sistema**: mientras viaja vive en el almacén virtual
`TRANSIT` del destino. El inventario total de la empresa siempre cuadra.

Recepción con diferencia: se reciben 8 de 10. Las 2 faltantes quedan en tránsito hasta que
alguien las concilia con un ajuste que exige motivo y autorización. Nada se pierde en
silencio.

---

## 7. Flujo de importación masiva

Cumple tu requisito 31 (vista previa obligatoria antes de aplicar).

```
1. SUBIR          CSV o Excel → se detectan columnas automáticamente
2. MAPEAR         columna del archivo → campo del sistema (se guarda la plantilla)
3. VALIDAR        fila por fila, SIN escribir nada:
                    ✓ 1,203 filas listas
                    ⚠   45 filas actualizarán un producto existente (por SKU)
                    ✗   12 filas con error:
                        fila 89  → SKU duplicado en el archivo
                        fila 204 → categoría "Fajaz" no existe (¿"Fajas"?)
                        fila 511 → costo no numérico: "450,00 COP"
4. PREVISUALIZAR  tabla con el ANTES y el DESPUÉS de cada cambio
5. CONFIRMAR      requiere escribir explícitamente la palabra de confirmación
6. APLICAR        en lotes, con barra de progreso, y REVERSIBLE:
                    cada importación es un import_job con su rollback
```

La importación de **inventario inicial** genera asientos `INITIAL_LOAD` en el ledger, no
un `UPDATE` de saldos: el arranque del sistema también queda auditado desde el día uno.
