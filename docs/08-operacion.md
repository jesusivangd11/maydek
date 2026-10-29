# 08 — Operación: respaldos, monitoreo y despliegue

## 1. Estrategia de respaldos

El principio que gobierna esta sección: **un respaldo que nunca se ha restaurado no es un
respaldo, es una esperanza.**

### Regla 3-2-1

```
3 copias de los datos
2 medios distintos
1 fuera del local
```

### Capas

| Capa | Herramienta | Frecuencia | Retención | Sirve para |
|---|---|---|---|---|
| **WAL continuo (PITR)** | pgBackRest → S3/R2 | Continuo | 30 días | Restaurar a *cualquier* segundo. Pérdida máxima: segundos |
| **Base completa** | pgBackRest full | Diario 03:00 | 7 días | Restauración rápida |
| **Volcado lógico** | `pg_dump -Fc` cifrado | Diario 04:00 | 30 días | Portátil, restaurable en otra versión de Postgres |
| **Semanal** | full + dump | Domingo | 12 semanas | Recuperación de errores detectados tarde |
| **Mensual** | full + dump | Día 1 | 24 meses | Requisito fiscal |
| **Archivos (S3)** | Versionado + replicación | Continuo | 90 días de versiones | Imágenes y documentos |
| **Manual** | Botón en el panel | Bajo demanda | 30 días | Antes de una importación o migración |

**Antes de cada operación peligrosa** (importación masiva, migración de esquema,
actualización mayor) el sistema toma un respaldo automáticamente y lo identifica con la
operación. Restaurar un error de importación deja de ser una emergencia.

### Objetivos declarados

```
RPO (pérdida máxima aceptable)   :  < 5 minutos   (gracias al WAL continuo)
RTO (tiempo máximo de caída)     :  < 1 hora      (restauración completa documentada)
RTO parcial (una tabla)          :  < 15 minutos
```

### Verificación automática — la parte que casi nadie hace

```
Cada domingo, un job automatizado:
  1. Levanta un Postgres limpio en un contenedor
  2. Restaura el último respaldo completo
  3. Aplica el WAL hasta el último punto
  4. Ejecuta comprobaciones de integridad:
       · el conteo de filas coincide con producción (±tolerancia)
       · SUM(stock_ledger) reconstruye stock_balances exactamente
       · las ventas del último mes cuadran con los pagos
       · no hay folios duplicados ni faltantes
  5. Reporta ÉXITO o FALLA por correo
  6. Destruye el contenedor
```

Si esto falla un domingo, te enteras ese domingo — no el día que de verdad necesites
restaurar.

### Procedimiento de restauración (documentado y ensayado)

`infra/backup/RESTORE.md` contiene el procedimiento paso a paso, con los comandos exactos.
Se ensaya **una vez al trimestre** con cronómetro. Si tarda más que el RTO declarado, se
arregla el procedimiento, no el número.

Escenarios cubiertos: disco perdido, borrado accidental de datos, importación equivocada,
corrupción, migración fallida, y recuperación de una sola tabla.

### Cifrado

Todos los respaldos se cifran con GPG antes de salir del servidor. La clave privada **no
vive en el servidor**: se guarda fuera (gestor de contraseñas y copia física). Un atacante
con acceso al servidor no puede leer los respaldos históricos.

## 2. Monitoreo

### Salud del servicio

```
GET /health         → 200 si el proceso vive
GET /health/ready   → verifica Postgres, Redis y S3
GET /metrics        → Prometheus (protegido)
```

### Alertas

| Señal | Umbral | Vía |
|---|---|---|
| API caída | 2 fallos seguidos | WhatsApp + correo |
| Latencia p95 de búsqueda | > 300 ms por 5 min | Correo |
| Conexiones a Postgres | > 80 % del pool | Correo |
| Cola de webhooks | > 100 pendientes | Correo |
| Webhooks agotados | Cualquiera | Panel + correo |
| Respaldo fallido | Cualquiera | **WhatsApp** |
| Verificación de restauración fallida | Cualquiera | **WhatsApp** |
| Discrepancia ledger vs. saldo | Cualquiera | **WhatsApp** — es lo más grave que puede pasar |
| Disco | > 80 % | Correo |
| Tasa de error 5xx | > 1 % por 5 min | Correo |
| Caja cerrada con diferencia | > umbral | Panel |

