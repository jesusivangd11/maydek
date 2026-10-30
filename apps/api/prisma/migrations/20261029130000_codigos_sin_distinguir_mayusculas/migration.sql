-- ═══════════════════════════════════════════════════════════════════════════
--  SKU y códigos de barras: «f1», «F1» y «f1 » son el MISMO código
--
--  Decisión del negocio (29-oct-2026): en el mostrador nadie debe tener que
--  acordarse de si el código llevaba mayúscula. Los códigos se guardan SIEMPRE
--  en mayúsculas y la unicidad se compara sin distinguirlas, así no pueden
--  convivir «ABC-1» y «abc-1» como si fueran dos productos.
-- ═══════════════════════════════════════════════════════════════════════════

-- Los índices viejos distinguen mayúsculas: se retiran antes de normalizar,
-- para que el UPDATE no choque contra ellos a medio camino.
DROP INDEX IF EXISTS "uq_variant_sku_activo";
DROP INDEX IF EXISTS "uq_barcode_activo";

-- Archivados: solo se normaliza (no participan en la unicidad).
UPDATE "product_variants" SET "sku" = upper(btrim("sku")) WHERE "deleted_at" IS NOT NULL;
UPDATE "barcodes" SET "code" = upper(btrim("code")) WHERE "deleted_at" IS NOT NULL;

-- Vivos: si dos solo se distinguían por mayúsculas, el más antiguo conserva el
-- código y al otro se le añade «-2», «-3»… (se puede corregir desde Productos).
WITH ranked AS (
  SELECT "id",
         upper(btrim("sku")) AS "norm",
         row_number() OVER (PARTITION BY upper(btrim("sku")) ORDER BY "created_at", "id") AS "n"
  FROM "product_variants"
  WHERE "deleted_at" IS NULL
)
UPDATE "product_variants" AS v
SET "sku" = CASE WHEN ranked."n" = 1 THEN ranked."norm" ELSE ranked."norm" || '-' || ranked."n"::text END
FROM ranked
WHERE v."id" = ranked."id";

WITH ranked AS (
  SELECT "id",
         upper(btrim("code")) AS "norm",
         row_number() OVER (PARTITION BY upper(btrim("code")) ORDER BY "created_at", "id") AS "n"
  FROM "barcodes"
  WHERE "deleted_at" IS NULL
)
UPDATE "barcodes" AS b
SET "code" = CASE WHEN ranked."n" = 1 THEN ranked."norm" ELSE ranked."norm" || '-' || ranked."n"::text END
FROM ranked
WHERE b."id" = ranked."id";

CREATE UNIQUE INDEX "uq_variant_sku_activo"
  ON "product_variants" (upper("sku"))
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_barcode_activo"
  ON "barcodes" (upper("code"))
  WHERE "deleted_at" IS NULL;
