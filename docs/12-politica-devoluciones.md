# 12 — Política de devoluciones configurable

> **Decisión P6 tomada.** La política es **configurable desde administración**, no está
> escrita en el código. Lo que sigue son los valores iniciales que definiste; el
> administrador puede cambiarlos después sin desplegar nada.

## 1. El diseño: reglas como datos, no como código

Una política de devoluciones escrita en el código significa que cada cambio de criterio
—un fin de semana de promoción, una temporada alta, un cliente mayorista— es un despliegue.
Aquí las reglas viven en `settings`, con tipo, validación, valor por defecto e historial.

```
   ReturnPolicyService.evaluate(venta, líneas, usuario)
                            │
                            ▼
   { permitida: boolean
     resoluciones_disponibles: [REFUND_SAME_METHOD, STORE_CREDIT, EXCHANGE]
     autorizaciones_requeridas: ['return.refund_cash']
     violaciones: [{ regla, mensaje, subsanable_con_permiso }] }
```

El POS llama a este servicio **antes** de mostrar la pantalla de devolución, así que el
cajero ve de entrada qué puede hacer y qué necesita autorización — en vez de capturar todo
y toparse con un error al final.

## 2. Configuración inicial (tus valores)

```yaml
# Ventana de tiempo
returns.window_days:                    30       # ← configurable
returns.window_excludes_holidays:        false

# Localización de la venta original
returns.require_original_sale:           true    # SIEMPRE, no configurable
returns.require_physical_ticket:         false   # basta con localizar la venta

# Estado del producto
returns.require_good_condition:          true
returns.allowed_conditions:              [GOOD, DAMAGED]
returns.restock_default_condition:       GOOD

# Resolución
returns.preferred_refund_strategy:       SAME_METHOD
returns.allow_store_credit:              true
returns.allow_exchange:                  true
returns.allow_partial:                   true
returns.allow_cash_refund_for_card_sale: false   # → genera crédito a favor
returns.store_credit_expiry_days:        365

# Promociones
returns.promo_items_policy:              STORE_CREDIT_ONLY   # ALLOW | STORE_CREDIT_ONLY | DENY

# Autorización
returns.auth.cash_refund:                'return.refund_cash'
returns.auth.amount_threshold:           1000.00
returns.auth.outside_window:             'return.override_window'
returns.auth.damaged_restock:            'inventory.adjust'
returns.auth.no_original_ticket:         'return.approve'
```

**Cambiar cualquiera de estos valores es una acción auditada**: queda quién lo cambió,
cuándo, el valor anterior y el nuevo. Una política de devoluciones que se puede cambiar sin
rastro es un agujero por donde se va mercancía.

## 3. Localización de la venta original

Toda devolución está ligada a su venta. Esa regla **no es configurable**: sin ella, el
inventario y la caja dejan de ser explicables. Lo que sí es flexible es *cómo* se encuentra
esa venta:

```
Escaneo del código del ticket    ← instantáneo, es el camino normal
Folio tecleado                    A-001-000045
Últimos dígitos del folio         "45" busca entre los recientes de la sucursal
Por cliente                       lista sus compras, de la más reciente hacia atrás
Por fecha e importe               para el caso del ticket perdido
Por producto                      "¿quién compró esta faja en los últimos 30 días?"
```

Así se cubre tu requisito de «presentar ticket **o** poder localizar la venta en el sistema»
sin dejar al cajero atorado cuando el cliente llega sin papel.

## 4. Reembolso por el mismo método

Tu regla —devolver preferentemente por el método original— tiene una consecuencia práctica
que conviene dejar escrita, porque cada método se comporta distinto:

| Método original | Qué hace el sistema | Nota honesta |
|---|---|---|
| **Efectivo** | Registra la salida de caja y actualiza el arqueo | Si no hay efectivo suficiente en el cajón, ofrece crédito a favor o exige autorización para un retiro de bóveda |
| **Tarjeta** | Registra el pago negativo con la referencia de autorización que captura el cajero | **La devolución física la hace la terminal bancaria, fuera del sistema.** El sistema no puede —ni debe— operar la terminal. Registra y concilia |
| **Transferencia** | Queda en estado `PENDING` hasta que alguien confirma el traspaso | Evita dar por devuelto un dinero que todavía no salió |
| **Crédito de cliente** | Revierte el cargo en la cuenta corriente | Un asiento, no un ajuste de saldo |
| **Nota de crédito** | Regenera el crédito a favor | Con nueva vigencia |
| **Pago mixto** | Reparte proporcionalmente entre los métodos usados, o el cajero elige | Con el tope de no devolver por un método más de lo que entró por él |

