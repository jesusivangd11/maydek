# Resumen ejecutivo — Sistema Central de Punto de Venta e Inventario

> **Estado:** diseño cerrado. Decisiones **D1, D2, D3 y P6 resueltas** el 5 de septiembre
> de 2026. No se ha escrito código de producción; la Fase 1 arranca al aprobarse.

## Qué es este proyecto

El **Sistema Central**: la única fuente de verdad del inventario, catálogo, ventas,
compras, caja y administración de la distribuidora. El POS físico y la página web
existente son **canales** que consumen este sistema; ninguno tiene inventario propio.

```
                     ┌───────────────────────────────┐
                     │      SISTEMA CENTRAL          │
                     │  (fuente única de verdad)     │
                     │                               │
                     │  Catálogo · Inventario · Caja │
                     │  Ventas · Compras · Reportes  │
                     └───────────────┬───────────────┘
                                     │  API REST v1
             ┌───────────────┬───────┴────────┬─────────────────┐
             ↓               ↓                ↓                 ↓
      ┌────────────┐  ┌─────────────┐  ┌────────────┐  ┌────────────────┐
      │ POS FÍSICO │  │ ADMIN WEB   │  │ PÁGINA WEB │  │ FUTUROS CANALES│
      │ (tablet/PC)│  │ (PC/móvil)  │  │ (existente)│  │ ML · WhatsApp  │
      └────────────┘  └─────────────┘  └────────────┘  └────────────────┘
        canal=POS                        canal=WEB       canal=MERCADO_LIBRE
```

**La página web NO se reconstruye.** Solo se le entrega una API.

## Decisiones principales

| Área | Decisión | Por qué |
|---|---|---|
| Backend | **NestJS 11 + TypeScript** (Node 24 LTS) | Modular por diseño (1 módulo = 1 área del negocio), DI madura, guards/interceptors para permisos y auditoría, OpenAPI automático |
| Base de datos | **PostgreSQL 17** | Transacciones reales, `SELECT FOR UPDATE`, `CHECK` constraints, `NUMERIC` exacto para dinero, `pg_trgm` para búsqueda difusa, particionado para el kardex |
| ORM | **Prisma 6** + SQL crudo en rutas críticas | Migraciones versionadas y tipos generados; SQL explícito donde el bloqueo y el rendimiento importan |
| Frontend | **React 19 + Vite + TypeScript**, TanStack Query/Router, Tailwind + shadcn/ui | Un solo lenguaje en todo el stack, tipos compartidos con el backend |
| Búsqueda | **Postgres (trigram + FTS) + índice local en el POS** | Búsqueda del POS sin latencia de red; el servidor sigue siendo la verdad |
| Cola / caché | **Redis + BullMQ** | Webhooks con reintentos, reportes pesados, importaciones |
| Dinero | `NUMERIC(14,4)` en BD, `Decimal` en app. **Nunca float** | Un centavo perdido por redondeo se acumula durante años |
| Identificadores | **UUIDv7** internos + folios legibles por sucursal | Seguros de exponer, ordenables por tiempo, generables offline |

## Los tres pilares no negociables

1. **El stock nunca se edita, se mueve.** Toda variación de existencias nace de un
   asiento inmutable en `stock_ledger`. El saldo (`stock_balances`) es un derivado
   cacheado y reconstruible. El Kardex no es un reporte: *es* la tabla.

2. **Un solo escritor de stock.** Una única función de dominio (`StockService.apply()`)
   escribe existencias, siempre dentro de transacción y con bloqueo de fila. Ningún
   módulo toca `stock_balances` directamente. Sin esto, la venta doble es cuestión de tiempo.

3. **Nada se borra.** Productos, ventas y movimientos se archivan, nunca se eliminan.
   Los precios y costos se *fotografían* en cada documento: una venta de hace dos años
   sigue mostrando el costo real de ese día.

## Cómo se resuelve la venta doble (stock = 1, web y mostrador a la vez)

