-- Se ejecuta UNA sola vez, cuando el volumen de datos se crea desde cero.
-- Solo prepara bases y roles: el esquema lo gobiernan las migraciones de Prisma,
-- que son las que están versionadas.

-- Base de datos separada para las pruebas de integración.
-- Nunca comparten datos con desarrollo.
SELECT 'CREATE DATABASE punto_venta_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'punto_venta_test')\gexec

\connect punto_venta_test
GRANT ALL PRIVILEGES ON DATABASE punto_venta_test TO CURRENT_USER;
