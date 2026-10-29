# Maydek — Punto de Venta, Inventario y Administración

Sistema central para distribuidora de fajas colombianas. **Fuente única de verdad** del
inventario, con API para conectar la página web existente y futuros canales.

Sitio público: **https://maydek.vercel.app** (`apps/web`; Vercel lo publica solo con cada
push a `main`).

> **Estado: Fase 1 (Cimientos) CERRADA y verificada.**
> Lint, compilación y tipos en verde · **79 pruebas unitarias** · **76 pruebas de
> integración contra PostgreSQL 17.2 real** · migraciones y seed desde base vacía ·
> `pnpm dev` levanta los 4 servicios · permisos verificados por HTTP contra el API
> corriendo. Informe completo en [docs/13-fase-1-cimientos.md](docs/13-fase-1-cimientos.md).

## Arrancar en una máquina limpia

**Con Docker** *(requiere permisos de administrador)*

```bash
pnpm install
pnpm setup      # verifica requisitos, crea .env, levanta Postgres, migra y siembra
pnpm dev        # API + panel + POS
```

**Sin Docker ni administrador** — deja PostgreSQL 17 real en espacio de usuario,
con los mismos roles y ajustes que docker-compose:

```bash
pnpm install
pnpm setup:local-db    # descarga los binarios oficiales, crea el clúster y el .env
pnpm db:deploy && pnpm db:seed
pnpm dev
```

El clúster se instala en `%LOCALAPPDATA%\punto-venta\postgres`, **fuera del
repositorio**: si el proyecto está en OneDrive o Dropbox, un directorio de datos
activo dentro de una carpeta sincronizada puede corromperse. Cambiable con
`PV_POSTGRES_HOME`.

> ⚠️ **Si trabajas dentro de OneDrive, Dropbox o Google Drive.** `node_modules`
> son ~562 MB en ~29 000 archivos. Sincronizarlos consume memoria y CPU sin
> ningún beneficio, y puede tumbar la base de datos en equipos con poca RAM.
> En este equipo se resolvió sacándolos de la carpeta sincronizada y dejando un
> enlace de directorio:
>
> ```cmd
> move node_modules %LOCALAPPDATA%\punto-venta
ode_modules
> mklink /J node_modules %LOCALAPPDATA%\punto-venta
ode_modules
> ```
>
> No cambia ninguna ruta ni requiere permisos de administrador, y es reversible:
> borra el enlace y ejecuta `pnpm install`.

| Servicio | Dirección |
|---|---|
| API | http://localhost:3000/api/v1 |
| Documentación OpenAPI | http://localhost:3000/docs |
| Panel de administración | http://localhost:5173 |
| Punto de venta | http://localhost:5174 |

**Requisitos:** Node 22+, pnpm 10+, y PostgreSQL 17 (por Docker o por el script local).
`pnpm setup` imprime las credenciales iniciales al terminar y obliga a cambiar la
contraseña en el primer acceso.

## Comandos

```bash
pnpm dev              # todo a la vez          pnpm db:up       # levanta PostgreSQL
pnpm dev:api          # solo el API            pnpm db:deploy   # aplica migraciones
pnpm build            # compila todo           pnpm db:seed     # siembra datos
pnpm typecheck        # tipos                  pnpm db:reset    # BORRA TODO y reconstruye
pnpm lint             # ESLint                 pnpm db:studio   # explorador visual
pnpm test             # unitarias              pnpm db:verify   # el inventario cuadra?
pnpm test:integration # contra Postgres real   pnpm db:migrate:new  # nueva migración

pnpm setup:local-db   # PostgreSQL sin Docker  pnpm db:local:status|stop|start
```

## Qué es y qué no es

**Es:** el sistema central que controla punto de venta físico, inventario, productos,
variantes, compras, proveedores, clientes, caja, tickets, pagos, devoluciones, reportes,
usuarios, permisos y auditoría — más una API para integrar canales externos.

**No es:** una página web, tienda online, carrito de compras ni frontend de e-commerce.
La página web ya existe, se mantiene por separado, y será simplemente **otro canal**
conectado por API.

```
   VENTA FÍSICA  ──►  POS
   VENTA ONLINE  ──►  API
   INVENTARIO    ──►  SISTEMA CENTRAL   ← única fuente de verdad para ambos
```

