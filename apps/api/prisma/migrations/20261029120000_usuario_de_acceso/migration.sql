-- ═══════════════════════════════════════════════════════════════════════════
--  Ingreso por USUARIO (no por correo)
--
--  Decisión del negocio (29-oct-2026): para entrar más rápido, cada persona
--  tiene un usuario corto («jesus», «carla») y su clave, que puede ser un PIN
--  de al menos 4 dígitos o una contraseña. El correo pasa a ser un dato
--  opcional de contacto.
--
--  El usuario se guarda SIEMPRE en minúsculas: «Carla», «CARLA» y «carla» son
--  la misma persona, sin errores ni duplicados por una mayúscula.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "users" ADD COLUMN "username" VARCHAR(32);

-- A quien ya existe se le deriva del correo («admin@tienda.mx» → «admin»);
-- si dos quedaran igual, el segundo recibe un número («admin2»).
WITH base AS (
  SELECT
    "id",
    "created_at",
    CASE
      WHEN regexp_replace(lower(split_part("email", '@', 1)), '[^a-z0-9._-]', '', 'g') = '' THEN 'usuario'
      ELSE left(regexp_replace(lower(split_part("email", '@', 1)), '[^a-z0-9._-]', '', 'g'), 28)
    END AS "name"
  FROM "users"
), numbered AS (
  SELECT
    "id",
    "name",
    row_number() OVER (PARTITION BY "name" ORDER BY "created_at", "id") AS "n"
  FROM base
)
UPDATE "users" AS u
SET "username" = CASE WHEN numbered."n" = 1 THEN numbered."name" ELSE numbered."name" || numbered."n"::text END
FROM numbered
WHERE u."id" = numbered."id";

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
