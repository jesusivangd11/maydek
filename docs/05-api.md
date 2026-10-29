# 05 — Diseño de la API

> **Recordatorio de alcance:** aquí NO se desarrolla la página web. Se define el contrato
> que la página web existente consumirá como cliente externo.

## 1. Dos superficies distintas

| | API interna | API pública |
|---|---|---|
| Ruta | `/api/v1/**` | `/public/v1/**` |
| Consumidores | Panel admin, POS | Página web, Mercado Libre, app móvil |
| Autenticación | JWT (sesión de usuario) | Llave de API + HMAC |
| Estabilidad | Puede cambiar con el frontend | **Contrato con garantía de versión** |
| Datos expuestos | Todo (según permisos) | Solo lo que el canal necesita |
| Rate limit | Generoso | Por cliente, configurable |
| Ubicación | `src/modules/**/controllers` | `src/public-api/v1/**` |

**Por qué separarlas.** Si la web consumiera los mismos endpoints que el panel, cualquier
refactor interno rompería la tienda online sin aviso. Además, el panel expone costos y
márgenes que **nunca** deben salir hacia un cliente externo. La separación física hace que
esa fuga sea imposible por construcción, no por revisión.

## 2. Convenciones

```
Base            https://api.tudominio.com
Versión         en la ruta: /public/v1/…   (nunca se rompe dentro de v1)
Formato         JSON. snake_case en el cuerpo
Fechas          ISO 8601 con zona: 2026-09-05T14:30:00-06:00
Dinero          string decimal: "1499.50"   ← nunca number, evita errores de float
Cantidades      string decimal: "3.000"
IDs             UUID v7
Paginación      cursor: ?limit=50&cursor=<opaco>   (estable ante inserciones)
Ordenamiento    ?sort=-created_at
Filtros         ?filter[category_id]=…&filter[is_active]=true
Campos          ?fields=id,sku,name       (respuestas ligeras para la web)
Expansión       ?include=variants,images
Concurrencia    ETag + If-Match en actualizaciones
Idempotencia    cabecera Idempotency-Key en todo POST que cause efectos
Trazabilidad    X-Request-Id en toda respuesta
```

### Formato de error (uniforme en todo el sistema)

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "No hay existencia suficiente para completar la operación",
    "request_id": "01J8K2M4P6Q8R0S2T4V6W8X0Y2",
    "details": [
      {
        "variant_id": "01J8K2...",
        "sku": "FJ-0012-NEG-M",
        "name": "Faja Postquirúrgica X - Negro / M",
        "requested": "3.000",
        "available": "1.000"
      }
    ]
  }
}
```

El detalle **por línea** es deliberado: permite que la web muestre "solo queda 1 de este
artículo" en vez de un genérico "no se pudo procesar tu pedido".

Catálogo de códigos: `VALIDATION_ERROR` · `UNAUTHENTICATED` · `FORBIDDEN` · `NOT_FOUND` ·
`CONFLICT` · `INSUFFICIENT_STOCK` · `RESERVATION_EXPIRED` · `IDEMPOTENCY_CONFLICT` ·
`IDEMPOTENCY_IN_PROGRESS` · `RATE_LIMITED` · `CASH_SESSION_REQUIRED` ·
`PERIOD_CLOSED` · `INTERNAL_ERROR`.

## 3. API pública — lo que la web consume

### Catálogo (lectura)

```http
GET  /public/v1/products              # paginado, filtros, ?updated_since= para sincronizar
GET  /public/v1/products/{id}
GET  /public/v1/variants              # ?filter[product_id]= &filter[in_stock]=true
GET  /public/v1/variants/{id}
GET  /public/v1/categories            # árbol completo
GET  /public/v1/brands
GET  /public/v1/catalog/changes?since=<cursor>   # sincronización incremental
```

Solo aparecen productos con `is_web_visible = true`. **La web nunca ve el costo.**

### Existencias (lo más consultado)

```http
GET  /public/v1/stock?variant_ids=id1,id2,id3      # hasta 200 por llamada
POST /public/v1/stock/bulk                         # lotes grandes
```

```json
{
  "data": [
    {
      "variant_id": "01J8K2...",
      "sku": "FJ-0012-NEG-M",
      "available": "17.000",
      "in_stock": true,
      "warehouse_id": "01J8K1...",
      "as_of": "2026-09-05T14:30:00-06:00"
    }
  ]
}
```

**`available` = `on_hand − reserved`.** La web nunca recibe el stock físico: si lo recibiera,
vendería lo que ya está apartado para otro pedido. Este es el error número uno en
integraciones de e-commerce y aquí queda cerrado por diseño.

**Patrón recomendado para tu web:** no consultar en cada carga de página. Suscribirse al
webhook `STOCK_CHANGED`, mantener una copia local y consultar por API únicamente al entrar
al checkout, que es cuando la exactitud realmente importa.

### Precios

```http
GET  /public/v1/prices?variant_ids=…&customer_id=…
POST /public/v1/prices/quote          # cotiza un carrito completo con promociones
```

`quote` devuelve el total exacto que cobrará el sistema, incluyendo promociones, precio por
volumen e impuestos. **Tu web no debe calcular precios por su cuenta**: los pide y los
muestra. Así el POS y la web jamás pueden diferir.

### Reservas

```http
POST   /public/v1/reservations          # Idempotency-Key obligatoria
GET    /public/v1/reservations/{id}
PATCH  /public/v1/reservations/{id}     # extender TTL
DELETE /public/v1/reservations/{id}     # liberar
```

### Pedidos

```http
POST /public/v1/orders                  # Idempotency-Key obligatoria
GET  /public/v1/orders/{id}
GET  /public/v1/orders?external_id=…
POST /public/v1/orders/{id}/cancel
POST /public/v1/orders/{id}/fulfill     # marcar surtido / enviado
POST /public/v1/orders/{id}/returns
```

Ejemplo del cuerpo de creación de pedido:

```json
{
  "external_id": "WEB-2026-001042",
  "reservation_id": "01J8K3...",
  "customer": {
    "external_id": "cust_998",
    "name": "Ana Ramírez",
    "email": "ana@ejemplo.com",
    "phone": "5551234567"
  },
  "items": [
    { "variant_id": "01J8K2...", "qty": "2.000", "unit_price": "1499.50" }
  ],
  "payments": [
    { "method": "CARD", "amount": "2999.00", "reference": "mp_88421", "status": "CAPTURED" }
  ],
  "shipping": { "method": "ESTAFETA", "address": { } },
  "notes": "Entregar por la tarde"
}
```

El servidor **recalcula** precios e impuestos. Si `unit_price` no coincide con lo calculado,
responde `409 PRICE_MISMATCH` con ambos valores, en vez de aceptar en silencio un precio
equivocado.

## 4. Autenticación

### Usuarios (panel y POS)

```
POST /api/v1/auth/login       { email, password }
  → access_token  JWT, 15 minutos, en memoria (nunca en localStorage)
  → refresh_token cookie httpOnly + Secure + SameSite=Strict, 30 días, rotatorio

