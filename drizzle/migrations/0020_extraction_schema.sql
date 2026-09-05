CREATE TYPE "public"."extraction_attempt_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."extraction_field" AS ENUM('vendor', 'amount', 'currency', 'invoiceNo', 'invoiceDate', 'gstin');--> statement-breakpoint
CREATE TABLE "extraction_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"attempted_by" uuid NOT NULL,
	"request_id" uuid,
	"status" "extraction_attempt_status" NOT NULL,
	"model" text,
	"escalated" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"field" "extraction_field" NOT NULL,
	"value" text,
	"confidence" real,
	"accepted_value" text,
	"corrected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request" ADD COLUMN "gstin_on_bill" text;--> statement-breakpoint
ALTER TABLE "extraction_attempt" ADD CONSTRAINT "extraction_attempt_attempted_by_user_id_fk" FOREIGN KEY ("attempted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_attempt" ADD CONSTRAINT "extraction_attempt_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction" ADD CONSTRAINT "extraction_attempt_id_extraction_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."extraction_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction" ADD CONSTRAINT "extraction_corrected_by_user_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_attempt_storage_key_idx" ON "extraction_attempt" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "extraction_attempt_attempted_by_idx" ON "extraction_attempt" USING btree ("attempted_by");--> statement-breakpoint
CREATE INDEX "extraction_attempt_request_id_idx" ON "extraction_attempt" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "extraction_attempt_id_idx" ON "extraction" USING btree ("attempt_id");