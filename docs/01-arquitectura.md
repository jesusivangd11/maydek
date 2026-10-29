# 01 — Arquitectura y stack tecnológico

## 1. Criterios de selección

No elijo por popularidad. El orden de prioridad para este sistema es:

1. **Corrección transaccional** — es un sistema de inventario y de dinero. Un bug de
   concurrencia no es un error visual: es mercancía vendida dos veces o faltante inexplicable.
2. **Mantenibilidad por un equipo pequeño** — probablemente tú y/o un desarrollador.
   Un stack exótico es deuda garantizada.
3. **Rendimiento en el POS** — el cajero teclea y espera. 200 ms de latencia por búsqueda,
   multiplicados por 300 tickets al día, son la diferencia entre un sistema que se usa
   y uno que se abandona.
4. **Integración por API** — es requisito explícito, no un añadido posterior.
5. **Ecosistema y contratación** — que el proyecto no dependa de una sola persona.

## 2. Stack elegido

### Backend: NestJS 11 sobre Node.js 24 LTS (TypeScript estricto)

**Por qué.** NestJS impone una arquitectura modular que mapea uno a uno con las áreas
del negocio (`inventory`, `sales`, `purchases`, `cash`…). Trae de fábrica exactamente
las piezas que este proyecto repite en todos lados:

- **Guards** → permisos granulares declarativos (`@RequirePermission("product.cost.view")`)
- **Interceptors** → auditoría automática y `request_id` en todo el trazado
- **Pipes + class-validator** → validación de entrada obligatoria en cada endpoint
- **`@nestjs/swagger`** → el contrato OpenAPI se genera del código, no se escribe aparte.
  Crítico: la página web se integrará contra ese contrato
- **BullMQ integrado** → webhooks, reportes e importaciones fuera del hilo de petición

**Alternativas descartadas y por qué:**

| Alternativa | Fortaleza real | Por qué no |
|---|---|---|
| **Laravel 11 (PHP)** | CRUD y panel admin rapidísimos, hosting barato | El núcleo de este sistema no es CRUD: es un motor transaccional con eventos, colas y webhooks. Además se pierde el tipado compartido con el frontend, que aquí es el mayor ahorro de mantenimiento |
| **Django (Python)** | Admin autogenerado excelente, ORM sólido | Ese admin no sirve ni para un POS ni para el panel que quieres. Pagarías el costo de mantener dos lenguajes sin recibir el beneficio |
| **Go / .NET** | Rendimiento superior | Rendimiento que no necesitas: tu cuello de botella será PostgreSQL, no el runtime. Costo de mantenimiento y de contratación mucho mayor |
| **Express/Fastify sin framework** | Ligero, sin magia | A los seis meses habrás reescrito, peor, lo que Nest ya trae. La estructura impuesta es una ventaja en un proyecto que vivirá años |

### Base de datos: PostgreSQL 17

**No es negociable para este dominio.** Capacidades que el sistema usa de forma directa:

| Capacidad | Uso concreto |
|---|---|
| `SELECT … FOR UPDATE` | Bloqueo de la fila de saldo → evita la venta doble |
| Niveles de aislamiento a elección | `READ COMMITTED` general, `SERIALIZABLE` en cortes de caja |
| `NUMERIC(14,4)` | Dinero exacto. MySQL y Mongo invitan a usar float; aquí no existe la tentación |
| `CHECK` constraints | `qty_on_hand >= 0` como última defensa contra bugs |
| Índices únicos parciales | SKU único *solo entre variantes activas* |
| `pg_trgm` + `unaccent` | Búsqueda difusa: "faja pos" encuentra "Faja Postquirúrgica" |
| `tsvector` / FTS | Relevancia multi-token |
| `JSONB` | Atributos flexibles, diffs de auditoría, payloads de webhook |
| Particionado por rango | `stock_ledger` y `audit_logs` particionados por mes |
| Archivado de WAL | Restauración a un punto exacto en el tiempo (PITR) |
| `LISTEN` / `NOTIFY` | Relay del outbox de eventos con latencia mínima |
| Réplicas de lectura | Reportes pesados sin tocar la base transaccional |

