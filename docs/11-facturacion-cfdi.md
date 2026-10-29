# 11 — Capa de integración fiscal (CFDI 4.0)

> **Decisión D2 tomada.** Sí se contempla facturación CFDI, pero **no en la primera versión
> funcional**. Se diseña ahora la capa de integración y se capturan desde el día uno los
> datos que hacen falta; el timbrado real con un PAC llega en una fase posterior.
>
> **No se implementa ninguna solución fiscal improvisada.**

## 1. El principio que gobierna todo este módulo

```
   La venta y la factura son dos documentos distintos, con dos tiempos distintos.
```

La venta se cierra, el ticket se imprime y el inventario se descuenta **sin esperar jamás
al SAT**. La factura es un documento posterior que se genera a partir de una venta ya
cerrada. Consecuencias prácticas:

- El cajero nunca espera un timbrado. Si el PAC está caído o el SAT no responde, **la tienda
  sigue vendiendo**.
- Un fallo de timbrado nunca puede corromper una venta ni un movimiento de inventario.
- El módulo fiscal se puede activar, desactivar, reintentar o cambiar de proveedor sin tocar
  el POS.

Esto lo separa de la mayoría de los sistemas del mercado, donde el timbrado va dentro de la
transacción de venta y una caída del PAC detiene el mostrador.

## 2. Qué se hace ahora y qué después

| Momento | Alcance | Costo |
|---|---|---|
| **Fase 2** (catálogo) | Catálogos del SAT + campos fiscales en empresa, cliente, producto y métodos de pago. Validación de RFC por formato | ≈3 días |
| **Fase 5** (tickets) | El ticket imprime folio e importe con el formato que permite autofacturar después | incluido |
| **Fase 7** (devoluciones) | Las devoluciones ya nacen preparadas para generar CFDI de Egreso | incluido |
| **Fase 13** (posterior, opcional) | Timbrado real con PAC, factura global, complemento de pago, cancelación, autofacturación | ≈3 semanas |

**Por qué pagar los 3 días ahora.** Los datos fiscales son datos de *catálogo*: clave del SAT
por producto, régimen fiscal por cliente, código postal fiscal. Capturarlos después significa
volver a tocar producto por producto y cliente por cliente. Capturarlos desde el inicio no
cuesta casi nada porque se llenan mientras se da de alta el catálogo por primera vez.

## 3. Catálogos del SAT (Fase 2)

Se cargan como tablas de referencia, versionadas y actualizables sin desplegar código:

```sql
sat_regimenes_fiscales   -- c_RegimenFiscal   (601 General, 612 PF act. empresarial, 626 RESICO…)
sat_usos_cfdi            -- c_UsoCFDI         (G01 Adquisición, G03 Gastos, S01 Sin efectos…)
sat_claves_prod_serv     -- c_ClaveProdServ   (~52 000 filas)
sat_claves_unidad        -- c_ClaveUnidad     (H87 Pieza, XBX Caja…)
sat_formas_pago          -- c_FormaPago       (01 Efectivo, 03 Transferencia,
                         --                    04 T. crédito, 28 T. débito, 99 Por definir)
sat_impuestos            -- c_Impuesto        (002 IVA, 003 IEPS, 001 ISR)
sat_motivos_cancelacion  -- c_MotivoCancelacion (01…04)
sat_periodicidad         -- para la factura global
```

Para una distribuidora de fajas, prácticamente todo el catálogo cae en una o dos claves de
producto del SAT. El alta masiva se resuelve asignando una **clave por defecto a nivel de
categoría** y dejando que el producto la herede; solo las excepciones se capturan a mano.

## 4. Campos que se añaden en la Fase 2

```sql
companies
  + rfc, razon_social            -- EXACTAMENTE como está en la Constancia de Situación Fiscal
  + regimen_fiscal_id, codigo_postal_fiscal
  + csd_cer_ref, csd_key_ref     -- referencias a los archivos cifrados (nunca en la BD)
  + csd_password_enc             -- AES-256-GCM
  + csd_serial, csd_valid_from, csd_valid_until
  + pac_provider, pac_credentials_enc, pac_mode (SANDBOX|PRODUCTION)
  + serie_facturas, serie_notas_credito

customers
  + rfc, razon_social_fiscal
  + codigo_postal_fiscal         -- OBLIGATORIO en CFDI 4.0, y es el error más común
  + regimen_fiscal_id
  + uso_cfdi_default
  + requiere_factura BOOL        -- marca al cliente que siempre factura

products / product_variants
  + sat_clave_prod_serv_id       -- heredable desde la categoría
  + sat_clave_unidad_id
  + objeto_impuesto              -- '01' no objeto · '02' sí objeto · '03' sí, sin desglose

payment_methods
  + sat_forma_pago               -- mapea tu método interno al catálogo del SAT

sales
  + metodo_pago_sat              -- 'PUE' (una exhibición) | 'PPD' (parcialidades/diferido)
  + exportacion                  -- '01' No aplica, en tu caso siempre
  + moneda, tipo_cambio
  + invoice_status               -- NOT_REQUESTED · PENDING · INVOICED · IN_GLOBAL · FAILED
```