```
Cliente A (web)                          Cliente B (mostrador)
      │                                          │
      │ POST /reservations                       │ POST /sales
      │ Idempotency-Key: abc                     │
      ↓                                          ↓
   BEGIN                                      BEGIN
   SELECT ... FOR UPDATE  ◄── el segundo espera aquí ──┐
   disponible = 1 - 0 = 1                              │
   reserved += 1                                       │
   COMMIT ──────────────────────────────────────────► adquiere el lock
                                               SELECT ... FOR UPDATE
                                               disponible = 1 - 1 = 0
                                               ✗ ERROR 409 STOCK_INSUFICIENTE
```

El bloqueo de fila serializa a los dos compradores. Además, un `CHECK` en la base de
datos (`qty_on_hand >= 0`, `qty_reserved <= qty_on_hand`) actúa como última defensa:
un error de programación produce una excepción, nunca inventario corrupto.

## Roadmap

Fase 1 Cimientos · 2 Catálogo · 3 Inventario · 4 POS · 5 Caja/Tickets ·
6 Compras · 7 Clientes/Precios · 8 Reportes · 9 API pública · 10 Reservas/Webhooks ·
11 Integración web · 12 Endurecimiento · **13 CFDI** *(opcional, posterior)*

≈27 semanas para el alcance principal, más 3 si se activa la facturación fiscal.
**Primer sistema utilizable al terminar la Fase 5, alrededor del tercer mes.**

Detalle y criterios de aceptación en [`09-roadmap.md`](09-roadmap.md).

## Decisiones tomadas (5 de septiembre de 2026)

Las cuatro que bloqueaban la Fase 1 están resueltas. Detalle en
[`10-decisiones-pendientes.md`](10-decisiones-pendientes.md).

| | Decisión | Consecuencia |
|---|---|---|
| **D1** | **Nube (cloud-first)** | Ninguna computadora del local es punto único de falla. API accesible siempre para la web. Contingencia offline: caché de lectura en Fase 4, venta offline analizada en Fase 12 |
| **D2** | **CFDI preparado, no improvisado** | Datos fiscales desde la Fase 2 (≈3 días); timbrado real en la Fase 13. El cajero nunca espera al SAT |
| **D3** | **1 sucursal hoy, multi por diseño** | Modelo multi-almacén desde la Fase 1; la interfaz oculta esa dimensión hasta que exista la segunda ubicación |
| **P6** | **Devoluciones configurables** | 30 días, reembolso por método original, crédito a favor y cambios. Todo editable desde administración, con auditoría |

Separación reafirmada y garantizada por construcción:
**venta física → POS · venta online → API · inventario → sistema central.**

## Índice

| Documento | Contenido |
|---|---|
| [01-arquitectura.md](01-arquitectura.md) | Stack, capas, estructura de carpetas, diagrama de despliegue |
| [02-modelo-datos.md](02-modelo-datos.md) | 76 tablas (71 operativas + 5 del SAT), relaciones, índices, restricciones |
| [03-inventario.md](03-inventario.md) | Kardex, tipos de stock, costeo, búsqueda |
| [04-flujos-operativos.md](04-flujos-operativos.md) | Venta, compra, devolución, caja, reserva, transferencia |
| [05-api.md](05-api.md) | Diseño REST, autenticación, idempotencia, webhooks |
| [06-seguridad.md](06-seguridad.md) | Roles, permisos, auditoría, hardening |
| [07-concurrencia.md](07-concurrencia.md) | Transacciones, bloqueos, reservas, condiciones de carrera |
| [08-operacion.md](08-operacion.md) | Backups, monitoreo, despliegue, restauración |
| [09-roadmap.md](09-roadmap.md) | 12 fases con entregables y criterios de aceptación |
| [10-decisiones-pendientes.md](10-decisiones-pendientes.md) | Decisiones tomadas y confirmaciones abiertas |
| [11-facturacion-cfdi.md](11-facturacion-cfdi.md) | Capa de integración fiscal CFDI 4.0 |
| [12-politica-devoluciones.md](12-politica-devoluciones.md) | Motor de política de devoluciones configurable |
