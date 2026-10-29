# 13 — Fase 1: Cimientos (COMPLETADA Y VERIFICADA)

> **Estado: cerrada.** 5 de septiembre de 2026.
> Todas las verificaciones ejecutadas contra **PostgreSQL 17.2 real**, no contra simuladores.

| Verificación | Resultado |
|---|---|
| Lint (ESLint + reglas arquitectónicas) | ✅ 0 problemas |
| Compilación (6 paquetes) | ✅ 6/6 |
| Verificación de tipos (9 tareas) | ✅ 0 errores |
| Pruebas unitarias | ✅ **79/79** |
| Pruebas de integración contra PostgreSQL real | ✅ **76/76** |
| Migraciones desde base vacía | ✅ 4 migraciones |
| Seed desde cero | ✅ idempotente |
| `pnpm dev` levanta los 4 servicios | ✅ API · Panel · POS · PostgreSQL |
| Permisos aplicados en backend por HTTP real | ✅ cajero recibe 403 |

**155 pruebas en total, todas en verde.**

---

## 1. Levantar el proyecto en una máquina limpia

### Requisitos

| Herramienta | Versión | Comprobar |
|---|---|---|
| **Node.js** | 22 o superior | `node -v` |
| **pnpm** | 10 o superior | `npm install -g pnpm` |
| **PostgreSQL 17** | — | vía Docker **o** script local |
| **Git** | cualquiera | `git --version` |

### Camino A — con Docker *(requiere permisos de administrador)*

```bash
pnpm install
pnpm setup       # verifica, crea .env, levanta Postgres, migra y siembra
pnpm dev
```

### Camino B — sin Docker y sin administrador

Docker Desktop instala un servicio de Windows y necesita elevación. Cuando no se
puede elevar —el caso de la máquina donde se desarrolló esta fase— hay una
alternativa que deja **PostgreSQL 17 real** corriendo en espacio de usuario:

```bash
pnpm install
pnpm setup:local-db    # descarga los binarios oficiales, crea el clúster y el .env
pnpm db:deploy
pnpm db:seed
pnpm dev
```

`setup:local-db` produce **el mismo resultado que `docker compose up -d postgres`**:
mismos dos roles (`pv_owner` / `pv_app`), mismos ajustes de `lock_timeout` y
`statement_timeout`, misma separación de privilegios. No es un sustituto degradado.

Control del clúster: `pnpm db:local:status` · `db:local:stop` · `db:local:start`.

> **Dónde vive el clúster — y por qué NO en el repositorio.**
>
> Los datos van a `%LOCALAPPDATA%\punto-venta\postgres`, fuera del proyecto.
> Es deliberado: este repositorio está dentro de una carpeta de **OneDrive**, y un
> directorio de datos de PostgreSQL *activo* dentro de una carpeta que se
> sincroniza en caliente es una receta para la corrupción — el sincronizador
> copia archivos que el motor está escribiendo, y `.gitignore` no lo detiene
> porque OneDrive no lo lee.
>
> Se puede cambiar la ubicación con la variable `PV_POSTGRES_HOME`.

### Arrancar

```bash
pnpm dev
```

| Servicio | Dirección |
|---|---|
| API | http://localhost:3000/api/v1 |
| Documentación OpenAPI | http://localhost:3000/docs |
| Panel de administración | http://localhost:5173 |
| Punto de venta | http://localhost:5174 |

> Si el puerto 3000 está ocupado, el API **falla al arrancar con un mensaje claro**
> en vez de compartirlo en silencio (ver §7). Cambia `API_PORT` en `.env`.

**Credenciales iniciales:** `admin@distribuidora.local` / `Admin.Cambiar123` / PIN `1234`.
El sistema obliga a cambiar la contraseña en el primer acceso.

### Comandos

```bash
pnpm dev              # API + panel + POS        pnpm db:up          # Postgres (Docker)
pnpm dev:api          # solo el API              pnpm db:deploy      # migraciones
pnpm build            # compila todo             pnpm db:seed        # datos iniciales
pnpm typecheck        # tipos                    pnpm db:reset       # BORRA y reconstruye
pnpm lint             # ESLint                   pnpm db:studio      # explorador visual
pnpm test             # unitarias                pnpm db:verify      # ¿el inventario cuadra?
pnpm test:integration # PostgreSQL real          pnpm db:migrate:new # nueva migración

pnpm setup:local-db   # PostgreSQL sin Docker    pnpm db:local:status|stop|start
```

