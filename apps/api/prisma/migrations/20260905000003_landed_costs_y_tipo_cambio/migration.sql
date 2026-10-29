-- ═══════════════════════════════════════════════════════════════════════════
--  COSTOS DE IMPORTACIÓN DESGLOSADOS Y TIPOS DE CAMBIO HISTÓRICOS
--
--  Prepara el modelo para MXN / COP / USD, tipo de cambio, flete, aduana,
--  impuestos de importación, traslado y landed cost. La decisión OPERATIVA
--  (qué tipo de cambio usar, cómo prorratear cada concepto) se define antes de
--  la Fase 6; esto solo deja la estructura lista para cualquiera de las opciones.
--
--  ⚠ ESCRITA A MANO, a propósito.
--  `prisma migrate diff` proponía además borrar idx_variants_fts,
--  idx_variants_trgm y la columna generada qty_available, porque Prisma no sabe
--  modelarlos. Aceptar esa propuesta habría destruido el motor de búsqueda y el
--  cálculo de disponibilidad. Es exactamente el motivo de la regla documentada:
--  generar el SQL, LEERLO, y aplicar solo lo intencional.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Tipos de costo de importación ──────────────────────────────────────────
CREATE TYPE "LandedCostType" AS ENUM (
  'FREIGHT_INTERNATIONAL',  -- flete internacional
  'FREIGHT_LOCAL',          -- traslado de aduana a bodega
  'CUSTOMS',                -- agente aduanal, honorarios, DTA
  'IMPORT_DUTY',            -- impuestos de importación (IGI)
  'INSURANCE',              -- seguro de la mercancía
  'HANDLING',               -- maniobras, almacenaje
  'OTHER'
);

-- ── Costos desglosados por recepción ───────────────────────────────────────
CREATE TABLE "landed_costs" (
  "id" UUID NOT NULL,
  "receipt_id" UUID NOT NULL,
  "type" "LandedCostType" NOT NULL,
  "description" TEXT,
  "amount" DECIMAL(14,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'MXN',
  "exchange_rate" DECIMAL(14,6) NOT NULL DEFAULT 1,
  "amount_base" DECIMAL(14,4) NOT NULL,
  "allocation_method" VARCHAR(16),
  "document_ref" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "landed_costs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "landed_costs_receipt_id_idx" ON "landed_costs"("receipt_id");
CREATE INDEX "landed_costs_type_created_at_idx" ON "landed_costs"("type", "created_at");

ALTER TABLE "landed_costs"
  ADD CONSTRAINT "landed_costs_receipt_id_fkey"
  FOREIGN KEY ("receipt_id") REFERENCES "purchase_receipts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Un costo de importación negativo no existe; un tipo de cambio cero, tampoco.
ALTER TABLE "landed_costs"
  ADD CONSTRAINT "chk_landed_cost_positivo"
  CHECK ("amount" >= 0 AND "amount_base" >= 0 AND "exchange_rate" > 0);

ALTER TABLE "landed_costs"
  ADD CONSTRAINT "chk_landed_cost_metodo"
  CHECK ("allocation_method" IS NULL
         OR "allocation_method" IN ('BY_VALUE','BY_WEIGHT','BY_QTY'));

COMMENT ON TABLE "landed_costs" IS
  'Costos de importación desglosados por recepción. Reemplaza a freight_cost y other_landed_costs: con cuatro categorías distintas, meterlas en "otros" hace imposible responder cuánto costó la aduana en el año.';

COMMENT ON COLUMN "landed_costs"."amount_base" IS
  'Importe convertido a la moneda de la empresa, CONGELADO al registrar. El costo histórico no cambia porque el dólar suba mañana.';

-- ── Tipos de cambio históricos ─────────────────────────────────────────────
CREATE TABLE "exchange_rates" (
  "id" UUID NOT NULL,
  "from_currency" VARCHAR(3) NOT NULL,
  "to_currency" VARCHAR(3) NOT NULL,
  "rate" DECIMAL(18,8) NOT NULL,
  "valid_on" DATE NOT NULL,
  "source" VARCHAR(24) NOT NULL DEFAULT 'MANUAL',
  "notes" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rates_from_currency_to_currency_valid_on_source_key"
  ON "exchange_rates"("from_currency", "to_currency", "valid_on", "source");

CREATE INDEX "exchange_rates_from_currency_to_currency_valid_on_idx"
  ON "exchange_rates"("from_currency", "to_currency", "valid_on" DESC);

ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "chk_exchange_rate_positivo" CHECK ("rate" > 0);

-- Una conversión de una moneda a sí misma no es un tipo de cambio.
ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "chk_exchange_monedas_distintas"
  CHECK ("from_currency" <> "to_currency");

COMMENT ON TABLE "exchange_rates" IS
  'Tipos de cambio históricos. Cada documento congela el suyo; esta tabla alimenta el valor por defecto y permite auditar de dónde salió (DOF, BANXICO, MANUAL).';

-- ── Recepción de compra: moneda con trazabilidad ───────────────────────────
ALTER TABLE "purchase_receipts" ADD COLUMN "exchange_rate_source" TEXT;

-- Los dos campos sueltos se sustituyen por landed_costs.
-- Se migra lo que hubiera antes de eliminarlos: hoy la tabla está vacía, pero
-- la migración debe ser correcta también si se aplica sobre datos.
INSERT INTO "landed_costs" (id, receipt_id, type, description, amount, currency, exchange_rate, amount_base, created_at)
SELECT gen_random_uuid(), id, 'FREIGHT_INTERNATIONAL', 'Migrado de freight_cost',
       "freight_cost", "currency", "exchange_rate", "freight_cost" * "exchange_rate", now()
FROM "purchase_receipts" WHERE "freight_cost" > 0;

INSERT INTO "landed_costs" (id, receipt_id, type, description, amount, currency, exchange_rate, amount_base, created_at)
SELECT gen_random_uuid(), id, 'OTHER', 'Migrado de other_landed_costs',
       "other_landed_costs", "currency", "exchange_rate", "other_landed_costs" * "exchange_rate", now()
FROM "purchase_receipts" WHERE "other_landed_costs" > 0;

ALTER TABLE "purchase_receipts" DROP COLUMN "freight_cost";
ALTER TABLE "purchase_receipts" DROP COLUMN "other_landed_costs";

COMMENT ON COLUMN "purchase_receipts"."currency" IS
  'Moneda de la FACTURA del proveedor (MXN, USD, COP). Cada documento congela su tipo de cambio: el costo histórico es inmutable.';

-- ── Monedas admitidas ──────────────────────────────────────────────────────
-- Lista corta y explícita en vez de texto libre: evita que convivan "USD",
-- "usd" y "Dólares" en la misma columna.
ALTER TABLE "purchase_receipts"
  ADD CONSTRAINT "chk_receipt_moneda"
  CHECK ("currency" IN ('MXN','USD','COP','EUR'));

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "chk_order_moneda"
  CHECK ("currency" IN ('MXN','USD','COP','EUR'));

ALTER TABLE "landed_costs"
  ADD CONSTRAINT "chk_landed_moneda"
  CHECK ("currency" IN ('MXN','USD','COP','EUR'));

ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "chk_exchange_monedas"
  CHECK ("from_currency" IN ('MXN','USD','COP','EUR')
     AND "to_currency"   IN ('MXN','USD','COP','EUR'));

-- ── Permisos para el rol de aplicación ─────────────────────────────────────
DO $$
DECLARE app_role text := 'pv_app';
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON "landed_costs"   TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON "exchange_rates" TO %I', app_role);
  END IF;
END
$$;
