CREATE TYPE "public"."request_kind" AS ENUM('invoice', 'advance');--> statement-breakpoint
DROP INDEX "payment_request_id_unique_idx";--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "kind" "request_kind" DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "pay_now_minor" bigint;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "pay_now_reason" text;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "quotation_no" text;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "invoice_expected_by" date;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "invoice_attached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_pay_now_within_total_check" CHECK ("request"."pay_now_minor" IS NULL OR ("request"."pay_now_minor" > 0 AND "request"."pay_now_minor" <= "request"."amount_minor"));--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_advance_needs_pay_now_check" CHECK ("request"."kind" <> 'advance' OR "request"."pay_now_minor" IS NOT NULL);
-- Hand-authored (drizzle-kit does not generate RLS). Additive by design:
-- every new column above is nullable or defaulted and the widened policy
-- below only ever admits more rows, so the previously deployed app keeps
-- working against this schema.
--
-- The requester attaches the tax invoice once an advance is paid, so the
-- requester branch of request_update widens from 'raised' to also cover
-- 'awaiting_invoice'. transitions.ts's attachInvoice has fromStages
-- ['awaiting_invoice'], which stays inside this policy — see the
-- load-bearing note in runTransition about FOR UPDATE and requester-role
-- transitions: a locking read only sees rows an applicable UPDATE policy
-- also admits.
DROP POLICY request_update ON request;--> statement-breakpoint
CREATE POLICY request_update ON request FOR UPDATE
  USING (
    app_actor_role() IN ('super_admin', 'developer')
    OR (app_actor_role() IN ('approver', 'accountant', 'payer') AND app_has_department_scope(department_id))
    OR (app_actor_role() = 'requester' AND app_has_department_scope(department_id) AND stage IN ('raised', 'awaiting_invoice'))
  )
  WITH CHECK (
    app_has_department_scope(department_id)
    AND (company_id IS NULL OR app_has_company_scope(company_id))
  );
