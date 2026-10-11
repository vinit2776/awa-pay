CREATE TYPE "public"."payer_state" AS ENUM('in_progress', 'on_hold');--> statement-breakpoint
CREATE TABLE "request_flag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"raised_as_role" text NOT NULL,
	"reason" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_by" uuid,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "payer_state" "payer_state";--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "payer_state_reason" text;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "payer_review_on" date;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "payer_state_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "payer_state_by" uuid;--> statement-breakpoint
ALTER TABLE "request_flag" ADD CONSTRAINT "request_flag_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_flag" ADD CONSTRAINT "request_flag_raised_by_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_flag" ADD CONSTRAINT "request_flag_cleared_by_user_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_flag_request_id_idx" ON "request_flag" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_payer_state_by_user_id_fk" FOREIGN KEY ("payer_state_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Payer working state (in progress / on hold) lives inside to_pay and is
-- enforced here, not only in application code, the same way
-- request_pay_now_within_total_check (0024) is: a payer state can exist
-- only while the request is still with the payer, its bookkeeping columns
-- are all set or all null together, and a payer hold always carries a
-- reason and a review date. transitions.ts clears the state in the same
-- UPDATE that moves the stage, so this never fires on a correct code path.
ALTER TABLE "request" ADD CONSTRAINT "request_payer_state_shape_check" CHECK (
  (
    "payer_state" IS NULL
    AND "payer_state_reason" IS NULL
    AND "payer_review_on" IS NULL
    AND "payer_state_at" IS NULL
    AND "payer_state_by" IS NULL
  )
  OR (
    "payer_state" IS NOT NULL
    AND "stage" = 'to_pay'
    AND "payer_state_at" IS NOT NULL
    AND "payer_state_by" IS NOT NULL
    AND (
      "payer_state" = 'in_progress' AND "payer_review_on" IS NULL
      OR "payer_state" = 'on_hold' AND "payer_review_on" IS NOT NULL AND length(trim("payer_state_reason")) > 0
    )
  )
);--> statement-breakpoint
-- RLS and app_runtime grants for request_flag. Same shape as nudge
-- (0013): department-scope EXISTS join to request, which inherits
-- request_select's own scoping transitively. A flag can be raised and
-- cleared by the three desks that touch the bill; clearing is the only
-- UPDATE, so the grant is column-level: nobody can rewrite a reason or
-- reassign who raised it, and there is no DELETE grant, ever.
ALTER TABLE "request_flag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY request_flag_select ON request_flag FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = request_flag.request_id AND app_has_department_scope(r.department_id)
  )
);--> statement-breakpoint
CREATE POLICY request_flag_insert ON request_flag FOR INSERT WITH CHECK (
  raised_by = app_actor_id()
  AND raised_as_role = app_actor_role()::text
  AND cleared_at IS NULL
  AND cleared_by IS NULL
  AND app_actor_role() IN ('approver', 'accountant', 'payer')
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = request_flag.request_id
      AND app_has_department_scope(r.department_id)
      AND (app_actor_role() <> 'payer' OR r.company_id IS NULL OR app_has_company_scope(r.company_id))
  )
);--> statement-breakpoint
CREATE POLICY request_flag_clear ON request_flag FOR UPDATE
  USING (
    app_actor_role() IN ('approver', 'accountant', 'payer')
    AND cleared_at IS NULL
    AND EXISTS (
      SELECT 1 FROM request r
      WHERE r.id = request_flag.request_id
        AND app_has_department_scope(r.department_id)
        AND (app_actor_role() <> 'payer' OR r.company_id IS NULL OR app_has_company_scope(r.company_id))
    )
  )
  WITH CHECK (cleared_by = app_actor_id() AND cleared_at IS NOT NULL);--> statement-breakpoint
GRANT SELECT, INSERT ON request_flag TO app_runtime;--> statement-breakpoint
GRANT UPDATE (cleared_by, cleared_at) ON request_flag TO app_runtime;
