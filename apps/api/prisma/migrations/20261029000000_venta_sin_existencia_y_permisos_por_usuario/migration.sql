-- ═══════════════════════════════════════════════════════════════════════════
--  1 · VENDER SIN EXISTENCIA
--
--  Decisión del negocio (29-oct-2026): si un artículo se acabó en el sistema
--  pero está en el mostrador, la caja NO se detiene. La existencia queda en
--  negativo (-1, -2…) y el reporte de inventario la señala para revisar
--  después qué pasó (una entrada sin capturar, un conteo mal hecho…).
--
--  La regla vive en la configuración de la tienda; aquí solo se retira la
--  restricción que lo impedía a nivel de base de datos.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "stock_balances" DROP CONSTRAINT IF EXISTS "chk_stock_no_negativo";

-- Lo reservado sigue sin poder pasar de lo que hay; con existencia negativa
-- simplemente no puede haber nada reservado.
ALTER TABLE "stock_balances" DROP CONSTRAINT IF EXISTS "chk_stock_reservado_cubierto";
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "chk_stock_reservado_cubierto"
  CHECK ("qty_reserved" = 0 OR "qty_reserved" <= "qty_on_hand");

-- ═══════════════════════════════════════════════════════════════════════════
--  2 · PERMISOS POR USUARIO
--
--  Además de su rol, a una persona se le puede otorgar (granted = true) o
--  retirar (granted = false) un permiso concreto. Permisos efectivos =
--  permisos de sus roles + otorgados − retirados.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "user_permissions" (
    "user_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by_id" UUID,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("user_id", "permission_id"),
    CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id")
      REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id")
      REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_permissions_permission_id_idx" ON "user_permissions"("permission_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pv_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user_permissions" TO pv_app;
  END IF;
END $$;
