-- ═══════════════════════════════════════════════════════════════════════════
--  ENDURECIMIENTO
--
--  Todo lo que Prisma no sabe modelar pero el diseño exige:
--    1. Extensiones para la búsqueda difusa
--    2. Restricciones CHECK del inventario  ← última defensa contra sobreventa
--    3. Columna generada qty_available
--    4. Índices únicos PARCIALES (SKU y código de barras entre no archivados)
--    5. Índices de búsqueda (trigram + texto completo)
--    6. Trigger que mantiene el texto de búsqueda normalizado
--    7. GRANT/REVOKE: el ledger y la auditoría son append-only DE VERDAD
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 · EXTENSIONES ────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- similitud difusa: "postquirurjica"
CREATE EXTENSION IF NOT EXISTS unaccent;  -- "postquirúrgica" = "postquirurgica"
CREATE EXTENSION IF NOT EXISTS btree_gin; -- índices GIN compuestos

-- ── 2 · RESTRICCIONES DEL INVENTARIO ───────────────────────────────────────
-- Última línea de defensa. Si un bug futuro intenta sobrevender, PostgreSQL
-- aborta la transacción. Preferimos un error 500 ruidoso a inventario
-- silenciosamente corrupto (docs/02-modelo-datos.md).

ALTER TABLE "stock_balances"
  ADD CONSTRAINT "chk_stock_no_negativo"
  CHECK ("qty_on_hand" >= 0);

ALTER TABLE "stock_balances"
  ADD CONSTRAINT "chk_stock_reservado_positivo"
  CHECK ("qty_reserved" >= 0);

-- No se puede reservar lo que no existe físicamente.
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "chk_stock_reservado_cubierto"
  CHECK ("qty_reserved" <= "qty_on_hand");

-- El asiento del kardex siempre mueve una cantidad positiva; el sentido lo da
-- `direction`. Un movimiento de cantidad cero o negativa es un bug.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "chk_ledger_qty_positiva"
  CHECK ("qty" > 0);

-- Coherencia interna del asiento: el resultante debe ser el anterior ± la
-- cantidad. Blinda el kardex contra escrituras mal calculadas.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "chk_ledger_coherente"
  CHECK (
    ("direction" = 'IN'  AND "qty_after" = "qty_before" + "qty") OR
    ("direction" = 'OUT' AND "qty_after" = "qty_before" - "qty")
  );

-- Las reservas HELD deben tener vencimiento; las COMMITTED, no (P3).
ALTER TABLE "reservations"
  ADD CONSTRAINT "chk_reserva_ttl"
  CHECK (
    ("status" = 'HELD' AND "expires_at" IS NOT NULL) OR
    ("status" <> 'HELD')
  );

ALTER TABLE "reservations"
  ADD CONSTRAINT "chk_reserva_qty_positiva"
  CHECK ("qty" > 0);

-- Un pago pertenece a una venta O a una devolución O a un abono de cliente,
-- nunca a dos cosas a la vez.
ALTER TABLE "payments"
  ADD CONSTRAINT "chk_pago_un_solo_origen"
  CHECK (
    (CASE WHEN "sale_id"   IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "return_id" IS NOT NULL THEN 1 ELSE 0 END) <= 1
  );

-- Una devolución no puede devolver más de lo vendido en su línea.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "chk_devuelto_no_excede_vendido"
  CHECK ("returned_qty" >= 0 AND "returned_qty" <= "qty");

-- Una recepción no puede recibir cantidades negativas.
ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "chk_compra_cantidades"
  CHECK ("qty_ordered" > 0 AND "qty_received" >= 0);

-- El crédito usado nunca supera el emitido.
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "chk_credito_usado"
  CHECK ("used_amount" >= 0 AND "used_amount" <= "amount");

-- Un almacén de tránsito debe declarar su sucursal destino.
ALTER TABLE "warehouses"
  ADD CONSTRAINT "chk_transito_con_destino"
  CHECK ("type" <> 'TRANSIT' OR "transit_for_branch_id" IS NOT NULL);

-- Una transferencia no puede ser hacia el mismo almacén de origen.
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "chk_transferencia_distinta"
  CHECK ("from_warehouse_id" <> "to_warehouse_id");

-- ── 3 · COLUMNA GENERADA: DISPONIBLE ───────────────────────────────────────
-- No se almacena como dato independiente: un valor duplicado siempre termina
-- desincronizándose. Es lo que responde la API pública (nunca el físico).
ALTER TABLE "stock_balances"
  ADD COLUMN "qty_available" NUMERIC(14,3)
  GENERATED ALWAYS AS ("qty_on_hand" - "qty_reserved") STORED;

COMMENT ON COLUMN "stock_balances"."qty_available" IS
  'Disponible = físico - reservado. Columna generada: NO se escribe a mano. Es el valor que expone la API pública.';

-- Índice para "¿qué está agotado?" y "¿qué tiene existencia?", el filtro más
-- consultado del POS y de la web.
CREATE INDEX "idx_balance_disponible"
  ON "stock_balances" ("warehouse_id", "qty_available")
  WHERE "condition" = 'GOOD';

CREATE INDEX "idx_balance_agotado"
  ON "stock_balances" ("warehouse_id", "variant_id")
  WHERE "qty_available" <= 0;

-- ── 4 · UNICIDAD ENTRE REGISTROS NO ARCHIVADOS ─────────────────────────────
-- Índices PARCIALES: el SKU es único solo entre variantes vivas. Un producto
-- archivado no bloquea para siempre su SKU (docs/02-modelo-datos.md).
CREATE UNIQUE INDEX "uq_variant_sku_activo"
  ON "product_variants" ("sku")
  WHERE "deleted_at" IS NULL;