**MySQL/MariaDB** podría hacerlo, pero pierdes trigram nativo, índices parciales, JSONB
indexable y un ecosistema de PITR maduro. **MongoDB queda descartado de plano**: un sistema
de inventario y dinero necesita transacciones multi-documento y restricciones declarativas
como característica central, no como añadido.

### ORM: Prisma 6 + SQL crudo donde importa

Prisma aporta migraciones versionadas, tipos TypeScript generados del esquema y
transacciones interactivas con nivel de aislamiento configurable.

**Regla explícita del proyecto:** las operaciones de bloqueo (`FOR UPDATE`) y las consultas
de búsqueda y reportes se escriben en **SQL crudo parametrizado**, concentradas en
repositorios dedicados. El bloqueo no se esconde detrás de una abstracción: se lee.

### Frontend: React 19 + Vite + TypeScript

Dos aplicaciones, un repositorio, un paquete de tipos compartidos:

- **`apps/admin`** — panel administrativo. Responsive real (PC, laptop, tablet, móvil).
- **`apps/pos`** — punto de venta. PWA, **primero teclado**, optimizada para 1024 px o más.
  Se instala como aplicación y funciona a pantalla completa.

Librerías: **TanStack Query** (caché de servidor e invalidación), **TanStack Router**
(rutas tipadas), **TanStack Table** (tablas grandes virtualizadas), **Tailwind CSS +
shadcn/ui** (componentes que se poseen, no dependencias de UI que se rompen al actualizar),
**react-hook-form + zod** (el mismo esquema de validación que usa el backend).

### Búsqueda: PostgreSQL + índice local en el POS

Es el punto donde explícitamente quieres superar a Eleventa, así que lleva diseño propio.
Detalle completo en [`03-inventario.md`](03-inventario.md).

Estrategia de dos niveles:

- **Servidor** — columna `search_document` (`tsvector`) más índice GIN trigram sobre un
  texto normalizado (sin acentos, en minúsculas) que concatena nombre, SKU, código de
  barras, marca, categoría, color, talla y código de proveedor.
- **POS** — al abrir turno descarga el catálogo comprimido (≈2 MB para 20 000 variantes)
  a IndexedDB y construye un índice en memoria con **uFuzzy**. El resultado aparece
  **mientras se teclea, sin red**. El servidor se consulta solo para confirmar existencias
  al agregar la línea al ticket.

Meilisearch/Typesense quedan documentados como escalón futuro, no como dependencia inicial:
un servicio más que respaldar, monitorear y mantener sincronizado no se justifica antes
del orden de 200 000 variantes.

### Infraestructura de apoyo

| Componente | Elección | Función |
|---|---|---|
| Caché y colas | **Redis 7** + **BullMQ** | Reintentos de webhooks, reportes, importaciones, rate limiting |
| Archivos | **S3 compatible** (Cloudflare R2 / MinIO) | Imágenes, PDFs, respaldos. **Nunca dentro de la base de datos** |
| Impresión térmica | **node-thermal-printer** (ESC/POS) vía puente local | Tickets y cajón de dinero |
| Etiquetas | **bwip-js** → PDF / ZPL | Impresión por lote de códigos de barras |
| Logs | **Pino** → JSON estructurado | Con `request_id` correlacionado extremo a extremo |
| Errores | **Sentry** (o GlitchTip auto-hospedado) | Trazas con contexto de usuario y petición |
| Métricas | **Prometheus + Grafana** (Fase 12, opcional) | Latencia, colas, profundidad de webhooks |
| Contenedores | **Docker + Docker Compose** | Paridad entre desarrollo y producción |
| Pruebas | **Vitest** + **Testcontainers** + **Playwright** | Unitarias, integración contra Postgres real, E2E del POS |

> ⚠️ **Nota sobre este equipo:** hay Node 24 y Git, pero **no hay Docker ni PostgreSQL**.
> La Fase 1 arranca instalando Docker Desktop (recomendado: levanta Postgres + Redis con
> un solo comando) o bien PostgreSQL 17 y Redis nativos para Windows.

## 3. Arquitectura de capas

