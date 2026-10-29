# 07 — Concurrencia y consistencia del inventario

Este documento responde de forma explícita a tu requisito 24.

## El problema

```
   Stock físico de "Faja X / Negro / M" = 1

   Cliente A                                 Cliente B
   compra en la página web                   compra en el mostrador
        │                                          │
        └──────────── al mismo tiempo ─────────────┘

   ¿Qué impide vender la misma pieza dos veces?
```

En un sistema ingenuo (leer stock → validar en memoria → escribir stock) ambas peticiones
leen `1`, ambas concluyen "sí hay", y ambas escriben `0`. Se vendieron dos, había una. El
cliente que no recibe su faja se entera tres días después.

## La solución: cinco capas independientes

Ninguna capa por sí sola es suficiente. Juntas, la venta doble es imposible.

```
   ┌─────────────────────────────────────────────────────────────────┐
   │ CAPA 1 · Transacción de base de datos                           │
   │   Todo o nada. Sin estados intermedios visibles.                │
   ├─────────────────────────────────────────────────────────────────┤
   │ CAPA 2 · Bloqueo pesimista de fila (SELECT … FOR UPDATE)        │
   │   Serializa a los compradores del MISMO producto.               │
   │   Compradores de productos distintos no se estorban.            │
   ├─────────────────────────────────────────────────────────────────┤
   │ CAPA 3 · Restricciones CHECK en la base                         │
   │   qty_on_hand >= 0 · qty_reserved <= qty_on_hand                │
   │   Último recurso: un bug produce error, no corrupción.          │
   ├─────────────────────────────────────────────────────────────────┤
   │ CAPA 4 · Reservas                                               │
   │   Aparta el stock ANTES de cobrar. Reduce la ventana a cero.    │
   ├─────────────────────────────────────────────────────────────────┤
   │ CAPA 5 · Idempotencia                                           │
   │   Un reintento no crea una segunda venta.                       │
   └─────────────────────────────────────────────────────────────────┘
```

## Capa 2 en detalle — el bloqueo

```sql
BEGIN;  -- READ COMMITTED (suficiente con bloqueo explícito)

-- ORDEN DETERMINISTA: siempre ordenado por (variant_id, warehouse_id, condition).
-- Sin este ORDER BY, dos transacciones que tocan los mismos dos productos
-- en orden inverso se bloquean mutuamente para siempre (deadlock).
SELECT variant_id, warehouse_id, qty_on_hand, qty_reserved, avg_cost
FROM   stock_balances
WHERE  (variant_id, warehouse_id, condition) IN (…)
ORDER  BY variant_id, warehouse_id, condition
FOR UPDATE;
-- ↑ desde aquí, cualquier otra transacción que quiera estas filas ESPERA

-- ahora la lectura es de verdad: nadie más puede cambiarla
-- valida, inserta el asiento, actualiza el saldo

COMMIT;  -- se liberan los bloqueos, el siguiente en la fila continúa
```

### La secuencia real, paso a paso

```
t=0ms   Cliente A (WEB)                    Cliente B (POS)
        POST /public/v1/reservations       POST /api/v1/sales

t=1ms   BEGIN
        SELECT … FOR UPDATE
        ✓ obtiene el bloqueo                BEGIN
        qty_on_hand=1, reserved=0           SELECT … FOR UPDATE
        disponible = 1                      ⏸ ESPERA (fila bloqueada)

t=3ms   1 >= 1  ✓                           ⏸
        INSERT reservations (HELD)          ⏸
        UPDATE reserved = 1                 ⏸
        COMMIT ─────────────────────────►   ▶ obtiene el bloqueo

t=5ms                                       qty_on_hand=1, reserved=1
                                            disponible = 1 − 1 = 0
                                            0 >= 1  ✗
                                            ROLLBACK
                                            → 409 INSUFFICIENT_STOCK

t=6ms   ← 201 Reserva creada                ← 409, con el detalle:
          expires_at: +20 min                  "Faja X Negro/M:
                                                solicitado 1, disponible 0"
```

