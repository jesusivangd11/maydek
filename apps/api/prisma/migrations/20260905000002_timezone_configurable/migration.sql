-- ═══════════════════════════════════════════════════════════════════════════
--  ZONA HORARIA CONFIGURABLE POR EMPRESA Y SUCURSAL
--
--  Antes: "America/Mexico_City" como valor por defecto en el esquema.
--  Ahora: la empresa DEBE declarar la suya, y cada sucursal puede tener otra.
--
--  Por qué importa: el corte de caja, el día operativo y los reportes diarios
--  dependen de en qué día cae una venta. Con el servidor en UTC y la tienda en
--  UTC−6, una venta de las 19:00 del lunes en Chihuahua cae en martes según UTC.
--  Sin zona por sucursal, el corte Z no cuadra y nadie entiende por qué.
--
--  Los TIMESTAMPTZ siguen guardándose en UTC. Esto solo afecta la PRESENTACIÓN
--  y el cálculo de los límites del día operativo.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Empresa: obligatoria, sin valor por defecto ────────────────────────────
-- Se rellena lo existente antes de quitar el default, para no romper filas.
UPDATE "companies" SET "timezone" = 'America/Chihuahua'
WHERE "timezone" IS NULL OR "timezone" = '';

ALTER TABLE "companies" ALTER COLUMN "timezone" DROP DEFAULT;
ALTER TABLE "companies" ALTER COLUMN "timezone" SET NOT NULL;

COMMENT ON COLUMN "companies"."timezone" IS
  'Zona horaria IANA de la empresa (p. ej. America/Chihuahua). Obligatoria: sin valor por defecto para que nadie herede una zona equivocada en silencio.';

-- ── Sucursal: NULL = hereda la de la empresa ───────────────────────────────
ALTER TABLE "branches" ALTER COLUMN "timezone" DROP DEFAULT;
ALTER TABLE "branches" ALTER COLUMN "timezone" DROP NOT NULL;

-- Las sucursales que quedaron con el valor antiguo pasan a heredar.
UPDATE "branches" SET "timezone" = NULL
WHERE "timezone" = 'America/Mexico_City';

COMMENT ON COLUMN "branches"."timezone" IS
  'Zona horaria IANA de ESTA sucursal. NULL = hereda la de la empresa. Permite abrir una sucursal en otro estado, o en la franja fronteriza donde sí hay horario de verano, sin tocar código.';

COMMENT ON COLUMN "branches"."business_day_cutoff" IS
  'Hora de corte del día operativo (HH:mm) EN LA ZONA DE LA SUCURSAL. Con corte 04:00, una venta de la 01:30 del martes pertenece al lunes.';

-- ── Garantía de integridad ─────────────────────────────────────────────────
-- Una zona vacía es peor que ninguna: parece configurada y no lo está.
ALTER TABLE "companies"
  ADD CONSTRAINT "chk_company_timezone_no_vacia"
  CHECK (length(trim("timezone")) > 0);

ALTER TABLE "branches"
  ADD CONSTRAINT "chk_branch_timezone_no_vacia"
  CHECK ("timezone" IS NULL OR length(trim("timezone")) > 0);

-- Formato HH:mm de 24 horas.
ALTER TABLE "branches"
  ADD CONSTRAINT "chk_branch_cutoff_formato"
  CHECK ("business_day_cutoff" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
