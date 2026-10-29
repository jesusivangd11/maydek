# 10 — Decisiones: resueltas y pendientes

**Actualizado el 5 de septiembre de 2026** con tus respuestas. Las cuatro decisiones que
bloqueaban la Fase 1 están **resueltas**.

---

## ✅ Decisiones tomadas

### D1 — Servidor en la nube (cloud-first) · RESUELTO

> El sistema es cloud-first. El POS, la administración y la API se conectan al servidor
> central. La prioridad es que el inventario esté disponible tanto para la tienda física
> como para la integración con la página web, **independientemente de que una computadora
> del local se apague o falle**.
>
> La contingencia offline del POS se analiza posteriormente, priorizando siempre la
> consistencia del inventario.

**Impacto en el diseño:**
- Topología cerrada en [`01-arquitectura.md`](01-arquitectura.md): VPS + Cloudflare, Caddy
  con TLS automático, Postgres y Redis en el mismo servidor, respaldo continuo a
  almacenamiento externo.
- Ninguna computadora del local es punto único de falla: si se quema la PC del mostrador, se
  abre el POS en otra máquina o tablet y se sigue vendiendo.
- El API queda públicamente accesible desde el día uno, sin IP fija ni túneles: la
  integración con la web no depende de la infraestructura de la tienda.
- **Contingencia offline** — el caché de lectura del POS entra en la Fase 4 (riesgo cero);
  la venta offline se analiza con datos reales en la Fase 12. Los tres niveles y su riesgo
  están en [`07-concurrencia.md`](07-concurrencia.md).

### D2 — CFDI preparado, no improvisado · RESUELTO

> Sí se contempla facturación CFDI, pero no necesariamente en la primera versión funcional.
> Se diseña desde ahora la arquitectura para integrar un PAC posteriormente. **No se
> implementa todavía una solución fiscal improvisada.**

**Impacto en el diseño:** documento nuevo, [`11-facturacion-cfdi.md`](11-facturacion-cfdi.md).

- **Fase 2 (≈3 días):** catálogos del SAT y campos fiscales en empresa, cliente, producto y
  métodos de pago. Se capturan mientras se da de alta el catálogo, cuando no cuesta nada.
- **Fase 13 (posterior):** timbrado real, factura global, autofacturación, cancelación.
- **Principio central:** la venta y la factura son documentos distintos con tiempos
  distintos. El cajero **nunca** espera al SAT; si el PAC está caído, la tienda sigue
  vendiendo. Un fallo de timbrado no puede corromper una venta ni el inventario.
- **Abstracción del PAC:** cambiar de proveedor es cambiar una variable de entorno.
  Ninguna otra parte del sistema conoce al PAC.

### D3 — Una sucursal hoy, multi-sucursal por diseño · RESUELTO

> Inicialmente tienda y bodega en el mismo espacio: 1 sucursal, 1 almacén principal. Pero la
> arquitectura debe permitir después varias sucursales, varios almacenes, traspasos e
> inventario independiente por ubicación.

**Impacto en el diseño:** confirma lo ya diseñado. Se añade una regla explícita de producto:

- El modelo es multi-sucursal y multi-almacén desde la Fase 1 — es la única forma de no tener
  que migrar cada movimiento histórico de inventario más adelante.
- **La interfaz oculta esa dimensión mientras haya una sola ubicación.** Sin selector de
  sucursal, sin selector de almacén, sin campos extra, sin pasos adicionales. El usuario no
  paga hoy por la flexibilidad de mañana.
- Al dar de alta la segunda ubicación, los selectores aparecen solos y las transferencias se
  habilitan. Sin migración, sin reconfiguración, sin reescribir historial.
- El almacén virtual de tránsito y el flujo de transferencias se construyen en la Fase 3,
  aunque no se usen hasta que exista la segunda ubicación.

### P6 — Política de devoluciones configurable · RESUELTO

> Configurable desde administración, no limitada a una sola política. Valores iniciales:
> 30 días, producto apto, ticket o venta localizable, reembolso preferente por el método
> original, opción de crédito a favor, cambios permitidos, autorización superior para
> efectivo y excepciones. El administrador puede modificar días, métodos y niveles después.

**Impacto en el diseño:** documento nuevo,
[`12-politica-devoluciones.md`](12-politica-devoluciones.md).

- Las reglas viven en `settings` con tipo, validación e historial — no en el código.
  Cambiarlas no requiere desplegar, y **cada cambio queda auditado**.
- `ReturnPolicyService.evaluate()` responde qué se puede hacer *antes* de que el cajero
  capture nada.
- La única regla sin excepción es que toda devolución esté ligada a su venta original. Todas
  las demás son subsanables con el permiso adecuado y dejan rastro.
- Se documenta explícitamente que **la devolución en tarjeta la ejecuta la terminal
  bancaria, fuera del sistema**: el sistema registra y concilia, nunca opera la terminal.

---

## Separación de responsabilidades (reafirmada)

```
   VENTA FÍSICA  ──►  POS
   VENTA ONLINE  ──►  API
   INVENTARIO    ──►  SISTEMA CENTRAL   ← única fuente de verdad para ambos
```

Esta separación ya es la columna del diseño y se hace cumplir por construcción:

