# 09 — Roadmap por fases

**Regla de trabajo acordada:** una fase a la vez. Cada fase debe funcionar, estar probada,
manejar errores, estar documentada y no romper lo anterior. **No se empieza una fase sin tu
aprobación explícita de la anterior.**

Las estimaciones asumen un desarrollador de tiempo completo. Son órdenes de magnitud para
planear, no compromisos.

---

## FASE 1 — Cimientos
**Arquitectura + base de datos + autenticación** · ~2 semanas

Entregables:
- Monorepo configurado (pnpm + Turborepo), TypeScript estricto, ESLint, Prettier
- `docker-compose` de desarrollo: Postgres 17, Redis, MinIO, Mailhog
- Esquema Prisma **completo** (76 tablas: 71 operativas + 5 catálogos del SAT)
  + migraciones. Inventario por dominio en [`02-modelo-datos.md`](02-modelo-datos.md)
- Semilla: roles, permisos, métodos de pago, unidades, impuestos, canales, listas
- Núcleo transversal: `PrismaService`, transacciones, `Money`, errores de dominio,
  `SequenceService`, `AuditService`, `OutboxService`, `IdempotencyService`
- Autenticación completa: login, refresh rotatorio, logout, PIN de POS, `authorize`
- Guards de permiso + serializadores sensibles al permiso
- Panel admin: login, layout, navegación, gestión de usuarios y roles
- CI en GitHub Actions
- Documentación: cómo levantar el proyecto en 5 minutos

Criterios de aceptación:
- [ ] `pnpm dev` levanta todo desde cero en una máquina limpia
- [ ] Login funcional con los 6 roles; los permisos se aplican de verdad
- [ ] La auditoría registra login, logout y cambios de rol
- [ ] Migraciones aplican y revierten sin pérdida
- [ ] CI en verde

> **El esquema completo se crea en la Fase 1** aunque las tablas se usen después. Diseñar
> las relaciones de una vez evita migraciones que reescriban historial de inventario.

---

## FASE 2 — Catálogo
**Productos + variantes + categorías + marcas** · ~2,5 semanas

- CRUD de categorías (árbol), marcas, unidades, impuestos
- CRUD de productos con generación de variantes por combinación de opciones
  (Color × Talla → 8 variantes en un paso)
- **Preparación fiscal (D2):** catálogos del SAT y campos fiscales en empresa, cliente,
  producto y métodos de pago. Clave del SAT heredable desde la categoría, para no capturarla
  producto por producto. Ver [`11-facturacion-cfdi.md`](11-facturacion-cfdi.md)
- Códigos de barras múltiples por variante, con detección de duplicados
- Subida de imágenes a S3 (con reprocesamiento y miniaturas)
- **Motor de búsqueda del servidor**: trigram + FTS + diccionario de sinónimos
- Importación desde CSV/Excel con vista previa, validación y confirmación
- Archivado (nunca borrado), con verificación de referencias

Criterios de aceptación:
- [ ] Crear "Faja Modelo X" con 2 colores × 4 tallas genera 8 variantes con SKU
- [ ] `"post m"` encuentra la faja postquirúrgica talla M
- [ ] `"FJ-00"` encuentra por SKU parcial
- [ ] Búsqueda < 50 ms con 50 000 variantes sembradas
- [ ] Importar 5 000 productos con vista previa y errores señalados por fila

---

## FASE 3 — Inventario ★
**Kardex + movimientos + almacenes** · ~2,5 semanas

**La fase más importante del proyecto.**

- `StockService.apply()` — el único escritor, con bloqueo determinista
- `stock_ledger` particionado + `stock_balances` con los tres `CHECK`
- Costeo promedio ponderado móvil
- Ajustes con motivo tipificado y auditoría
- Conteos físicos (borrador → contando → revisión → aplicado)
- Transferencias entre almacenes con almacén virtual de tránsito
- Kardex en pantalla, filtrable y exportable
- Alertas: bajo stock, agotado, sin movimiento, margen negativo
- Comando de verificación de integridad (ledger vs. saldos)
- **Pruebas de concurrencia** con Postgres real

Criterios de aceptación:
- [ ] 50 ventas simultáneas con 1 pieza → 1 éxito, 49 rechazos, saldo 0
- [ ] El Kardex muestra cantidad anterior, entrada/salida, resultante, motivo, usuario, referencia
- [ ] El costo promedio se recalcula correctamente en cada recepción
- [ ] La verificación de integridad reporta 0 discrepancias tras 10 000 movimientos
- [ ] Es imposible dejar el stock negativo sin el permiso correspondiente

---

## FASE 4 — Punto de venta
**POS + ventas** · ~3 semanas

- Pantalla de venta primero-teclado (atajos completos, sin necesidad de ratón)
- Búsqueda local instantánea (IndexedDB + uFuzzy) con sincronización incremental
- Detección de escáner por velocidad de tecleo
- Carrito: cantidad, descuento por línea y global, notas
- Selección de cliente; ventas suspendidas y recuperación
- Cierre de venta transaccional con idempotencia
- Cancelación de venta con motivo y autorización
- **Modo offline nivel 0** (lectura: catálogo, precios, último stock conocido)
- PWA instalable

