CREATE TYPE "public"."vendor_document_kind" AS ENUM('gst_certificate', 'pan_card', 'udyam_certificate', 'cancelled_cheque', 'other');--> statement-breakpoint
CREATE TABLE "vendor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text,
	"gstin" text,
	"pan" text,
	"udyam" text,
	"tds_section" text,
	"registered_address" text,
	"contact_name" text,
	"contact_phone" text,
	"contact_email" text,
	"payment_terms_days" integer,
	"default_head_id" uuid,
	"vendor_key" text GENERATED ALWAYS AS (coalesce(gstin, pan, id::text)) STORED NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_bank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"beneficiary_name" text NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"account_number_last4" text NOT NULL,
	"ifsc" text NOT NULL,
	"branch" text,
	"effective_from" date NOT NULL,
	"superseded_at" timestamp with time zone,
	"entered_by" uuid NOT NULL,
	"entered_as_role" "role" NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	CONSTRAINT "vendor_bank_last4_length_check" CHECK (char_length("vendor_bank"."account_number_last4") = 4)
);
--> statement-breakpoint
CREATE TABLE "vendor_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"kind" "vendor_document_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"expires_on" date,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_document_sha256_length_check" CHECK (char_length("vendor_document"."sha256") = 64)
);
--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "vendor_key" text;--> statement-breakpoint
-- Added nullable first, backfilled below, then set NOT NULL — drizzle-kit's
-- own single-statement "ADD COLUMN ... NOT NULL" would fail outright
-- against this dev DB's existing accounting rows (real walkthrough
-- fixtures from earlier phases, not empty-table CI). See the backfill
-- block after the FKs/indexes below for why.
ALTER TABLE "accounting" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_default_head_id_head_of_account_id_fk" FOREIGN KEY ("default_head_id") REFERENCES "public"."head_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank" ADD CONSTRAINT "vendor_bank_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank" ADD CONSTRAINT "vendor_bank_entered_by_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank" ADD CONSTRAINT "vendor_bank_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_document" ADD CONSTRAINT "vendor_document_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_document" ADD CONSTRAINT "vendor_document_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_gstin_unique_idx" ON "vendor" USING btree ("gstin") WHERE "vendor"."gstin" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_pan_unique_idx" ON "vendor" USING btree ("pan") WHERE "vendor"."pan" is not null;--> statement-breakpoint
CREATE INDEX "vendor_bank_vendor_id_idx" ON "vendor_bank" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bank_current_unique_idx" ON "vendor_bank" USING btree ("vendor_id") WHERE "vendor_bank"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "vendor_document_vendor_id_idx" ON "vendor_document" USING btree ("vendor_id");--> statement-breakpoint
-- Backfill: every pre-existing accounting row predates the vendor master
-- and only ever had request.vendor's free text. Turn that text into a real
-- vendor record (attributed to whoever originally accounted the bill)
-- rather than discarding it, then link it — this is what lets the NOT
-- NULL constraint below hold without losing real trail data.
DO $$
DECLARE
  r RECORD;
  v_id uuid;
BEGIN
  FOR r IN
    SELECT a.id AS accounting_id, a.accounted_by, coalesce(nullif(trim(req.vendor), ''), 'Unknown vendor') AS vendor_name
    FROM accounting a
    JOIN request req ON req.id = a.request_id
    WHERE a.vendor_id IS NULL
  LOOP
    INSERT INTO vendor (name, created_by) VALUES (r.vendor_name, r.accounted_by) RETURNING id INTO v_id;
    UPDATE accounting SET vendor_id = v_id WHERE id = r.accounting_id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "accounting" ALTER COLUMN "vendor_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting" ADD CONSTRAINT "accounting_vendor_id_vendor_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendor"("id") ON DELETE no action ON UPDATE no action;