`codigo_postal_fiscal` del cliente merece una nota: **es obligatorio en CFDI 4.0 y debe
coincidir con el domicilio fiscal registrado en el SAT.** Si no coincide, el timbrado se
rechaza. Es la causa número uno de facturas rechazadas, y por eso se captura y valida desde
el alta del cliente, no en el momento de facturar.

## 5. Modelo de datos fiscal (diseñado ahora, creado en Fase 13)

```sql
fiscal_documents                 -- el CFDI
  id, tipo,                      -- INGRESO · EGRESO(nota de crédito) · PAGO(REP) · GLOBAL
  sale_id NULL, return_id NULL, global_batch_id NULL,
  serie, folio,
  uuid,                          -- folio fiscal que devuelve el SAT
  status,                        -- DRAFT · QUEUED · STAMPING · STAMPED
                                 -- CANCEL_REQUESTED · CANCELLED · FAILED
  -- receptor, fotografiado al emitir (nunca referencias vivas)
  receptor_rfc, receptor_nombre, receptor_cp, receptor_regimen, uso_cfdi,
  -- importes
  subtotal, descuento, total, moneda, tipo_cambio,
  metodo_pago_sat, forma_pago_sat,
  -- resultado del timbrado
  xml_url, pdf_url,              -- en S3, nunca en la base de datos
  cadena_original, sello_sat, no_certificado_sat, fecha_timbrado,
  -- trazabilidad del PAC
  pac_provider, pac_request_id, pac_error_code, pac_error_message,
  attempts, next_retry_at,
  idempotency_key UNIQUE,
  created_at, stamped_at, cancelled_at

fiscal_document_items            -- conceptos, también fotografiados
  fiscal_document_id, sale_item_id,
  clave_prod_serv, clave_unidad, no_identificacion,   -- el SKU
  cantidad, descripcion, valor_unitario, importe, descuento,
  objeto_imp, traslados JSONB, retenciones JSONB

fiscal_relations                 -- CFDI relacionados (nota de crédito → factura original)
  fiscal_document_id, tipo_relacion, uuid_relacionado

fiscal_cancellations             -- historial de intentos, con acuse
  fiscal_document_id, motivo, uuid_sustituto,
  status, acuse_xml_url, solicitado_por, solicitado_at, resuelto_at

fiscal_global_batches            -- factura global del público en general
  periodo_inicio, periodo_fin, periodicidad, meses, anio,
  fiscal_document_id, ventas_incluidas, total, status

fiscal_payment_complements       -- REP, cuando el método es PPD
  fiscal_document_id, payment_id, parcialidad,
  saldo_anterior, monto_pagado, saldo_insoluto
```

**Los datos del receptor y de los conceptos se fotografían**, igual que en las ventas. Un
CFDI timbrado es un documento legal inmutable: si mañana el cliente cambia de razón social,
la factura del año pasado debe seguir mostrando la de entonces.

## 6. La abstracción del PAC

Esta es la pieza central de lo que pediste: **dejar preparada la capa de integración**.

```typescript
// apps/api/src/modules/fiscal/providers/stamping-provider.interface.ts

export interface FiscalStampingProvider {
  readonly name: string;

  /** Timbra un CFDI. Devuelve UUID, XML sellado y datos del timbre. */
  stamp(payload: CfdiPayload, opts: StampOptions): Promise<StampResult>;

  /** Solicita cancelación. Motivo obligatorio; el 01 exige UUID sustituto. */
  cancel(uuid: string, motivo: MotivoCancelacion,
         uuidSustituto?: string): Promise<CancelResult>;

  /** Consulta el estatus real del comprobante ante el SAT. */
  status(uuid: string): Promise<SatDocumentStatus>;

  /** Valida que un RFC exista y esté activo (LCO / lista 69-B). */
  validateRfc(rfc: string): Promise<RfcValidation>;

  /** Créditos de timbrado restantes, para alertar antes de quedarse sin. */
  balance(): Promise<{ remaining: number }>;
}
```

Implementaciones intercambiables por variable de entorno:

```
FacturamaProvider · SwSapienProvider · FinkokProvider · MockProvider (pruebas)
```

**Cambiar de PAC es cambiar `FISCAL_PAC_PROVIDER`.** Ninguna otra parte del sistema conoce
al proveedor. Esto importa más de lo que parece: los PAC cambian de precio, de límites y de
calidad de servicio, y quedar amarrado a uno es una decisión que se paga durante años.

`MockProvider` permite desarrollar y probar todo el flujo fiscal sin gastar timbres y sin
credenciales reales, incluidos los casos de error.

## 7. Flujos