**El cajero ve inmediatamente**: *"Este artículo está apartado para un pedido web en curso.
Disponible: 0."* — y puede decidir con información, no descubrir el faltante al día
siguiente. Si el pedido web se cae en el pago, la reserva expira en 20 minutos y la pieza
vuelve al mostrador automáticamente.

### Por qué bloqueo pesimista y no optimista

| | Pesimista (elegido) | Optimista (versión + reintento) |
|---|---|---|
| Comportamiento bajo conflicto | El segundo espera unos milisegundos | El segundo falla y hay que reintentar |
| Complejidad del código | Baja: una cláusula `FOR UPDATE` | Alta: bucle de reintentos en todas partes |
| Riesgo para el cajero | Ninguno: espera imperceptible | Errores esporádicos e inexplicables |

Los conflictos reales sobre el mismo SKU son raros (decenas por día como mucho), y las
transacciones duran milisegundos. El bloqueo pesimista es la respuesta correcta aquí: más
simple y más predecible.

**Concurrencia optimista sí se usa**, pero para otra cosa: la edición de catálogo y precios
(`version` + `If-Match`), donde dos personas editando el mismo producto deben enterarse del
conflicto en vez de pisarse.

## Prevención de bloqueos mutuos (deadlocks)

Tres medidas:

1. **Orden determinista de bloqueo** — siempre `ORDER BY variant_id, warehouse_id, condition`.
   Esta única regla elimina la causa clásica del deadlock.
2. **`lock_timeout = 3s`** — si una transacción no obtiene el bloqueo en 3 segundos, falla
   con un error claro en vez de colgar la caja indefinidamente.
3. **`statement_timeout = 10s`** en las conexiones de la aplicación (más generoso en los
   workers de reportes).

Además, PostgreSQL detecta deadlocks y aborta una de las transacciones; la aplicación
reintenta una sola vez y, si vuelve a ocurrir, lo registra como incidente para investigar.

## Alcance del bloqueo

El bloqueo es **por fila de saldo**, es decir por combinación (variante, almacén, condición).

```
Venta 1: Faja Negro/M  ─┐
                        ├── NO se estorban: filas distintas, en paralelo
Venta 2: Faja Beige/L  ─┘

Venta 3: Faja Negro/M  ─┐
                        ├── SÍ se serializan: la misma fila
Venta 4: Faja Negro/M  ─┘
```

En un ticket de 10 artículos distintos se bloquean 10 filas — pero solo esas. Dos cajeros
vendiendo cosas diferentes nunca se esperan.

## Aislamiento por operación

| Operación | Nivel | Motivo |
|---|---|---|
| Venta, compra, devolución | `READ COMMITTED` + `FOR UPDATE` | El bloqueo explícito ya garantiza corrección; es el nivel más rápido |
| Corte Z de caja | `SERIALIZABLE` | Debe fotografiar un conjunto consistente de movimientos |
| Reportes | `REPEATABLE READ` en réplica de lectura | Consistencia interna sin bloquear la operación |
| Verificación de saldos | `SERIALIZABLE` | Compara ledger contra saldos: no admite lecturas fantasma |

## Idempotencia (capa 5)

El escenario: la web envía un pedido, el servidor lo procesa correctamente, pero la respuesta
se pierde por un timeout de red. La web reintenta. Sin protección, se registran dos ventas y
se descuenta el doble de inventario.

```
Petición 1 ──► servidor: crea la venta ──► respuesta ✗ SE PIERDE
Petición 2 ──► servidor: ¿clave conocida? SÍ, COMPLETED
                         ¿mismo cuerpo?   SÍ
              ──► devuelve la MISMA respuesta guardada
                  Sin crear nada. Sin tocar inventario.
```

La clave se inserta con `UNIQUE` **dentro de la transacción de la venta**. Si dos peticiones
idénticas llegan al mismo milisegundo, una gana el `INSERT` y la otra recibe
`409 IDEMPOTENCY_IN_PROGRESS` con `Retry-After`. No hay ventana de carrera.

Detalle completo en [`05-api.md`](05-api.md).

## Qué NO se hace, y por qué

