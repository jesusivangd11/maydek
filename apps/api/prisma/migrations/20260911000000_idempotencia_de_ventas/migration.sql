-- ═══════════════════════════════════════════════════════════════════════════
--  Idempotencia de ventas impuesta por la BASE, no por la aplicación
--
--  El POS manda una clave por ticket. El servicio comprueba si ya existe una
--  venta con esa clave antes de crearla, pero esa comprobación es un "lee y
--  luego escribe": entre la lectura y la inserción cabe otra petición. Con un
--  doble clic real —dos peticiones en vuelo a la vez— las dos pueden leer
--  "no existe" y las dos insertar. Resultado: el cliente pagado dos veces.
--
--  Este índice hace que eso sea IMPOSIBLE. La segunda inserción choca contra
--  la restricción y el servicio la traduce devolviendo la venta original.
--
--  Es parcial (WHERE ... IS NOT NULL) porque las ventas sin clave —las que
--  entran por otros canales— deben poder convivir sin chocar entre ellas.
--
--  Prisma no sabe expresar índices parciales, así que vive aquí en SQL y no
--  en schema.prisma, igual que qty_available y los índices trigram.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "sales_branch_idempotency_key"
  ON "sales" ("branch_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

COMMENT ON INDEX "sales_branch_idempotency_key" IS
  'Impide cobrar dos veces el mismo ticket: la clave del POS es única por sucursal.';