Criterios de aceptación:
- [ ] Venta completa de 10 artículos en menos de 30 segundos, solo con teclado
- [ ] La búsqueda responde en menos de 16 ms mientras se teclea
- [ ] El escáner agrega el artículo sin ningún clic
- [ ] Cerrar la venta tarda menos de 300 ms
- [ ] Sin internet, el POS sigue mostrando catálogo y precios

---

## FASE 5 — Caja, tickets y pagos
~2 semanas

- Métodos de pago configurables; **pago mixto**
- Sesiones de caja: apertura con fondo, movimientos, retiros, gastos
- Corte X (parcial, repetible) y corte Z (arqueo y cierre)
- Conteo por denominación; diferencia con motivo obligatorio
- Diseñador de ticket (logo, datos, redes, mensaje, información fiscal)
- `print-bridge`: impresión ESC/POS y apertura de cajón
- Reimpresión y consulta de tickets, con auditoría
- Ticket digital en PDF (para enviar por WhatsApp)

Criterios de aceptación:
- [ ] Venta de $1 500 pagada con $500 efectivo + $1 000 tarjeta se registra correctamente
- [ ] El corte Z cuadra: fondo + ventas − retiros − devoluciones = esperado
- [ ] Imprime en impresora térmica de 58 mm y 80 mm
- [ ] No se puede cerrar caja con diferencia sin escribir un motivo

---

## FASE 6 — Compras y proveedores
~2 semanas

- CRUD de proveedores con condiciones comerciales
- Órdenes de compra con flujo de aprobación
- Recepción total y **parcial**; varias recepciones por orden
- Prorrateo de flete y costos de importación (landed cost)
- Historial de costos por proveedor
- Recepción rápida sin orden previa
- Sugerencia de compra según punto de reorden

Criterios de aceptación:
- [ ] Ordenar 100, recibir 80 → 80 recibidas, 20 pendientes, +80 al inventario
- [ ] El costo promedio se actualiza con el costo prorrateado, no el de factura
- [ ] El historial de costos por proveedor es consultable

---

## FASE 7 — Clientes, precios y promociones
~2,5 semanas

- CRM: clientes, historial, métricas, etiquetas
- Cuenta corriente por asientos; crédito y límite
- Notas de crédito (crédito a favor)
- Listas de precios (público, mayoreo, distribuidor, especial)
- Precio por volumen y precios temporales
- Motor de promociones (% , monto, precio fijo, NxM)
- `PricingService.resolve()` compartido por POS, web y cotizaciones
- **Devoluciones completas**: total, parcial, cambio, reembolso, crédito
- **Política de devoluciones configurable** (P6): `ReturnPolicyService.evaluate()`,
  ajustes editables desde administración con historial de cambios auditado.
  Ver [`12-politica-devoluciones.md`](12-politica-devoluciones.md)

Criterios de aceptación:
- [ ] Un cliente mayorista ve automáticamente su precio en el POS
- [ ] Una devolución parcial actualiza inventario y saldo correctamente
- [ ] Dos devoluciones simultáneas del mismo ticket no devuelven de más
- [ ] El estado de cuenta del cliente cuadra con la suma de sus asientos
- [ ] Cambiar los días de la ventana de devolución desde administración surte efecto de
      inmediato, sin desplegar, y queda registrado en auditoría
- [ ] Una devolución en efectivo de una venta pagada con tarjeta ofrece crédito a favor,
      conforme a la política configurada

---

## FASE 8 — Reportes y dashboard
~2 semanas

- Los 15 reportes del requisito 17, con todos sus filtros
- Exportación a Excel, CSV y PDF (en segundo plano para volúmenes grandes)
- Dashboard con todas las métricas del requisito 18
- Vistas materializadas + réplica de lectura
- Reportes programados por correo

Criterios de aceptación:
- [ ] El reporte de utilidad usa el costo congelado de cada venta, no el actual
- [ ] Un reporte de un mes carga en menos de 3 segundos
- [ ] Ventas por canal separa correctamente POS y WEB
- [ ] La exportación de 50 000 filas no bloquea el sistema

---

## FASE 9 — API pública
~2 semanas

- Superficie `/public/v1/**` separada
- `api_clients`, llaves con hash, scopes, firma HMAC
- Endpoints de catálogo, existencias, precios y cotización
- Rate limiting por cliente
- OpenAPI 3.1 + colección de Postman + ambiente sandbox
- Pruebas de contrato en CI

Criterios de aceptación:
- [ ] Un cliente externo consulta catálogo y stock con su llave
- [ ] `available` refleja `on_hand − reserved`, nunca el físico
- [ ] El costo **no aparece** en ninguna respuesta pública
- [ ] Quitar un campo público hace fallar el CI

---

## FASE 10 — Reservas, eventos y webhooks
~2,5 semanas