La discrepancia entre el ledger y los saldos está al máximo nivel de alerta a propósito:
significa que la premisa central del sistema se rompió y hay que detener la operación para
investigar.

### Logs

Pino en JSON, con `request_id` correlacionando toda la cadena, incluidos los jobs asíncronos
disparados por esa petición. Retención: 30 días en línea, 1 año comprimido. Redacción
automática de contraseñas, PIN, tokens y números de tarjeta.

## 3. Despliegue

```
main ──► CI ──► build ──► staging ──► (aprobación manual) ──► producción

CI ejecuta:
  lint · typecheck · pruebas unitarias
  pruebas de integración (Postgres real vía Testcontainers)
  pruebas de contrato del API público
  E2E del POS (Playwright)
  auditoría de dependencias · escaneo de secretos
  verificación de migraciones (aplicar y revertir sobre copia de producción)
```

**Migraciones:** siempre compatibles hacia atrás, en dos pasos cuando hace falta
(agregar columna → desplegar código → migrar datos → eliminar columna vieja). Nunca una
migración que rompa la versión anterior: permite revertir el despliegue sin perder datos.

**Ventana de despliegue:** fuera del horario de tienda. El POS, siendo PWA, sigue
funcionando en modo lectura durante el reinicio del API (segundos).

**Reversión:** imágenes Docker etiquetadas por commit. Volver atrás es cambiar la etiqueta
y reiniciar (menos de 2 minutos).

## 4. Rendimiento — presupuesto declarado

Objetivos que se miden en CI y en producción:

| Operación | Objetivo (p95) |
|---|---|
| Búsqueda en el POS (local) | < 16 ms — un cuadro de pantalla |
| Búsqueda en servidor, 100k variantes | < 50 ms |
| Agregar línea al ticket (validación) | < 100 ms |
| Cerrar una venta completa | < 300 ms |
| Consulta de stock por API (200 ids) | < 100 ms |
| Carga del dashboard | < 800 ms |
| Reporte de un mes | < 3 s |
| Exportación a Excel de 50k filas | < 30 s (en segundo plano) |

**Técnicas aplicadas:**
- Paginación por cursor en todo listado (nunca `OFFSET` en tablas grandes).
- Índices parciales y compuestos diseñados desde el modelo, no agregados a posteriori.
- Particionado mensual de `stock_ledger` y `audit_logs`.
- Vistas materializadas para el dashboard, refrescadas por evento.
- Caché en Redis de catálogo y precios, invalidada por evento (no por tiempo).
- Réplica de lectura para reportes pesados (a partir de la Fase 8).
- `EXPLAIN ANALYZE` obligatorio en la revisión de cualquier consulta nueva de listado.
- Pruebas de carga con k6 en la Fase 12: 100 ventas por minuto sostenidas.

## 5. Datos de partida y arranque

```
1. Semilla del sistema     roles, permisos, métodos de pago, unidades,
                           impuestos (IVA 16 %), canales, listas de precios
2. Configuración inicial   empresa, sucursal, almacén, terminales, folios
3. Usuarios                administrador + cajeros
4. Importación de catálogo CSV/Excel con vista previa (categorías, marcas,
                           productos, variantes, códigos de barras, precios)
5. Carga de inventario     conteo físico inicial → asientos INITIAL_LOAD
6. Operación en paralelo   2 semanas con Eleventa en simultáneo, comparando
                           cortes de caja diarios ← NO SE OMITE
7. Corte definitivo        Eleventa queda como consulta histórica
```

El paso 6 es innegociable. Migrar un punto de venta en frío es cómo se pierden dos días de
ventas. Dos semanas en paralelo cuestan trabajo, pero convierten un salto al vacío en una
transición verificada.