**Monolito modular en capas**, con dependencias en una sola dirección. No es microservicios:
para una operación de este tamaño, un monolito bien delimitado es la decisión correcta,
y permite extraer módulos más adelante si alguna vez hiciera falta.

```
┌──────────────────────────────────────────────────────────────────┐
│  PRESENTACIÓN                                                    │
│  Controllers REST · Guards de permiso · DTOs · Serializadores    │
│  Rate limiting · CORS · Validación · Versionado /api/v1          │
├──────────────────────────────────────────────────────────────────┤
│  APLICACIÓN  (casos de uso: orquestan, no calculan)              │
│  RegistrarVenta · RecibirCompra · AbrirCaja · ReservarStock      │
│  Responsable de: transacción, idempotencia, emisión de eventos   │
├──────────────────────────────────────────────────────────────────┤
│  DOMINIO  (reglas puras, sin dependencias de entrada/salida)     │
│  Totales · Impuestos · Descuentos · Costeo promedio              │
│  Reglas de reserva · Validación de devolución · Máquinas estado  │
├──────────────────────────────────────────────────────────────────┤
│  INFRAESTRUCTURA                                                 │
│  Prisma · Repositorios · Redis · S3 · Impresora · Correo         │
└──────────────────────────────────────────────────────────────────┘
                              ↕
┌──────────────────────────────────────────────────────────────────┐
│  NÚCLEO TRANSVERSAL                                              │
│  StockService  (ÚNICO escritor de existencias)                   │
│  OutboxService · AuditService · IdempotencyService               │
│  SequenceService (folios) · PermissionService                    │
└──────────────────────────────────────────────────────────────────┘
```

**La regla arquitectónica más importante del proyecto:**

> Ningún módulo escribe en `stock_balances` ni inserta en `stock_ledger` directamente.
> Todo pasa por `StockService.apply(movimientos[], contexto)`, que abre transacción,
> bloquea filas en orden determinista, valida, inserta el asiento, actualiza el saldo
> y encola el evento. Todo, o nada.

Se hace cumplir de tres formas independientes: revisión de código, una regla de ESLint
que prohíbe importar el repositorio de stock fuera del módulo `inventory`, y **permisos
de PostgreSQL**: el rol de aplicación no tiene `UPDATE` ni `DELETE` sobre `stock_ledger`.

## 4. Estructura de carpetas

Monorepo con **pnpm workspaces** + **Turborepo** (caché de compilación).