Que el sistema **no** toque la terminal bancaria es deliberado: es lo que lo mantiene fuera
del alcance pesado de PCI y evita el peor escenario posible, que es un sistema que cree haber
devuelto un dinero que el banco nunca movió.

## 5. Cambios de producto

```
1. Se localiza la venta y se seleccionan las líneas a cambiar
2. Entra el producto devuelto (al almacén de venta o al de mermas, según su estado)
3. Se agregan los productos nuevos, al precio VIGENTE HOY
4. Se calcula la diferencia:
      diferencia > 0  →  el cliente paga (cualquier método, incluso mixto)
      diferencia < 0  →  se le devuelve o se genera crédito a favor, según la política
      diferencia = 0  →  no hay movimiento de caja
5. Se genera una venta nueva ligada a la devolución
```

El cambio se registra como **devolución + venta relacionadas**, no como una edición de la
venta original. La venta original queda intacta para siempre; es lo que permite que el
reporte de utilidad de aquel día siga siendo correcto.

## 6. Autorización escalonada

Cuando el cajero intenta algo que su rol no cubre, el sistema no lo bloquea con un error:
pide el PIN de alguien autorizado, ejecuta la acción y **la registra con quién la autorizó**.

| Situación | Requiere |
|---|---|
| Devolución dentro de política, con ticket | Nadie. El cajero procede |
| Devolución en efectivo | Permiso `return.refund_cash` |
| Monto por encima del umbral | PIN de supervisor |
| Fuera de los 30 días | Permiso `return.override_window` + motivo escrito |
| Sin ticket ni venta localizable | **Bloqueado.** No hay excepción |
| Producto en mal estado que se quiere revender | Permiso `inventory.adjust` |
| Producto comprado en promoción | Según `promo_items_policy` |

La única regla sin excepción posible es la de la venta original. Todas las demás son
subsanables por alguien con el permiso adecuado, y todas dejan rastro.

## 7. Efectos automáticos de toda devolución

Tal como pediste, en una sola transacción atómica:

```
╔═ TRANSACCIÓN ═══════════════════════════════════════════════════════╗
║  · Bloquea las líneas de la venta original (FOR UPDATE)              ║
║      → impide que dos terminales devuelvan lo mismo a la vez         ║
║  · Valida  SUM(ya devuelto) + nuevo  <=  vendido                     ║
║  · Crea la devolución con el PRECIO y el COSTO ORIGINALES            ║
║  · INVENTARIO   StockService.apply(entradas)                         ║
║        GOOD    → almacén de venta, al costo con el que salió         ║
║        DAMAGED → almacén de mermas                                   ║
║  · CAJA         movimiento de salida, si el reembolso es en efectivo ║
║  · CLIENTE      asiento en cuenta corriente o nota de crédito        ║
║  · FISCAL       marca la venta para generar CFDI de Egreso (Fase 13) ║
║  · AUDITORÍA    quién devolvió, quién autorizó, motivo               ║
║  · EVENTOS      RETURN_CREATED · STOCK_CHANGED                       ║
╚═══════════════════════════ COMMIT ═══════════════════════════════════╝
```

El bloqueo de las líneas originales resuelve un caso real que casi ningún POS contempla: el
mismo ticket presentado en dos cajas al mismo tiempo. Sin él, se puede devolver más de lo que
se vendió.

## 8. Devoluciones del canal web

Entran por la misma ruta con `channel_id = WEB`, mediante
`POST /public/v1/orders/{id}/returns`, con una diferencia importante:

```
   Solicitud desde la web  →  estado PENDING
                              ↓  el inventario NO se mueve todavía
   La mercancía llega físicamente y se revisa
                              ↓
   Recepción en el sistema  →  estado COMPLETED
                              ↓  ahora sí: inventario + reembolso
```

**El inventario no se incrementa cuando el cliente dice que va a devolver, sino cuando la
faja está de vuelta en la bodega y alguien la revisó.** Es la diferencia entre un inventario
que refleja la realidad y uno que refleja intenciones.

## 9. Reportes que habilita esta configuración

- Devoluciones por periodo, motivo, producto y cajero.
- **Tasa de devolución por producto** — señala modelos o tallas con problema de calidad o de
  tabla de medidas, que en fajas es información de compra directamente accionable.
- Devoluciones por cajero comparadas con el promedio — detección de patrones inusuales.
- Mercancía devuelta en mal estado y su costo acumulado.
- Créditos a favor emitidos, usados y por vencer.
- Devoluciones fuera de política y quién las autorizó.