- Reservas transaccionales con TTL y sweeper
- Estados: HELD → COMMITTED → CONSUMED / RELEASED / EXPIRED
- Recepción de pedidos externos (`external_orders`) → venta
- Cancelación y devolución desde canal externo
- Outbox + relay + BullMQ + entrega firmada con reintentos
- Panel de webhooks: historial, reintento manual, reproducción por rango
- Idempotencia end-to-end

Criterios de aceptación:
- [ ] Reservar 2 de 10 → disponible 8; cancelar → vuelve a 10
- [ ] Una reserva vencida libera el stock sola
- [ ] Enviar el mismo pedido dos veces crea **una** venta
- [ ] Con el endpoint caído, el webhook reintenta y luego se recupera solo
- [ ] La secuencia completa del requisito 22 se comporta exactamente como la describiste

---

## FASE 11 — Integración con la página web existente
~1,5 semanas

**Aquí NO se desarrolla la web.** Se entrega todo lo necesario para conectarla.

- Guía de integración con ejemplos en JavaScript, PHP y Python
- SDK cliente en JavaScript/TypeScript publicado como paquete
- Diagramas de secuencia de cada flujo (consulta, reserva, pedido, cancelación)
- Sandbox con datos de prueba
- Acompañamiento técnico a quien mantenga la web
- Lista de verificación de puesta en marcha

Criterios de aceptación:
- [ ] Un desarrollador externo integra catálogo y stock siguiendo solo la guía
- [ ] El flujo completo (reservar → pagar → confirmar → descontar) funciona extremo a extremo
- [ ] Existe un plan de reversión si algo falla en producción

---

## FASE 12 — Endurecimiento
**Pruebas + seguridad + optimización + respaldos** · ~2,5 semanas

- Cobertura de pruebas: > 80 % en dominio, 100 % en inventario y pagos
- E2E de los flujos críticos (Playwright)
- Pruebas de carga con k6
- Auditoría de seguridad (OWASP Top 10) y corrección de hallazgos
- Respaldos automáticos + **verificación semanal de restauración**
- Monitoreo, alertas y tableros
- **Modo offline nivel 1** (venta en efectivo sin conexión), si se decide hacerlo
- Manuales de usuario por rol + capacitación
- Plan de migración desde Eleventa y operación en paralelo

Criterios de aceptación:
- [ ] Restauración completa ensayada con cronómetro, dentro del RTO de 1 hora
- [ ] La verificación automática de respaldos pasa en verde
- [ ] 100 ventas por minuto sostenidas sin degradación
- [ ] Sin vulnerabilidades altas o críticas abiertas

---

## FASE 13 — Facturación CFDI 4.0 *(opcional, posterior)*
~3 semanas

Se ejecuta **después** de la Fase 12, cuando el sistema ya esté en operación real. Su diseño
completo está en [`11-facturacion-cfdi.md`](11-facturacion-cfdi.md); la Fase 2 ya dejó
capturados todos los datos que necesita.

- Abstracción `FiscalStampingProvider` + implementación del PAC elegido + `MockProvider`
- Timbrado asíncrono desde venta, en cola, **sin bloquear jamás el mostrador**
- Factura global del público en general, por periodo configurable
- Autofacturación pública con folio e importe del ticket
- Nota de crédito (CFDI de Egreso) desde devolución
- Cancelación con motivo del SAT y resguardo del acuse
- Complemento de pago (REP) para ventas a crédito con método PPD
- Custodia cifrada del CSD y alertas de vencimiento del certificado

Criterios de aceptación:
- [ ] Con el PAC caído, la tienda sigue vendiendo con normalidad y las facturas se timbran
      solas al restablecerse
- [ ] Una venta incluida en la factura global no puede facturarse individualmente después
- [ ] Cambiar de PAC es cambiar una variable de entorno
- [ ] El CSD nunca aparece sin cifrar en base de datos, logs ni respaldos

---

## Resumen

| Fase | Semanas | Acumulado |
|---|---|---|
| 1 · Cimientos | 2,0 | 2,0 |
| 2 · Catálogo | 2,5 | 4,5 |
| 3 · Inventario ★ | 2,5 | 7,0 |
| 4 · POS | 3,0 | 10,0 |
| 5 · Caja y tickets | 2,0 | 12,0 |
| 6 · Compras | 2,0 | 14,0 |
| 7 · Clientes y precios | 2,5 | 16,5 |
| 8 · Reportes | 2,0 | 18,5 |
| 9 · API pública | 2,0 | 20,5 |
| 10 · Reservas y webhooks | 2,5 | 23,0 |
| 11 · Integración web | 1,5 | 24,5 |
| 12 · Endurecimiento | 2,5 | **27,0** |
| 13 · CFDI *(opcional)* | 3,0 | 30,0 |

**≈ 27 semanas (6 a 7 meses)** de trabajo de tiempo completo para el alcance principal, más
3 semanas si se activa la facturación fiscal.

**Primer hito utilizable: fin de la Fase 5 (≈ 3 meses).** En ese punto ya puedes vender,
cobrar, imprimir tickets y controlar inventario — es decir, ya puedes reemplazar a Eleventa
en lo esencial mientras se construye el resto sobre un sistema en producción real.