POST /api/v1/auth/refresh     rotación: el token usado se invalida al instante
POST /api/v1/auth/logout      revoca la sesión
GET  /api/v1/auth/me          usuario, roles, permisos efectivos, sucursales
```

**Detección de reutilización de token de refresco:** si llega un refresh ya consumido, se
revocan **todas** las sesiones de ese usuario y se registra en auditoría. Es la señal
clásica de un token robado.

`password_hash` con **argon2id** (no bcrypt: mejor resistencia a GPU). Bloqueo progresivo
tras intentos fallidos. MFA (TOTP) opcional, obligatorio para el rol Administrador.

### POS (terminal + PIN)

```
POST /api/v1/auth/terminal    { device_token }     → token de terminal, larga vida
POST /api/v1/auth/pin         { pin }              → sesión de cajero, corta vida
POST /api/v1/auth/authorize   { pin, action }      → autorización puntual de supervisor
```

El cajero no teclea correo y contraseña por venta. La terminal está registrada; el cajero se
identifica con PIN. `authorize` es el mecanismo del "PIN de supervisor" para acciones que
exceden el permiso del cajero, y **queda registrado en auditoría** con quién autorizó qué.

### Clientes máquina (la página web)

```http
Authorization: Bearer pk_live_a1b2c3…
X-Signature: sha256=<hmac del cuerpo con el secreto del cliente>
X-Timestamp: 1757088000
```

- La llave se muestra **una sola vez** al crearla; en la base vive solo su hash.
- El HMAC sobre el cuerpo evita manipulación en tránsito y ataques de repetición
  (ventana de 5 minutos con el timestamp).
- `scopes[]` limitan lo que cada llave puede hacer: `catalog:read`, `stock:read`,
  `orders:write`, `reservations:write`.
- Rotación sin caída: dos llaves activas simultáneas durante la transición.

## 5. Idempotencia

Requisito 27, obligatorio. Si la web reenvía el mismo pedido por un timeout, **no se
registran dos ventas**.

```
POST /public/v1/orders
Idempotency-Key: 01J8K3N5Q7R9T1V3X5Z7B9D1F3
```

```
                    ¿existe la clave para este cliente?
                                  │
              ┌───────────────────┼───────────────────┐
              │ NO                │ SÍ, COMPLETED     │ SÍ, IN_PROGRESS
              ▼                   ▼                   ▼
    INSERT (IN_PROGRESS)   ¿mismo hash del      409 IDEMPOTENCY_IN_PROGRESS
    ← UNIQUE lo hace       cuerpo?              Retry-After: 2
      atómico: dos             │
      peticiones               ├── SÍ  → devuelve la MISMA respuesta
      simultáneas,             │        guardada (mismo status y cuerpo)
      una gana                 │
              │                └── NO  → 422 IDEMPOTENCY_CONFLICT
              ▼                          (misma clave, cuerpo distinto)
    procesa la operación
              │
              ▼
    guarda respuesta → COMPLETED