| Frontera | Cómo se garantiza |
|---|---|
| El POS no es dueño del inventario | Solo llama a la API; no tiene lógica de stock propia |
| La web no es dueña del inventario | Solo consume `/public/v1/**`; recibe `available`, nunca el físico |
| Nadie escribe stock salvo el centro | `StockService.apply()` es el único escritor, y el rol de base de datos no tiene `UPDATE` sobre el libro de movimientos |
| Toda venta sabe de dónde vino | `channel_id` obligatorio en cada venta y en cada asiento de inventario |
| La API pública no puede filtrar costos | Superficie separada físicamente, con DTOs propios y pruebas de contrato |

**La página web existente no se reconstruye ni se modifica.** Solo se desarrolla la API
robusta para conectarla después, más la guía de integración, el SDK y el ambiente de pruebas
de la Fase 11.

---

## Problemas ya resueltos en el diseño

Estos quedaron incorporados con la propuesta que hice; no requieren más decisión tuya.

| # | Problema | Solución adoptada |
|---|---|---|
| **P1** | Precios duplicados en producto y en listas | Fuente única: `price_lists`. La pantalla del producto conserva las cuatro casillas de siempre |
| **P2** | Saldo del cliente como campo editable | Cuenta corriente por asientos; el saldo es la suma y hay estado de cuenta imprimible |
| **P3** | «Reservado» y «comprometido» como mecanismos separados | Un solo mecanismo, dos estados: `HELD` y `COMMITTED` |
| **P4** | Offline contra inventario único | Offline por niveles, con el riesgo declarado en cada uno. Nivel 0 en Fase 4, nivel 1 en Fase 12, nivel 2 descartado |
| **P7** | Códigos de barras duplicados entre proveedores | Tabla aparte, varios códigos por variante, unicidad global, colisión explicada |
| **P8** | Redondeo de efectivo | Columna de ajuste con regla configurable, visible en ticket y en corte |

---

## P5 — Costos de importación · PENDIENTE (no bloquea la Fase 1)

El modelo ya contempla el prorrateo de flete, aduana y gastos hasta la bodega
(`landed_unit_cost`). Lo que falta son tus datos reales para configurarlo bien. **Esto se
necesita hasta la Fase 6 (Compras), no antes.**

> **Necesito saber, antes de la Fase 6:**
> - ¿Cómo llega hoy la mercancía y qué gastos adicionales tiene?
> - ¿Compras en pesos mexicanos, dólares o pesos colombianos?
> - Si es en otra moneda, ¿a qué tipo de cambio se registra: el del día de la compra, el del
>   pago, o uno fijo? Esto cambia el modelo de costos y conviene definirlo antes de recibir
>   la primera compra en el sistema.

---

## Confirmaciones menores · abiertas, con valor por defecto

Ninguna bloquea. Si no dices nada, se implementa el valor propuesto y se puede cambiar
después desde configuración.

| # | Pregunta | Valor por defecto | Se necesita en |
|---|---|---|---|
| C1 | ¿Vender con stock en cero? | No, salvo permiso de gerente | Fase 4 |
| C2 | Vida de una reserva web | 20 minutos | Fase 10 |
| C3 | Descuento máximo del cajero sin autorización | 10 % | Fase 4 |
| C4 | ¿El POS pide cliente en cada venta? | No, opcional | Fase 4 |
| C5 | Número de terminales de caja | Configurable, soporta N | Fase 1 |
| C6 | ¿Báscula o venta por pieza? | Solo pieza | Fase 2 |
| C7 | Hora de corte del día operativo | 00:00 hora de México | Fase 5 |
| C8 | ¿Apartados con anticipo? | Sí, incluidos | Fase 7 |
| C9 | Idioma y moneda | Español México · MXN | Fase 1 |
| C10 | ¿Cuántos productos y variantes tienes hoy? | — | **Fase 2** |

**C10 es la única que conviene responder pronto**: dimensiona la estrategia de importación y
de búsqueda. Un catálogo de 300 variantes y uno de 30 000 se cargan de forma distinta.

---

## Datos útiles cuando los tengas a la mano

No bloquean la Fase 1, pero cuanto antes lleguen, mejor sale la Fase 2:

- **Exportación de tu catálogo actual de Eleventa** (CSV o Excel), aunque esté sucio. Sirve
  para diseñar el importador contra datos reales en vez de contra suposiciones.
- **Foto de un ticket actual**, para conservar el formato que tus clientes ya reconocen.
- **Modelo de la impresora térmica y del lector de código de barras.**
- **Volumen aproximado:** tickets por día, productos, variantes.
- **Dominio** que quieres usar para el API (por ejemplo `api.tudominio.com`).

---

## Lo que este proyecto no va a hacer

- ❌ Desarrollar, modificar o reemplazar tu página web
- ❌ Construir tienda online, carrito o pasarela de pago
- ❌ Integrar Mercado Libre, WhatsApp, Shopify o WooCommerce en este alcance — la
  arquitectura queda lista para agregarlos como módulos independientes
- ❌ Contabilidad, pólizas, balanza o declaraciones
- ❌ Timbrar CFDI antes de la Fase 13, ni con soluciones improvisadas
- ❌ Almacenar datos de tarjetas de crédito, nunca
