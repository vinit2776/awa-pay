CREATE TYPE "public"."hold_sub_reason" AS ENUM('short_supply', 'damaged', 'quality_rejected', 'rate_dispute', 'awaiting_credit_note', 'service_not_rendered');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('neft', 'rtgs', 'imps', 'upi', 'cheque', 'other');--> statement-breakpoint
CREATE TYPE "public"."request_file_kind" AS ENUM('bill', 'payment_advice');--> statement-breakpoint
CREATE TABLE "head_of_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "head_of_account_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "accounting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"head_id" uuid NOT NULL,
	"voucher_no" text NOT NULL,
	"booked_on" date NOT NULL,
	"accounted_by" uuid NOT NULL,
	"accounted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"from_account" jsonb NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"value_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"tds_minor" bigint DEFAULT 0 NOT NULL,
	"reference" text NOT NULL,
	"paid_by" uuid NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_minor_positive_check" CHECK ("payment"."amount_minor" > 0),
	CONSTRAINT "payment_tds_minor_nonneg_check" CHECK ("payment"."tds_minor" >= 0),
	CONSTRAINT "payment_reference_not_blank_check" CHECK (char_length("payment"."reference") > 0)
);
--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "hold_sub_reason" "hold_sub_reason";--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "request_file" ADD COLUMN "kind" "request_file_kind" DEFAULT 'bill' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting" ADD CONSTRAINT "accounting_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting" ADD CONSTRAINT "accounting_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting" ADD CONSTRAINT "accounting_head_id_head_of_account_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."head_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting" ADD CONSTRAINT "accounting_accounted_by_user_id_fk" FOREIGN KEY ("accounted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_paid_by_user_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_request_id_idx" ON "accounting" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_request_id_unique_idx" ON "payment" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reference_unique_idx" ON "payment" USING btree ("reference");--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;