```

La clave se guarda **dentro de la misma transacción** que la operación. No hay ventana en la
que la venta exista pero la clave no.

**Triple protección contra el pedido duplicado:**
1. `Idempotency-Key` — el nivel del protocolo.
2. `UNIQUE (channel_id, external_id)` en `external_orders` — el nivel del negocio: aunque
   la web mande dos claves distintas para el mismo pedido, el `external_id` lo detiene.
3. `reservation_id` — una reserva solo puede consumirse una vez.

Retención: 24 horas (configurable). Limpieza automática.

## 6. Webhooks

### Catálogo de eventos

```
PRODUCT_CREATED · PRODUCT_UPDATED · PRODUCT_ARCHIVED
VARIANT_CREATED · VARIANT_UPDATED · VARIANT_PRICE_CHANGED
STOCK_CHANGED   · LOW_STOCK_REACHED · OUT_OF_STOCK
SALE_CREATED    · SALE_COMPLETED · SALE_CANCELLED
RETURN_CREATED  · RETURN_COMPLETED
PURCHASE_RECEIVED
ORDER_CREATED   · ORDER_PAID · ORDER_FULFILLED · ORDER_CANCELLED
RESERVATION_CREATED · RESERVATION_EXPIRED · RESERVATION_RELEASED
CASH_SESSION_CLOSED
```

### Formato de entrega

```http
POST https://tuweb.com/webhooks/pos
X-Event-Id: 01J8K4...           ← clave de idempotencia para TI
X-Event-Type: STOCK_CHANGED
X-Signature: sha256=<hmac del cuerpo>
X-Timestamp: 1757088000
X-Delivery-Attempt: 1
```

```json
{
  "id": "01J8K4...",
  "type": "STOCK_CHANGED",
  "occurred_at": "2026-09-05T14:30:00-06:00",
  "data": {
    "variant_id": "01J8K2...",
    "sku": "FJ-0012-NEG-M",
    "warehouse_id": "01J8K1...",
    "available": "16.000",
    "previous_available": "17.000",
    "reason": "SALE",
    "reference_folio": "A-001-000046",
    "channel": "POS"
  }
}
```

### Garantías de entrega

**Patrón outbox transaccional** — la razón por la que este diseño es confiable:

```
   TRANSACCIÓN de la venta
   ├── INSERT sales
   ├── INSERT stock_ledger
   └── INSERT outbox_events        ← el evento nace con el dato
   COMMIT
        │
        ▼  (relay: LISTEN/NOTIFY + barrido cada 5 s como respaldo)
   BullMQ → entrega HTTP
        │
        ├── 2xx           → SUCCESS
        └── error/timeout → reintento: 1s, 5s, 30s, 2m, 10m, 1h, 6h (7 intentos)
                            → EXHAUSTED, alerta al admin
                            → tras 20 fallos seguidos, el endpoint se desactiva solo
```

Consecuencias:
- **Imposible** que exista una venta sin su evento (misma transacción).
- **Imposible** que se dispare un webhook de una venta que hizo rollback.
- Garantía **al-menos-una-vez**: tu web debe deduplicar por `X-Event-Id`. Está documentado
  en la guía de integración porque es la responsabilidad del consumidor.

Panel de webhooks: historial de entregas, cuerpo de petición y respuesta, reintento manual,
y **reproducción de eventos por rango de fechas** para cuando la web estuvo caída.

## 7. Verificación de firma (código de ejemplo para tu web)

```javascript
// Esto va en TU página web, no en este sistema.
const crypto = require('crypto');

function verificarWebhook(req, secreto) {
  const firma    = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];

  // rechaza repeticiones: máximo 5 minutos de antigüedad
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const esperada = 'sha256=' + crypto
    .createHmac('sha256', secreto)
    .update(timestamp + '.' + req.rawBody)
    .digest('hex');

  // comparación en tiempo constante: evita ataques de temporización
  return crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
}
```

## 8. Rate limiting

| Ámbito | Límite por defecto |
|---|---|
| Login | 5 por minuto por IP, 10 por hora por cuenta |
| API pública, lectura | 600 por minuto por cliente |
| API pública, escritura | 120 por minuto por cliente |
| Reservas | 60 por minuto por cliente |
| Búsqueda | 300 por minuto por usuario |
| Global por IP | 1 000 por minuto |

Respuesta `429` con `Retry-After` y cabeceras `X-RateLimit-*`. Implementado con Redis
(ventana deslizante). Configurable por cliente: la web puede tener un límite más alto que
un cliente nuevo.

## 9. Documentación y contrato

- **OpenAPI 3.1** generado del código, en `/docs` (protegido con contraseña en producción).
- **Cliente TypeScript generado** para el panel y el POS: cambiar el API rompe la
  compilación del frontend en CI, no en producción.
- **Guía de integración** (`docs/integration-guide.md`, Fase 11) con ejemplos ejecutables
  en JavaScript, PHP y Python, más una **colección de Postman** lista para importar.
- **Pruebas de contrato:** una suite verifica que las respuestas públicas conserven su forma.
  Quitar un campo de `/public/v1/**` hace fallar el CI.
- **Ambiente de pruebas (sandbox)** con datos ficticios para que quien integre la web pueda
  probar sin tocar inventario real.