## Los tres principios no negociables

1. **El stock nunca se edita, se mueve.** Todo cambio nace de un asiento inmutable.
   El rol de aplicación de PostgreSQL **no tiene `UPDATE` ni `DELETE`** sobre el kardex:
   no es una convención, es una regla de la base de datos.
2. **Un solo escritor de existencias.** `StockService.apply()`, con bloqueo de fila en
   orden determinista. Una regla de ESLint impide saltárselo.
3. **Nada se borra.** Se archiva. Precios y costos se congelan en cada documento.

## Estructura

```
apps/
  api/         NestJS 11 · el Sistema Central
  admin/       React 19 + Vite · panel administrativo
  pos/         React 19 + Vite · punto de venta
packages/
  shared-types/  permisos, roles, errores, eventos — compartidos API ↔ frontends
  domain-rules/  dinero, costeo promedio, redondeo, prorrateo, folios
  config/        tsconfig compartido
infra/           docker-compose · init de PostgreSQL
scripts/         setup.mjs · wait-for-db.mjs
docs/            documentación del proyecto
```

## Documentación

Empieza por el [resumen ejecutivo](docs/00-RESUMEN-EJECUTIVO.md), o abre el
[**PDF completo**](docs/Sistema-Central-Fase-1.pdf) (63 páginas).

| Documento | Contenido |
|---|---|
| [00 · Resumen ejecutivo](docs/00-RESUMEN-EJECUTIVO.md) | Visión general, decisiones principales |
| [01 · Arquitectura](docs/01-arquitectura.md) | Stack, capas, carpetas, despliegue |
| [02 · Modelo de datos](docs/02-modelo-datos.md) | 76 tablas por dominio, relaciones, índices |
| [03 · Inventario](docs/03-inventario.md) | Kardex, tipos de stock, costeo, búsqueda |
| [04 · Flujos operativos](docs/04-flujos-operativos.md) | Venta, compra, devolución, caja, reserva |
| [05 · API](docs/05-api.md) | REST, autenticación, idempotencia, webhooks |
| [06 · Seguridad](docs/06-seguridad.md) | Roles, permisos, auditoría, hardening |
| [07 · Concurrencia](docs/07-concurrencia.md) | Transacciones, bloqueos, venta doble, offline |
| [08 · Operación](docs/08-operacion.md) | Respaldos, monitoreo, despliegue, rendimiento |
| [09 · Roadmap](docs/09-roadmap.md) | 13 fases con criterios de aceptación |
| [10 · Decisiones](docs/10-decisiones-pendientes.md) | Resueltas y pendientes |
| [11 · Facturación CFDI](docs/11-facturacion-cfdi.md) | Capa de integración fiscal |
| [12 · Devoluciones](docs/12-politica-devoluciones.md) | Política configurable |
| [13 · Fase 1](docs/13-fase-1-cimientos.md) | **Informe de cierre: verificaciones, bugs corregidos, deuda técnica** |

## Decisiones tomadas

- **D1 · Nube (cloud-first).** Ninguna computadora del local es punto único de falla.
- **D2 · CFDI preparado, no improvisado.** Datos fiscales en Fase 2, timbrado en Fase 13.
- **D3 · Una sucursal hoy, multi-almacén por diseño.** La interfaz oculta la dimensión.
- **P6 · Devoluciones configurables** desde administración, con auditoría de cambios.

## Flujo de migraciones

⚠️ **No ejecutes `prisma migrate dev` a secas.** Propondría borrar los objetos de la
migración de endurecimiento (restricciones CHECK, índices parciales, triggers, GRANT)
porque Prisma no sabe modelarlos. El flujo es:

```bash
pnpm db:migrate:new -- --name <nombre>   # genera el SQL, NO lo aplica
# revisa y edita el SQL a mano si hace falta
pnpm db:deploy                           # lo aplica tal cual
```

## Siguiente paso

**Fase 2 — Catálogo:** productos, variantes, códigos de barras, motor de búsqueda
(trigram + texto completo) e importación desde Excel con vista previa.

Ayudaría saber cuántos productos y variantes hay hoy, para dimensionar el importador.
