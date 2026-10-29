# 06 — Seguridad, roles y auditoría

## 1. Roles y permisos

### Modelo

Permisos granulares con código `recurso.acción` (o `recurso.subrecurso.acción`). Los roles
son agrupaciones editables desde el panel; los permisos son un catálogo versionado en el
`seed`. Un usuario puede tener varios roles, y su acceso se limita además por sucursal
(`user_branches`).

### Catálogo de permisos

```
CATÁLOGO            product.view · product.create · product.update · product.archive
                    product.cost.view          ← ver el costo es un permiso APARTE
                    product.price.update
                    category.manage · brand.manage · barcode.manage

INVENTARIO          inventory.view · inventory.kardex.view
                    inventory.adjust           ← ajustar existencias
                    inventory.count.create · inventory.count.apply
                    inventory.transfer.create · inventory.transfer.receive
                    inventory.allow_negative   ← vender bajo cero (peligroso)

VENTAS              sale.create · sale.view · sale.view_all
                    sale.discount.apply · sale.discount.unlimited
                    sale.cancel · sale.reprint · sale.hold
                    sale.price_override        ← cambiar precio en el ticket

DEVOLUCIONES        return.create · return.approve · return.refund_cash

CAJA                cash.open · cash.close · cash.movement.create
                    cash.withdrawal · cash.report.x · cash.report.z
                    cash.close_with_difference

COMPRAS             purchase.view · purchase.create · purchase.approve
                    purchase.receive · purchase.cost.update
                    supplier.view · supplier.manage

CLIENTES            customer.view · customer.create · customer.update
                    customer.credit.manage · customer.account.view

PRECIOS             pricing.view · pricing.list.manage · pricing.promotion.manage

REPORTES            report.sales · report.inventory · report.purchases
                    report.profit              ← ver utilidad = ver costos
                    report.cash · report.audit · report.export

ADMINISTRACIÓN      user.view · user.manage · role.manage
                    settings.view · settings.manage
                    branch.manage · warehouse.manage · terminal.manage
                    api_client.manage · webhook.manage
                    import.execute · backup.manage · audit.view
```

**`product.cost.view` separado de `product.view`** es una de las decisiones más importantes
de esta lista. El cajero necesita ver el producto; no necesita ver cuánto te costó. La
separación se aplica en el **serializador**, no en la interfaz: aunque alguien llame al API
directamente, el campo `cost` simplemente no viene en la respuesta.

### Roles predefinidos

| Rol | Alcance |
|---|---|
| **Administrador** | Todo. MFA obligatorio. No se puede eliminar el último |
| **Gerente** | Todo excepto gestión de usuarios, respaldos y clientes de API |
| **Cajero** | Vender, cobrar, su propia caja, devolver con autorización. **Sin costos, sin ajustes de inventario, sin borrar productos** |
| **Almacén** | Inventario, conteos, transferencias, recepción de compras. Sin ventas ni precios |
| **Ventas** | Consulta de catálogo y existencias, clientes, cotizaciones. Sin cobrar |
| **Solo lectura** | Consulta y reportes sin utilidad. Para contadores o auditores externos |
| **API (canal web)** | No es un usuario: es un `api_client` con `scopes` acotados |

El rol Cajero, tal como pediste en el requisito 19, queda exactamente así:

```
Cajero PUEDE:            Cajero NO PUEDE:
  vender                   modificar costos
  cobrar                   ajustar inventario manualmente
  imprimir/reimprimir      eliminar o archivar productos
  suspender ventas         cambiar precios de lista
  abrir/cerrar SU caja     ver reportes de utilidad
  devolver (con PIN de     cerrar caja con diferencia sin autorización
   supervisor si excede)   ver ventas de otros cajeros
```

### Autorización de supervisor

Cuando un cajero intenta algo que excede su permiso, el sistema **no lo bloquea con un error
seco**: pide el PIN de alguien autorizado, ejecuta la acción y la registra con
`authorized_by_user_id`. Es como funciona en la práctica un mostrador real, y deja rastro.