CREATE UNIQUE INDEX "uq_barcode_activo"
  ON "barcodes" ("code")
  WHERE "deleted_at" IS NULL;

-- Un solo código primario por variante.
CREATE UNIQUE INDEX "uq_barcode_primario"
  ON "barcodes" ("variant_id")
  WHERE "is_primary" = true AND "deleted_at" IS NULL;

-- Una sola lista de precios por defecto.
CREATE UNIQUE INDEX "uq_price_list_default"
  ON "price_lists" (("is_default"))
  WHERE "is_default" = true AND "deleted_at" IS NULL;

-- Un solo almacén por defecto por sucursal.
CREATE UNIQUE INDEX "uq_warehouse_default"
  ON "warehouses" ("branch_id")
  WHERE "is_default" = true AND "deleted_at" IS NULL;

-- UNA sola sesión de caja abierta por terminal. Impide el error clásico de
-- abrir turno sin cerrar el anterior.
CREATE UNIQUE INDEX "uq_cash_session_abierta"
  ON "cash_sessions" ("terminal_id")
  WHERE "status" = 'OPEN';

-- Correo único solo entre usuarios no archivados.
CREATE UNIQUE INDEX "uq_user_email_activo"
  ON "users" ("email")
  WHERE "deleted_at" IS NULL;

-- ── 5 · BÚSQUEDA ───────────────────────────────────────────────────────────
-- La columna `search_document` (tsvector) la crea la migración inicial:
-- está declarada como Unsupported en el esquema para que Prisma la conozca.

-- Trigram: tolera errores de captura ("postquirurjica" encuentra la correcta).
CREATE INDEX "idx_variants_trgm"
  ON "product_variants" USING GIN ("search_text" gin_trgm_ops);

-- Texto completo: relevancia multi-token ("negra m").
CREATE INDEX "idx_variants_fts"
  ON "product_variants" USING GIN ("search_document");

-- Prefijo de SKU: "FJ-00" encuentra coincidencias.
CREATE INDEX "idx_variants_sku_prefijo"
  ON "product_variants" ("sku" varchar_pattern_ops)
  WHERE "deleted_at" IS NULL;

CREATE INDEX "idx_barcode_code_prefijo"
  ON "barcodes" ("code" varchar_pattern_ops)
  WHERE "deleted_at" IS NULL;

-- ── 6 · NORMALIZACIÓN DEL TEXTO DE BÚSQUEDA ────────────────────────────────
-- `unaccent` no es IMMUTABLE, así que no se puede usar en un índice de
-- expresión. Se envuelve en una función IMMUTABLE y se materializa con trigger.
CREATE OR REPLACE FUNCTION pv_normalizar(texto text)
RETURNS text AS $$
  SELECT lower(regexp_replace(unaccent(coalesce(texto, '')), '\s+', ' ', 'g'));
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

COMMENT ON FUNCTION pv_normalizar(text) IS
  'Minúsculas + sin acentos + espacios colapsados. Base de la búsqueda del POS.';

CREATE OR REPLACE FUNCTION pv_variant_search_refresh()
RETURNS trigger AS $$
BEGIN
  NEW."search_text" := pv_normalizar(NEW."search_text");
  NEW."search_document" := to_tsvector('spanish', coalesce(NEW."search_text", ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_variant_search
  BEFORE INSERT OR UPDATE OF "search_text" ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION pv_variant_search_refresh();

-- ── 7 · APPEND-ONLY IMPUESTO POR LA BASE DE DATOS ──────────────────────────
-- Aquí es donde "el kardex es inmutable" y "la auditoría no se puede editar"
-- dejan de ser una convención del equipo y pasan a ser una regla de PostgreSQL.
--
-- El rol de la aplicación (pv_app) recibe lo que necesita para operar, y se le
-- NIEGA explícitamente modificar o borrar historial. Ni un bug ni un atacante
-- con la credencial de la aplicación pueden reescribirlo.

DO $$
DECLARE
  app_role text := current_setting('pv.app_role', true);
BEGIN
  IF app_role IS NULL OR app_role = '' THEN
    app_role := 'pv_app';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = app_role) THEN
    RAISE NOTICE 'El rol % no existe; se omiten los GRANT. '
                 'Créalo y vuelve a aplicar esta migración.', app_role;
    RETURN;
  END IF;

  -- Permisos generales de operación
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    app_role);
  EXECUTE format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

  -- Las tablas que se creen en el futuro heredan estos permisos.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role);

  -- ── LA REGLA ──
  EXECUTE format('REVOKE UPDATE, DELETE ON "stock_ledger" FROM %I', app_role);
  EXECUTE format('REVOKE UPDATE, DELETE ON "audit_logs"   FROM %I', app_role);

  -- La columna generada no se escribe nunca, ni por error.
  EXECUTE format(
    'REVOKE UPDATE ("qty_available") ON "stock_balances" FROM %I', app_role);

  RAISE NOTICE 'Permisos aplicados al rol %: stock_ledger y audit_logs son append-only.', app_role;
END
$$;

COMMENT ON TABLE "stock_ledger" IS
  'KARDEX. Append-only: el rol de aplicación no tiene UPDATE ni DELETE. Corregir un error = asiento contrario, nunca editar el original.';

COMMENT ON TABLE "audit_logs" IS
  'Auditoría INMUTABLE. Append-only: un registro de auditoría editable no sirve para auditar.';

COMMENT ON TABLE "outbox_events" IS
  'Patrón outbox: el evento se escribe en la MISMA transacción que el dato. Imposible que exista una venta sin su evento, o un webhook de una venta que hizo rollback.';

COMMENT ON TABLE "idempotency_keys" IS
  'Idempotencia (req. 27). La clave se inserta dentro de la transacción de la operación: no hay ventana en la que la venta exista pero la clave no.';