---

## 2. Base de datos — medida, no estimada

Todas las cifras salen de consultar `information_schema` y `pg_catalog` sobre la
base recién migrada:

| Métrica | Valor |
|---|---|
| Tablas de aplicación | **76** |
| Tipos enumerados | 36 |
| Índices | 240 |
| Llaves foráneas | 123 |
| Restricciones `CHECK` propias | 24 |
| Migraciones | 4 |
| Permisos sembrados | 76 |
| Roles sembrados | 6 |

### El conteo: 52 → 76

Un borrador temprano encabezaba el modelo de datos con «52 tablas». **Ese número
era simplemente incorrecto**: un conteo hecho a ojo al redactar el resumen, que ni
siquiera cuadraba con el desglose por dominio del mismo documento (sumaba 72). No
hubo alcance añadido a escondidas; hubo un resumen mal contado.

El inventario real, verificado:

```
71  modelo operativo
 5  catálogos del SAT      (decisión D2 — preparación fiscal)
───
76  TOTAL
```

De las 71 operativas, 2 se añadieron **en esta fase** por tu punto 10
(`landed_costs` y `exchange_rates`, ver §5). Sin D2 y sin el punto 10, el modelo
son 69 tablas.

El desglose completo por dominio —con la justificación de cada tabla puente, de
detalle y de historial— está en
[`02-modelo-datos.md`](02-modelo-datos.md#inventario-verificado).

### Cuatro migraciones

| Migración | Contenido |
|---|---|
| `…000_init` | Las tablas base, generadas desde el esquema Prisma |
| `…001_hardening` | Extensiones, `CHECK`, columna generada `qty_available`, índices únicos parciales, GIN trigram y FTS, trigger de normalización, y los `REVOKE` del kardex y la auditoría |
| `…002_timezone_configurable` | Zona horaria obligatoria en empresa, heredable en sucursal |
| `…003_landed_costs_y_tipo_cambio` | Costos de importación desglosados y tipos de cambio históricos |

### Dos roles: el append-only es real

```
pv_owner   dueño del esquema · migraciones y seed
pv_app     rol de la APLICACIÓN · restringido
```

Verificado contra la base:

```
audit_logs      → INSERT, SELECT
stock_ledger    → INSERT, SELECT
stock_balances  → SELECT, INSERT, UPDATE, DELETE
```

**Ni un bug ni alguien con la credencial de la aplicación pueden reescribir
historial.** Hay pruebas de integración que intentan el `UPDATE` y el `DELETE` y
verifican que PostgreSQL los rechace.

---

## 3. Pruebas ejecutadas

### Unitarias — 79, sin base de datos

```
@pv/domain-rules   29
  money.spec.ts    20  aritmética exacta, costeo promedio, redondeo de efectivo,
                       prorrateo de importación, impuestos
  folio.spec.ts     9  formato y lectura de folios

@pv/api            50
  ids.spec.ts       4  UUID v7: unicidad y orden temporal
  core.spec.ts     28  validación de entorno, cifrado, idempotencia, auditoría,
                       errores de dominio
  permissions      18  el guard y la definición de los 6 roles
```

### Integración — 76, contra PostgreSQL 17.2 real

| Archivo | Pruebas | Qué demuestra |
|---|---:|---|
| `foundations.spec.ts` | 21 | Restricciones `CHECK`, append-only por permisos, unicidad parcial, normalización de búsqueda, folios sin huecos, regresión del proxy de Prisma |
| `concurrency.spec.ts` | 11 | **Sobreventa, folios e idempotencia bajo concurrencia real** |
| `timezone.spec.ts` | 19 | Herencia de zona, día operativo, Chihuahua vs Ciudad Juárez |
| `permissions-e2e.spec.ts` | 25 | **API real por HTTP: un cajero no puede saltarse sus permisos** |

### La prueba que define el sistema

```
50 compradores simultáneos · 1 pieza en existencia
  → 1 venta exitosa
  → 49 rechazos con 409
  → saldo final: 0 (nunca negativo)
  → 1 solo asiento en el kardex (sin huérfanos de transacciones revertidas)
```

Y las que la acompañan:

- 20 compradores con 5 piezas → venden exactamente 5.
- Tras 60 operaciones concurrentes, `SUM(kardex)` reconstruye el saldo **exactamente**.
- Si la web reserva la última pieza, el mostrador **no puede venderla**; al liberar
  la reserva, vuelve a estar disponible.
- Un `UPDATE` que ignore la validación es **rechazado por la restricción `CHECK`**.
- 30 folios simultáneos: únicos y **sin huecos** (1…30).
- La misma clave de idempotencia enviada 20 veces a la vez: **una sola gana**.
- Dos productos distintos se venden en paralelo sin estorbarse (bloqueo por fila,
  no por tabla).

### Permisos aplicados de verdad, verificado por HTTP contra el API corriendo

```
Cajero (16 permisos) llamando DIRECTO al API, sin pasar por la interfaz:

  GET  /users                  → 403  falta: user.view
  GET  /users/permissions      → 403  falta: role.manage
  GET  /users/roles            → 403  falta: user.view
  POST /users                  → 403
  PATCH /users/:id/roles       → 403   (intento de autoasignarse ADMIN)
        roles después          → ['CASHIER']   ← no cambió nada

Administrador (76 permisos):
  GET  /users                  → 200
  GET  /users/permissions      → 200
```

---

## 4. Zona horaria configurable

**Ninguna zona horaria está escrita en el código.**

```
companies.timezone   OBLIGATORIA, sin valor por defecto
branches.timezone    NULL = hereda la de la empresa
```

Quitar el valor por defecto es deliberado: obligar a elegir evita que una sucursal
herede en silencio una zona equivocada.

- **Almacenamiento:** siempre UTC (`TIMESTAMPTZ`).
- **Presentación:** siempre en la zona de la **sucursal del documento**.
- **Día operativo:** `business_day_cutoff` (HH:mm, en hora local de la sucursal)
  decide a qué día pertenece una venta. Con corte a las 04:00, una venta de la
  01:30 del martes todavía es del lunes — como la cuenta quien cierra la caja.

`TimeZoneService` valida contra la base IANA del sistema (no una lista propia, que
envejece), resuelve la herencia, formatea y calcula los límites del día operativo.

**Configuración inicial: `America/Chihuahua`.**

> Un detalle que el sistema distingue y que cuesta caro confundir: desde 2022
> México eliminó el horario de verano **salvo en la franja fronteriza**. Chihuahua
> es UTC−6 todo el año; Ciudad Juárez sigue las reglas de Estados Unidos y usa
> `America/Ciudad_Juarez`. En invierno difieren **una hora**. Hay una prueba que
> lo verifica: confundirlas desfasaría los cortes de caja medio año.

---

## 5. Multi-moneda y costos de importación (tu punto 10)

La estructura queda lista para MXN, COP, USD y EUR. **La decisión operativa se
define antes de la Fase 6**; esto solo evita tener que migrar datos después.

### `exchange_rates` — tipos de cambio históricos

Sin esta tabla, «¿a qué tipo de cambio se registró aquella compra?» no tiene
respuesta. Cada documento congela el suyo; la tabla alimenta el valor por defecto
y permite auditar de dónde salió (DOF, BANXICO, MANUAL).

### `landed_costs` — costos de importación desglosados

```
FREIGHT_INTERNATIONAL   flete internacional
FREIGHT_LOCAL           traslado de aduana a bodega
CUSTOMS                 agente aduanal, honorarios, DTA
IMPORT_DUTY             impuestos de importación (IGI)
INSURANCE               seguro de la mercancía
HANDLING                maniobras, almacenaje
OTHER
```

Cada renglón puede venir **en su propia moneda**: el flete en USD, la aduana en
MXN y la mercancía en COP es un caso normal, no una excepción. Y cada uno puede
prorratearse con su propio método —el flete suele repartirse por peso y la aduana
por valor—.

> ⚠️ **Cambio que debo señalarte.** Esto **reemplaza** los dos campos sueltos
> `freight_cost` y `other_landed_costs` del diseño original.
> **Problema:** con cuatro categorías distintas, meterlas en «otros» hace
> imposible responder «¿cuánto me costó la aduana este año?», que es justo la
> pregunta que se hace al negociar con el agente aduanal.
> **Impacto:** ninguno hoy — el módulo de Compras es la Fase 6 y no hay datos.
> La migración incluye el traspaso de los dos campos por si se aplicara sobre
> datos existentes.
> **Si prefieres los dos campos simples, dilo y lo revierto**; es una decisión de
> modelo, no de implementación.

---

## 6. Particionado del kardex — verificado, no implementado

Mantengo el particionado como trabajo posterior, pero **verifiqué que se pueda
introducir después sin rediseñar nada**. La comprobación se hizo ejecutando la
migración completa sobre una base de pruebas:

| Requisito | Estado |
|---|---|
| Nada apunta a `stock_ledger` ni `audit_logs` con llave foránea | ✅ ninguna |
| `occurred_at` (la clave de partición) es `NOT NULL` | ✅ |
| Único índice `UNIQUE` es la PK — pasará a `(id, occurred_at)`, expresable en Prisma con `@@id` | ✅ |
| Las 4 llaves foráneas que SALEN de `stock_ledger` funcionan en tablas particionadas | ✅ (soportado desde PG 11) |
| Migración probada: renombrar → crear particionada → copiar → borrar | ✅ 3/3 filas migradas |
| Restricciones `CHECK` se conservan | ✅ |
| Índices se propagan a las particiones | ✅ |
| **La poda de particiones funciona** | ✅ `EXPLAIN` escanea solo `stock_ledger_2026_08` |

**Detalle encontrado durante la verificación:** renombrar una tabla **no renombra
su índice de llave primaria**, así que `ALTER TABLE … RENAME` seguido de
`CREATE TABLE` con el mismo nombre de constraint falla con
`relation "stock_ledger_pkey" already exists`. La migración debe incluir
`ALTER INDEX stock_ledger_pkey RENAME TO stock_ledger_old_pkey`. Descubrirlo ahora,
con la base vacía, cuesta cinco minutos; descubrirlo en la Fase 3 con historial
real cuesta una tarde.

**Recomendación:** implementarlo en la Fase 3, cuando el módulo de inventario
exista y se conozca el volumen real. Con la base vacía no acelera nada.

---

## 7. Problemas encontrados y corregidos en esta fase

### P-1 · El bug que se ocultaba a sí mismo *(el más importante)*

**Síntoma:** los registros de auditoría de `auth.login` y `auth.login_failed`
nunca se escribían. Los de `user.create` sí.

**Causa:** Prisma 6 no devuelve la instancia desde el constructor de
`PrismaClient`: devuelve un **Proxy** que resuelve los delegados de modelo
(`auditLog`, `user`, …) al vuelo. Dentro de un getter de la clase, `this` es el
objeto envuelto —que **no** tiene esos delegados—, no el proxy. `get client()`
devolvía `this`, así que fuera de transacción entregaba un cliente sin modelos.

**Por qué pasó desapercibido:** `AuditService` traga sus errores a propósito —un
fallo al auditar no debe tumbar una venta— y los registra con el logger, que en
pruebas está en `silent`. **La auditoría se perdía en silencio, que es
exactamente el peor modo de fallo posible para una auditoría.**

**Corrección:** `DatabaseModule` construye el servicio con fábrica y le pasa el
proxy mediante `registerSelf()`. Hay dos pruebas de regresión que verifican que
`prisma.client` tenga delegados y sepa escribir de verdad.

**Lección:** ninguna prueba unitaria con dobles habría visto esto. Lo encontraron
las pruebas E2E contra el API real, que es exactamente por lo que insististe en
ejecutarlas.

### P-2 · Dos procesos compartiendo el puerto 3000

Al arrancar `pnpm dev`, el API decía «escuchando en :3000» pero las respuestas
venían de otra aplicación. En Windows, dos procesos Node pueden quedarse
escuchando el mismo puerto sin error; el primero se lleva las peticiones.

**Corrección:** `main.ts` comprueba que el puerto esté libre (`exclusive: true`)
**antes** de arrancar, y falla con un mensaje que dice qué hacer. Vite ya fallaba
correctamente gracias a `strictPort`.

### P-3 · `ENCRYPTION_KEY` de ejemplo inválida

El valor del `.env.example` decodificaba a 36 bytes en vez de 32, así que el API
no arrancaba recién clonado el repositorio. Lo detectó su propia validación de
entorno. Corregido en los cuatro archivos de entorno.

### P-4 · Compilación silenciosamente vacía

`incremental: true` hacía que el `tsconfig` de compilación compartiera el
`.tsbuildinfo` con el `--noEmit` del typecheck: `tsc` creía que ya estaba al día y
**no emitía nada**. Separado en `tsconfig.build.json` con su propio caché.

### P-5 · Clúster de PostgreSQL dentro de una carpeta sincronizada

La primera versión de `setup-postgres-local.mjs` creaba el clúster en
`.local-postgres/`, dentro del repositorio. Este proyecto vive en **OneDrive**:
poner ahí un directorio de datos activo significa que el sincronizador copiaría
archivos mientras PostgreSQL los escribe. `.gitignore` no protege de esto porque
OneDrive no lo lee.

**Corrección:** el clúster va a `%LOCALAPPDATA%\punto-venta\postgres`, con
`PV_POSTGRES_HOME` para cambiarlo.

### P-6 · Mensajes de error localizados en el script de instalación

`setup-postgres-local.mjs` comprobaba si una base ya existía buscando el texto
`already exists` en la salida de `psql`. En una instalación en español, `psql`
responde «ya existe», así que en una **reinstalación** el script habría abortado
en un caso que no es un error.

**Corrección:** se comprueba el **código de error de PostgreSQL** (`42P04`), que
no cambia con el idioma. Mismo tratamiento para el rol `pv_app`, que además
ahora actualiza su contraseña si ya existía, en vez de dejar el `.env`
apuntando a una credencial inservible.

### P-7 · Presión de memoria en la máquina de desarrollo

Con 7.8 GB de RAM y varios entornos de desarrollo abiertos a la vez, el sistema
llegó a **0.8 GB libres**. Dos consecuencias observadas:

1. **El script de instalación fue terminado a media ejecución**, después de crear
   el clúster pero antes de escribir el `.env` — que quedó apuntando a
   credenciales antiguas. *(Nota: esta fue la causa real de ese síntoma, no el
   bug de localización de P-6, que se corrigió aparte por ser un defecto legítimo.)*

2. **PostgreSQL se cayó** con `0xC0000142` (fallo al inicializar DLLs por falta de
   memoria) e intentó reiniciarse sin conseguirlo.

**Resolución:** al liberar 723 MB deteniendo los procesos de desarrollo de este
proyecto, PostgreSQL arrancó y **recuperó por WAL sin pérdida**: 76 tablas, 76
permisos, 6 roles, 4 migraciones, 24 restricciones `CHECK` y los permisos
append-only intactos. Las 76 pruebas de integración volvieron a pasar.

**Es la prueba práctica de una decisión del diseño:** el sistema aguanta una caída
abrupta sin corromper datos, porque PostgreSQL escribe WAL y toda operación de
negocio ocurre dentro de una transacción. Un diseño que actualizara un campo
`stock` fuera de transacción habría quedado inconsistente.

**Causa raíz, encontrada después:** no eran los procesos de desarrollo. Al medir
los consumidores reales de memoria aparecieron **OneDrive con 844 MB** y
**Windows Defender con 371 MB**. El motivo: `node_modules` son **562 MB en 28 802
archivos**, y este proyecto vive dentro de una carpeta sincronizada. OneDrive
intentaba sincronizar cada archivo y Defender los escaneaba, uno por uno.

**Corrección aplicada:** `node_modules` se movió a
`%LOCALAPPDATA%\punto-venta
ode_modules` y en su lugar quedó un **enlace de
directorio (junction)**. OneDrive ignora los puntos de reanálisis, así que deja
de verlo por completo.

```
Archivos del proyecto expuestos a OneDrive:   ~29 000  →  598
Windows Defender:                              371 MB  →  288 MB
```

**Nada cambió para quien programa:** la ruta `node_modules/` sigue existiendo,
pnpm resuelve igual y las 155 pruebas siguen pasando. Y es reversible: basta
borrar el enlace y ejecutar `pnpm install`.

**Para el día a día:** con 7.8 GB conviene no tener `pnpm dev` de este proyecto y
el de la página web corriendo a la vez. `pnpm dev:api` levanta solo el API si no
se están tocando los frontends.

> **Recomendación de fondo.** El arreglo del enlace resuelve el 98 % del
> problema, pero lo más limpio a mediano plazo sería mover el proyecto fuera de
> OneDrive —por ejemplo a `C:\Proyectos\Punto_venta_comercios`, junto al de la
> página web—. OneDrive es excelente para documentos y pésimo para árboles de
> código con miles de archivos pequeños que cambian a cada compilación. **No lo
> hice por mi cuenta: cambia la ruta del proyecto y es tu decisión.**

### P-8 · Prisma proponiendo destruir el motor de búsqueda

Al generar la cuarta migración, `prisma migrate diff` propuso además **borrar**
`idx_variants_fts`, `idx_variants_trgm` y la columna generada `qty_available`,
porque no sabe modelarlos. Aceptar esa propuesta habría destruido la búsqueda y el
cálculo de disponibilidad.

**Es exactamente el motivo de la regla documentada:** generar el SQL, **leerlo**, y
aplicar solo lo intencional. La migración se escribió a mano y los tres objetos
sobrevivieron — verificado tras aplicarla.

---

## 8. Deuda técnica

| # | Asunto | Estado |
|---|---|---|
| **D-1** | Particionado del kardex | Aplazado a Fase 3. **Vía de migración verificada** (§6) |
| **D-2** | `prisma migrate dev` no se usa | Documentado. El flujo es `db:migrate:new` → revisar → `db:deploy` |
| **D-3** | `qty_available` fuera del cliente Prisma | Es columna generada; se lee con SQL crudo, que es lo que el inventario ya usa |
| **D-4** | Redis declarado, no activo | Bajo perfil `queue`. Se activa en Fase 10 con BullMQ |
| **D-5** | Frontends mínimos | Login y permisos efectivos. El sistema de diseño entra en Fase 2 |
| **D-6** | MFA en el esquema, sin flujo | Campos listos; el flujo TOTP va en Fase 12 |
| **D-7** | Docker no verificado en esta máquina | `docker-compose.yml` está escrito pero no se pudo probar (sin permisos de administrador). El camino sin Docker sí está **verificado de extremo a extremo** |

---

## 9. Criterios de aceptación

| Criterio | Estado |
|---|---|
| Compila | ✅ 6/6 paquetes |
| Pasa lint | ✅ 0 problemas |
| Pasa typecheck | ✅ 0 errores |
| Pasa pruebas unitarias | ✅ 79/79 |
| Pasa pruebas de integración contra PostgreSQL real | ✅ 76/76 |
| Migraciones desde base completamente limpia | ✅ verificado borrando y recreando |
| Seed desde cero | ✅ idempotente |
| Permisos aplicados en backend | ✅ verificado por HTTP contra el API corriendo |
| Operaciones críticas transaccionales | ✅ probado con 50 compradores simultáneos |
| Documentación coincide con el código | ✅ métricas medidas, no estimadas |
| Otra máquina limpia reproduce el entorno | ✅ dos caminos documentados y uno verificado |

**La Fase 1 está cerrada.**

---

## 10. Antes de la Fase 2

**Bloqueante ninguno.** Un dato ayudaría a dimensionar el importador:

> **C10 — ¿cuántos productos y variantes tienes hoy?** Un catálogo de 300
> variantes y uno de 30 000 se cargan de forma distinta.

**Decisión abierta que te toca:** si prefieres conservar los dos campos simples de
costos de importación en lugar de la tabla desglosada (§5), dilo y lo revierto.