```
punto-venta/
├── apps/
│   ├── api/                      # NestJS — el Sistema Central
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed/             # roles, permisos, métodos de pago, unidades
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── core/             # ── NÚCLEO TRANSVERSAL ──
│   │   │   │   ├── database/     #    PrismaService, gestión de transacciones
│   │   │   │   ├── audit/        #    interceptor + servicio de auditoría
│   │   │   │   ├── idempotency/  #    guard + almacén de claves
│   │   │   │   ├── outbox/       #    publicación transaccional de eventos
│   │   │   │   ├── sequences/    #    folios por sucursal y tipo de documento
│   │   │   │   ├── money/        #    Decimal, redondeo, motor de impuestos
│   │   │   │   └── errors/       #    excepciones de dominio, filtro global
│   │   │   ├── modules/          # ── ÁREAS DE NEGOCIO ──
│   │   │   │   ├── auth/         #    login, refresh, PIN de POS, sesiones
│   │   │   │   ├── users/        #    usuarios, roles, permisos
│   │   │   │   ├── org/          #    empresa, sucursales, almacenes, terminales
│   │   │   │   ├── catalog/      #    productos, variantes, categorías, marcas
│   │   │   │   │   ├── search/   #    motor de búsqueda (SQL dedicado)
│   │   │   │   │   └── barcodes/ #    códigos y generación de etiquetas
│   │   │   │   ├── inventory/    #    ★ el corazón del sistema
│   │   │   │   │   ├── stock.service.ts      # ÚNICO escritor de existencias
│   │   │   │   │   ├── ledger.repository.ts  # kardex
│   │   │   │   │   ├── adjustments/          # ajustes y conteos físicos
│   │   │   │   │   ├── reservations/
│   │   │   │   │   └── transfers/
│   │   │   │   ├── pricing/      #    listas de precios, promociones, resolución
│   │   │   │   ├── sales/        #    ventas, líneas, suspendidas, devoluciones
│   │   │   │   ├── payments/     #    métodos, pago mixto, notas de crédito
│   │   │   │   ├── cash/         #    sesiones de caja, cortes X/Z, arqueo
│   │   │   │   ├── purchases/    #    órdenes, recepciones, facturas
│   │   │   │   ├── suppliers/
│   │   │   │   ├── customers/    #    CRM, cuenta corriente, crédito
│   │   │   │   ├── reports/      #    consultas de reporte + exportación
│   │   │   │   ├── imports/      #    CSV/Excel con vista previa y confirmación
│   │   │   │   ├── webhooks/     #    endpoints, entregas, reintentos
│   │   │   │   ├── channels/     #    POS, WEB, MERCADO_LIBRE…
│   │   │   │   └── settings/     #    configuración, plantillas de ticket
│   │   │   ├── public-api/       # ── SUPERFICIE PARA CANALES EXTERNOS ──
│   │   │   │   └── v1/           #    contrato separado, versionado y estable
│   │   │   └── jobs/             #    workers de BullMQ
│   │   └── test/
│   │
│   ├── admin/                    # React — panel administrativo
│   │   └── src/
│   │       ├── features/         # una carpeta por área, espeja los módulos del API
│   │       ├── components/ui/    # shadcn/ui
│   │       └── lib/api/          # cliente generado desde OpenAPI
│   │
│   ├── pos/                      # React PWA — punto de venta
│   │   └── src/
│   │       ├── features/
│   │       │   ├── register/     # pantalla de venta
│   │       │   ├── search/       # índice local uFuzzy + IndexedDB
│   │       │   ├── payment/      # cobro, pago mixto, cambio
│   │       │   ├── cash/         # apertura, corte, arqueo
│   │       │   └── offline/      # caché de catálogo + cola de salida
│   │       └── lib/hardware/     # escáner (HID), impresora, cajón
│   │
│   └── print-bridge/             # servicio local Node (ver §5)
│                                 # HTTP en localhost → ESC/POS por USB o red
├── packages/
│   ├── shared-types/             # tipos y enums compartidos API ↔ frontends
│   ├── domain-rules/             # cálculos puros (totales, impuestos) usados en ambos lados
│   └── config/                   # eslint, tsconfig, tailwind compartidos
├── docs/                         # esta documentación
├── infra/
│   ├── docker-compose.yml        # desarrollo: postgres, redis, minio, mailhog
│   ├── docker-compose.prod.yml
│   └── backup/                   # pgBackRest + verificación automática de restauración
└── .github/workflows/            # CI: lint, test, build, migraciones
```

**Por qué `public-api/v1` está separado de `modules/`:** la API que consume la página web
es un **contrato público con garantía de estabilidad**. Separarla físicamente evita que
un refactor interno rompa a un cliente externo sin que nadie se entere. Sus DTOs se
declaran aparte y tienen pruebas de contrato propias.

## 5. Topología de despliegue

### D1 — RESUELTO: nube (cloud-first)

> **Decisión tomada.** El servidor vive en la nube. El POS, la administración y la API se
> conectan al servidor central. El inventario queda disponible para la tienda física y para
> la página web **independientemente de que una computadora del local se apague o falle**.
>
> La contingencia offline del POS se analiza y se implementa en la Fase 12, siempre
> priorizando la consistencia del inventario. Diseño preliminar en
> [`07-concurrencia.md`](07-concurrencia.md).

**Arquitectura de despliegue**

```
   Internet
      │
      ├── Cloudflare (DNS, TLS, WAF, rate limit de borde)
      │        │
      │        ↓
      │   VPS (Hetzner / DigitalOcean · 4 vCPU · 8 GB · ≈25 USD/mes)
      │   ┌──────────────────────────────────────────┐
      │   │ Caddy (TLS automático, proxy inverso)    │
      │   │ api (NestJS)   ·   worker (BullMQ)       │
      │   │ postgres 17    ·   redis 7               │
      │   └──────────────────────────────────────────┘
      │        │ respaldo continuo (WAL) → R2 / S3
      │
      ├── Tienda: POS (PWA) + admin, en navegador
      └── Página web existente → api.tudominio.com
```

