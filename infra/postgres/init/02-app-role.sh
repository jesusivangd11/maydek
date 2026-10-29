#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Crea el rol restringido con el que corre la aplicación.
#
#  Se ejecuta UNA vez, cuando el volumen de datos se crea desde cero.
#  Aquí solo se crea el rol y se le da acceso a la base; los permisos finos
#  (y sobre todo los REVOKE del ledger y la auditoría) viven en la migración
#  de endurecimiento, que sí está versionada.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_USER="${APP_DB_USER:-pv_app}"
APP_PASS="${APP_DB_PASSWORD:?APP_DB_PASSWORD es obligatoria}"

for DB in "$POSTGRES_DB" punto_venta_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB" <<-SQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_USER}') THEN
        CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}';
        RAISE NOTICE 'Rol ${APP_USER} creado.';
      ELSE
        ALTER ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}';
        RAISE NOTICE 'Rol ${APP_USER} ya existía; contraseña actualizada.';
      END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE ${DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA public TO ${APP_USER};

    -- El rol de aplicación NO crea objetos: eso es trabajo de las migraciones.
    REVOKE CREATE ON SCHEMA public FROM ${APP_USER};
SQL
done

echo "✓ Rol de aplicación '${APP_USER}' listo en $POSTGRES_DB y punto_venta_test."