### Emisión desde una venta

```
   Venta cerrada en el POS  ──►  ticket impreso  ──►  COMMIT
          │                       (el mostrador ya siguió atendiendo)
          │ outbox: SALE_COMPLETED
          ▼
   ¿El cliente pidió factura?
          │
    ┌─────┴─────────────────────────────────┐
    │ SÍ                                     │ NO
    ▼                                        ▼
  Cola de timbrado (BullMQ)            invoice_status = NOT_REQUESTED
    ├ arma el CFDI desde la venta        queda disponible para:
    ├ valida receptor y catálogos          · autofacturación del cliente
    ├ provider.stamp()                       (dentro del plazo configurado)
    │   ├ éxito → STAMPED                  · FACTURA GLOBAL del periodo
    │   │         XML + PDF a S3
    │   │         correo al cliente
    │   │         outbox: INVOICE_STAMPED
    │   └ error → reintentos 1m·5m·30m·2h
    │             → FAILED + alerta al admin
    └ nunca bloquea nada aguas arriba
```

### Factura global (ventas al público en general)

Un job agrupa, por periodo configurable, todas las ventas que no pidieron factura:

```
Receptor RFC     XAXX010101000
Nombre           PUBLICO EN GENERAL
Domicilio fiscal código postal del emisor
Régimen receptor 616 · Sin obligaciones fiscales
Uso CFDI         S01 · Sin efectos fiscales
Nodo             InformacionGlobal (Periodicidad · Meses · Año)
```

**Regla de seguridad:** una venta ya incluida en una factura global **no puede facturarse
individualmente** después. El sistema lo bloquea y explica por qué, en vez de generar una
duplicidad que el SAT detectaría más tarde.

### Autofacturación (Fase 13)

Endpoint público donde el cliente factura solo, con el folio y el importe de su ticket:

```
POST /public/v1/invoicing/self-service
     { folio, total, rfc, razon_social, codigo_postal, regimen, uso_cfdi }
```

Evita capturar datos fiscales en el mostrador —que es donde se cometen los errores y se
hace lento el cobro— y reduce el trabajo administrativo a cero. Con rate limiting agresivo
y validación de folio más importe para que nadie pueda facturar tickets ajenos.

### Devolución → nota de crédito

Una devolución de una venta facturada genera un **CFDI de Egreso** relacionado al original
con `TipoRelacion = 01`. Se dispara desde el mismo flujo de devolución, en su cola, sin
bloquearlo.

### Cancelación

Requiere motivo del catálogo del SAT; el motivo `01` (comprobante emitido con errores, con
relación) exige el UUID del comprobante que lo sustituye. El sistema guarda el **acuse de
cancelación** y consulta el estatus real ante el SAT antes de darlo por cancelado — no
confía en la respuesta inmediata del PAC.

## 8. Seguridad del sello digital

El CSD es, legalmente, la firma de tu empresa. Su tratamiento:

| Riesgo | Control |
|---|---|
| Robo del `.key` | Cifrado AES-256-GCM. La clave maestra vive en el gestor de secretos, **nunca en la base ni en el repositorio** |
| Respaldo comprometido | Los respaldos ya van cifrados con GPG; el CSD queda doblemente cifrado |
| Uso no autorizado | Timbrar exige permiso `fiscal.stamp`; todo timbrado y toda cancelación quedan en auditoría con usuario y motivo |
| Certificado vencido | Alerta a los 60, 30 y 7 días del vencimiento. Un CSD vencido detiene la facturación por completo |
| Credenciales del PAC | Cifradas igual que el CSD, rotables sin desplegar |

## 9. Lo que este módulo deliberadamente **no** hace

- ❌ **No contabiliza.** No genera pólizas ni balanza. Es facturación, no contabilidad.
- ❌ **No presenta declaraciones.** Eso es trabajo de tu contador con su propio software.
- ❌ **No implementa complementos que no necesitas** (Carta Porte, Comercio Exterior,
  Nómina). Si alguno hiciera falta después, entra por la misma abstracción del PAC.
- ❌ **No factura sin CSD real.** No hay «modo simulado» en producción: o está bien
  configurado, o el módulo está apagado y las ventas se acumulan para la factura global.

## 10. Decisiones que quedarán para la Fase 13

No hace falta responderlas ahora; se anotan para no olvidarlas:

| # | Pregunta |
|---|---|
| F1 | ¿Qué PAC? (Facturama es el de integración más simple; SW y Finkok son más baratos por volumen) |
| F2 | ¿Periodicidad de la factura global: diaria, semanal o mensual? |
| F3 | ¿Plazo para que el cliente autofacture? (habitual: hasta fin del mes de la compra) |
| F4 | ¿Se factura también a clientes mayoristas con método PPD (crédito)? Eso activa el complemento de pago |
| F5 | ¿Régimen fiscal de la empresa? Determina retenciones y validaciones |