**Lo que garantiza esta topología:**

- La página web tiene el API públicamente accesible **siempre**, sin IP fija ni túneles.
- Ninguna computadora del local es un punto único de falla. Si se quema la PC del mostrador,
  se abre el POS en otra máquina o en una tablet y se sigue vendiendo: no hay nada
  irreemplazable en el local.
- Respaldo automático fuera del local, que protege contra robo, incendio y disco muerto.
- Actualización centralizada: una sola versión desplegada, no N instalaciones que divergen.

**El único riesgo asumido** es la caída del internet de la tienda. Se mitiga en dos tiempos:

1. **Desde la Fase 4** — el POS cachea catálogo, precios y último stock conocido. Si se cae
   la conexión, sigue consultando y cotizando; solo no puede cerrar la venta.
2. **En la Fase 12** — contingencia de venta offline, analizada con datos reales de
   estabilidad de tu conexión y con la consistencia del inventario como prioridad absoluta.
   El análisis y sus tres niveles están en [`07-concurrencia.md`](07-concurrencia.md).

**Evolución posible (no ahora):** si la conexión resultara crónicamente inestable, la
arquitectura admite añadir una réplica de solo lectura en la tienda para que el POS consulte
sin internet, manteniendo todas las escrituras contra la nube. Es una adición, no un rediseño.

### Puente de impresión local

Un navegador no puede hablar por USB con una impresora térmica ni abrir el cajón de dinero.
Solución: **`print-bridge`**, un servicio Node diminuto que corre en la PC del mostrador y
escucha en `http://localhost:9100`. El POS le manda el ticket en JSON y él lo convierte a
ESC/POS. Instalación única por terminal, arranque automático con Windows.

El **escáner de código de barras no necesita nada**: los lectores USB se comportan como
teclado. El POS los detecta por velocidad de tecleo (más de 50 caracteres por segundo =
escáner, no humano) y procesa la lectura sin que el cajero salga del campo de búsqueda.

## 6. Flujo de una petición, extremo a extremo

```
Petición HTTP
  │
  ├─ 1. Cloudflare / Caddy     TLS, rate limit de borde
  ├─ 2. Helmet + CORS          cabeceras de seguridad, orígenes permitidos
  ├─ 3. RequestIdMiddleware    genera o propaga X-Request-Id
  ├─ 4. ThrottlerGuard         límite por IP y por cliente de API
  ├─ 5. AuthGuard              valida JWT o llave de API → principal
  ├─ 6. PermissionGuard        ¿tiene "sale.create"? ¿acceso a esa sucursal?
  ├─ 7. IdempotencyGuard       si hay Idempotency-Key: ¿ya se procesó? → respuesta guardada
  ├─ 8. ValidationPipe         DTO validado y saneado (rechaza campos no declarados)
  │
  ├─ 9. CASO DE USO ──── BEGIN TRANSACTION ─────────────────────┐
  │      ├─ bloquea filas de saldo (orden determinista)          │
  │      ├─ reglas de dominio (totales, impuestos, descuentos)   │
  │      ├─ escribe el documento (venta / compra / devolución)   │
  │      ├─ StockService.apply() → asiento + saldo               │
  │      ├─ AuditService.record()                                │
  │      ├─ OutboxService.publish(evento)                        │
  │      └─ guarda la respuesta de idempotencia                  │
  │     ──── COMMIT ────────────────────────────────────────────┘
  │
  ├─ 10. Serializador          oculta el costo si falta "product.cost.view"
  └─ 11. Respuesta + log estructurado

  ASÍNCRONO (después del commit):
     OutboxRelay → BullMQ → entrega de webhooks (con reintentos)
                          → invalidación de caché
                          → refresco de índices de reporte
```

El paso 9 es lo que separa este sistema de un CRUD. **Los eventos se escriben dentro de la
misma transacción** que el dato (patrón *transactional outbox*): es imposible que exista una
venta sin su evento, o que se dispare un webhook de una venta que terminó fallando.
