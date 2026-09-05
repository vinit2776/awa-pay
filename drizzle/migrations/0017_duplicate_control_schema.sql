CREATE TYPE "public"."duplicate_verdict" AS ENUM('blocked_paid', 'warned_open', 'escalated_rejected', 'linked_held', 'none');--> statement-breakpoint
-- The Indian financial year (April to March) for a given date, e.g.
-- 2026-01-15 -> '2025-26'. Must be IMMUTABLE to be usable inside a
-- GENERATED ALWAYS AS (...) STORED expression at all (Postgres requires
-- generated column expressions to reference only immutable functions) —
-- created here, before request.fy's own ALTER TABLE below, so the
-- function already exists when that column is defined against it.
CREATE OR REPLACE FUNCTION financial_year(d date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d IS NULL THEN NULL
    WHEN EXTRACT(MONTH FROM d) >= 4
      THEN EXTRACT(YEAR FROM d)::text || '-' || LPAD(((EXTRACT(YEAR FROM d)::int + 1) % 100)::text, 2, '0')
    ELSE (EXTRACT(YEAR FROM d)::int - 1)::text || '-' || LPAD((EXTRACT(YEAR FROM d)::int % 100)::text, 2, '0')
  END
$$;--> statement-breakpoint
CREATE TABLE "duplicate_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"matched_request_id" uuid NOT NULL,
	"signals" text[] NOT NULL,
	"score" integer NOT NULL,
	"verdict" "duplicate_verdict" NOT NULL,
	"overridden_by" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "payment_reference_unique_idx";--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "invoice_key" text GENERATED ALWAYS AS (nullif(upper(trim(invoice_no)), '')) STORED;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "fy" text GENERATED ALWAYS AS (financial_year(invoice_date)) STORED;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "routed_approver_id" uuid;--> statement-breakpoint
ALTER TABLE "duplicate_check" ADD CONSTRAINT "duplicate_check_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_check" ADD CONSTRAINT "duplicate_check_matched_request_id_request_id_fk" FOREIGN KEY ("matched_request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_check" ADD CONSTRAINT "duplicate_check_overridden_by_user_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duplicate_check_request_id_idx" ON "duplicate_check" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "duplicate_check_matched_request_id_idx" ON "duplicate_check" USING btree ("matched_request_id");--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_routed_approver_id_user_id_fk" FOREIGN KEY ("routed_approver_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "one_payment_per_invoice" ON "request" USING btree ("vendor_key","invoice_key","fy") WHERE "request"."stage" = 'paid';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reference_unique_idx" ON "payment" USING btree (upper("reference"));