## 2. Auditoría

### Qué se registra

Toda operación que cambie dinero, inventario, precios, permisos o configuración:

```
INVENTARIO   ajustes, conteos aplicados, transferencias, carga inicial
CATÁLOGO     alta, cambio y archivado de productos y variantes
             cambios de precio y de costo   ← con valor anterior y nuevo
VENTAS       cancelaciones, descuentos por encima del límite, cambios de precio
             reimpresiones (quién reimprimió qué ticket y cuándo)
DEVOLUCIONES todas, con quién autorizó
CAJA         apertura, cierre, retiros, diferencias, entradas y salidas
COMPRAS      creación, aprobación, recepción, cambios de costo
SEGURIDAD    login, logout, login fallido, cambio de contraseña
             cambios de rol y de permisos, creación y revocación de llaves de API
SISTEMA      cambios de configuración, importaciones, restauraciones de respaldo
```

### Formato del registro

```json
{
  "occurred_at": "2026-09-05T16:42:11-06:00",
  "user_id": "01J8K0...",
  "user_name": "Juan Pérez",
  "action": "product.price.update",
  "entity_type": "product_variant",
  "entity_id": "01J8K2...",
  "entity_label": "Faja Postquirúrgica X - Negro / M (FJ-0012-NEG-M)",
  "changes": {
    "base_price": { "before": "899.00", "after": "999.00" }
  },
  "reason": "Ajuste por incremento de costo de importación",
  "authorized_by_user_id": null,
  "ip_address": "189.203.44.12",
  "user_agent": "Mozilla/5.0…",
  "request_id": "01J8K4...",
  "branch_id": "01J8K1...",
  "channel_id": "POS"
}
```

Que es exactamente tu ejemplo del requisito 20, con los datos adicionales que hacen la
diferencia cuando de verdad hay que investigar algo.

### Inmutabilidad

```sql
REVOKE UPDATE, DELETE ON audit_logs  FROM app_role;
REVOKE UPDATE, DELETE ON stock_ledger FROM app_role;
GRANT  INSERT, SELECT  ON audit_logs, stock_ledger TO app_role;
```

Un registro de auditoría editable no sirve para auditar. Esto se hace cumplir con permisos
de PostgreSQL: aunque un bug o un atacante ejecutaran un `UPDATE`, la base lo rechaza.

### Interfaz

Bitácora filtrable por usuario, acción, entidad, rango de fechas y sucursal. Desde cualquier
producto, venta o cliente hay un botón **"Ver historial"** que muestra su línea de tiempo
completa. Exportable para auditorías externas.

Retención: **7 años** (alineado con la obligación fiscal mexicana de conservar
contabilidad 5 años, con margen). Particionado mensual; los meses viejos se comprimen y se
archivan a almacenamiento frío sin dejar de ser consultables.

## 3. Endurecimiento de la aplicación

### Contraseñas y sesiones

| Medida | Implementación |
|---|---|
| Hash | **argon2id** (`m=64MB, t=3, p=4`). No bcrypt: mejor resistencia a GPU |
| Política | Mínimo 10 caracteres, verificación contra la lista de contraseñas filtradas (HIBP k-anonimato) |
| PIN del POS | Hasheado igual, con límite de intentos por terminal |
| Bloqueo | Retardo progresivo: 5 fallos → 1 min, 10 → 15 min, con alerta |
| Sesiones | Refresh rotatorio; reutilización detectada revoca todas las sesiones |
| MFA | TOTP. Obligatorio para Administrador, opcional para el resto |

### Validación de entrada

- `ValidationPipe` global con `whitelist: true` y `forbidNonWhitelisted: true`: cualquier
  campo no declarado en el DTO hace fallar la petición. Cierra la asignación masiva.
- Zod compartido entre backend y frontend: una sola definición de cada regla.
- Límite de tamaño de cuerpo (1 MB por defecto, mayor solo en importaciones).
- Validación de archivos por **número mágico**, no por extensión ni por `Content-Type`.
- Imágenes reprocesadas con `sharp` (elimina metadatos y cualquier carga incrustada).