| Antipatrón | Por qué se evita |
|---|---|
| Bloquear en Redis en vez de en la base | Redis puede perder el bloqueo en un failover. La verdad del inventario vive en Postgres; el bloqueo debe vivir donde vive el dato |
| Cola global de ventas | Serializar *todas* las ventas mata el rendimiento. Bloquear por fila solo serializa a quienes compiten de verdad |
| Leer stock, validar en la aplicación, luego escribir | Es exactamente el bug que este documento previene |
| `UPDATE stock SET qty = qty - 1` sin verificar | Actualiza atómicamente, pero deja el saldo en negativo en vez de rechazar la venta |
| Compensación posterior ("ya lo arreglo con un ajuste") | El cliente ya se fue con la mercancía que no había. La consistencia debe ser inmediata |

## Modo offline del POS: la tensión honesta

Tu requisito 33 pide analizar el trabajo offline. Aquí está el análisis sin rodeos:

**Existe una contradicción real entre "un solo inventario central" y "vender sin conexión".**
Si el POS vende sin poder consultar el servidor, no puede saber si la web acaba de vender la
última pieza. Cualquier sistema que prometa ambas cosas al 100% está ocultando algo.

### La solución propuesta: offline por capas

```
NIVEL 0 · Lectura offline                            ← FASE 4 (desde el inicio)
  Catálogo, precios y último stock conocido en IndexedDB.
  El POS consulta y cotiza sin conexión. Riesgo: cero.

NIVEL 1 · Venta offline en efectivo                  ← FASE 12
  Solo si: pago 100% en efectivo, sin crédito, sin promociones complejas.
  El ticket se encola con un UUID generado localmente (que es su clave de idempotencia).
  Al recuperar conexión se sincroniza en orden.
  Riesgo: sobreventa acotada, si la web vendió lo mismo mientras tanto.

NIVEL 2 · Todo offline                               ← NO SE HARÁ
  Descartado. El costo de resolver conflictos de crédito, promociones y caja
  supera con mucho el beneficio.
```

### Mitigación del riesgo del Nivel 1

1. **Colchón de seguridad configurable:** los últimos N artículos de cada variante (por
   defecto 1) no se venden offline. En productos de baja rotación —la mayoría de tu
   catálogo— esto elimina el riesgo casi por completo.
2. **Aviso visible:** el POS muestra una banda ámbar *"Sin conexión — venta en efectivo
   únicamente"*. El cajero sabe en qué modo está.
3. **Reporte de conflictos:** si al sincronizar el stock resultó insuficiente, la venta
   **se registra igual** (la mercancía ya salió físicamente: negarlo sería mentirle al
   inventario) y se genera una alerta para revisión, con el detalle exacto.
4. **Límite de tiempo:** pasadas 4 horas sin conexión, el POS pide confirmación explícita
   de un gerente para seguir vendiendo offline.

**Recomendación:** implementar el Nivel 0 en la Fase 4 y evaluar el Nivel 1 en la Fase 12
con datos reales de estabilidad de tu conexión. Si tu internet es confiable, el Nivel 1
puede no llegar a justificarse nunca.

## Verificación: cómo se prueba todo esto

La corrección bajo concurrencia no se afirma, se demuestra:

```typescript
// test/concurrency/oversell.spec.ts
it('no permite sobrevender con 50 compradores simultáneos y 1 pieza', async () => {
  await darDeAltaStock({ variantId, qty: 1 });

  const intentos = Array.from({ length: 50 }, () =>
    api.post('/sales', ticketDeUnaPieza).catch(e => e.response)
  );
  const resultados = await Promise.all(intentos);

  expect(resultados.filter(r => r.status === 201)).toHaveLength(1);
  expect(resultados.filter(r => r.status === 409)).toHaveLength(49);

  const saldo = await obtenerSaldo(variantId);
  expect(saldo.qty_on_hand).toBe('0.000');

  // y el ledger cuadra con el saldo
  await expect(verificarIntegridad(variantId)).resolves.toEqual({ discrepancias: 0 });
});
```

Pruebas equivalentes para: reserva contra venta, dos devoluciones simultáneas del mismo
ticket, dos recepciones de la misma orden, y cierre de caja mientras entra una venta.
Corren contra **PostgreSQL real** (Testcontainers), no contra un simulador — un mock no
tiene bloqueos de fila y aprobaría código roto.
