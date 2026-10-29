-- Tickets de soporte, ventas y contacto que llegan desde la página web pública.
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "folio" VARCHAR(16) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'SUPPORT',
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "priority" VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "company" TEXT,
    "plan" VARCHAR(32),
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "answer" TEXT,
    "answered_by_id" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_tickets_kind_check" CHECK ("kind" IN ('SUPPORT', 'SALES', 'CONTACT')),
    CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'ANSWERED', 'CLOSED'))
);

CREATE UNIQUE INDEX "support_tickets_folio_key" ON "support_tickets"("folio");
CREATE INDEX "support_tickets_status_created_at_idx" ON "support_tickets"("status", "created_at" DESC);
CREATE INDEX "support_tickets_email_idx" ON "support_tickets"("email");

-- El rol de la aplicación necesita leer y escribir la tabla nueva.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pv_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "support_tickets" TO pv_app;
  END IF;
END $$;