### Inyección SQL

Prisma parametriza siempre. Donde se usa SQL crudo, se usa **exclusivamente**
`$queryRaw` con plantillas etiquetadas (parametrizadas). La concatenación de cadenas en SQL
está prohibida por regla de ESLint (`no-restricted-syntax`) y se revisa en CI.

### Cabeceras y transporte

```
Helmet: CSP, HSTS (max-age 1 año, preload), X-Frame-Options DENY,
        X-Content-Type-Options nosniff, Referrer-Policy same-origin
CORS:   lista blanca explícita de orígenes. NUNCA '*' con credenciales
TLS:    1.2 mínimo, 1.3 preferido. Certificado automático (Caddy/Let's Encrypt)
Cookies: httpOnly + Secure + SameSite=Strict
```

### Secretos

- **Nada de secretos en el repositorio.** `.env` en `.gitignore`, `.env.example` versionado.
- Validación de variables de entorno al arrancar: si falta una, el proceso **no inicia**
  (mejor fallar al desplegar que a media operación).
- En producción: variables del gestor del hosting o Docker secrets. Nunca en la imagen.
- Credenciales de integraciones cifradas en reposo (AES-256-GCM con clave dedicada).
- Rotación documentada para JWT, llaves de API y secretos de webhook.
- Escaneo de secretos en CI (gitleaks) para que un descuido no llegue al repositorio.

### Manejo seguro de errores

Filtro global de excepciones:
- **Al cliente:** código estable, mensaje entendible, `request_id`. Nunca stack trace,
  nunca SQL, nunca nombres de tabla.
- **Al log:** todo el detalle, con el mismo `request_id` para correlacionar.
- Los logs **redactan automáticamente** `password`, `pin`, `token`, `secret`,
  `authorization` y números de tarjeta.

### Dependencias

`pnpm audit` en CI, Dependabot semanal, versiones fijadas con lockfile, y `pnpm ci` en
producción (instala exactamente el lockfile, nunca resuelve versiones nuevas).

## 4. Seguridad de datos

| Dato | Tratamiento |
|---|---|
| Contraseñas y PIN | Hash argon2id. Irrecuperables por diseño |
| Llaves de API | Solo hash en base. Se muestran una única vez |
| Datos de tarjeta | **No se almacenan nunca.** Solo últimos 4 dígitos y autorización, como referencia |
| Datos personales | Cifrado en reposo a nivel de disco; acceso por permiso |
| Respaldos | Cifrados con GPG antes de subir al almacenamiento externo |
| Exportaciones | Registradas en auditoría (quién exportó qué y cuándo) |

**Sobre PCI-DSS:** al no almacenar ni procesar datos de tarjeta —la terminal bancaria es un
dispositivo aparte y los pagos web los cobra tu pasarela— el sistema queda fuera del alcance
más pesado de PCI. Es una decisión deliberada: **no toques datos de tarjeta jamás.**

## 5. Protección específica del inventario

Más allá de la seguridad genérica, el activo a proteger aquí es la mercancía:

| Riesgo | Control |
|---|---|
| Ajuste de inventario para tapar un robo | `inventory.adjust` restringido; todo ajuste exige motivo tipificado y queda auditado; reporte semanal de ajustes por usuario |
| Venta a precio cero o descuento abusivo | `sale.discount.unlimited` restringido; descuentos por encima del umbral exigen PIN de supervisor y se registran |
| Cancelación de tickets para sacar efectivo | `sale.cancel` restringido; toda cancelación pide motivo y aparece en el corte Z |
| Devolución falsa | Toda devolución exige la venta original; reporte de devoluciones por cajero |
| Faltantes de caja recurrentes | Historial de diferencias por cajero visible en el panel |
| Fuga del catálogo con costos | `product.cost.view` separado; toda exportación queda auditada |

Estos controles no existen en Eleventa y son, en la práctica, el mayor retorno de un sistema
propio: el inventario deja de ser una caja negra.
