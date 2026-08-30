CREATE TYPE "public"."company_scope" AS ENUM('global', 'list', 'n/a');--> statement-breakpoint
CREATE TYPE "public"."dept_scope" AS ENUM('global', 'list');--> statement-breakpoint
CREATE TYPE "public"."request_stage" AS ENUM('raised', 'awaiting_approval', 'with_accounts', 'to_pay', 'paid', 'on_hold', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('requester', 'approver', 'accountant', 'payer', 'super_admin', 'developer');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text NOT NULL,
	"gstin" text,
	"pan" text,
	"registered_address" text,
	"bank_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "department" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"ageing_threshold_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "department_name_unique" UNIQUE("name"),
	CONSTRAINT "department_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"mfa_enrolled" boolean DEFAULT false NOT NULL,
	"last_seen" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"dept_scope" "dept_scope" NOT NULL,
	"department_ids" uuid[],
	"company_scope" "company_scope" DEFAULT 'n/a' NOT NULL,
	"company_ids" uuid[],
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "role_grant_dept_scope_list_check" CHECK ("role_grant"."dept_scope" <> 'list' or ("role_grant"."department_ids" is not null and cardinality("role_grant"."department_ids") > 0)),
	CONSTRAINT "role_grant_company_scope_list_check" CHECK ("role_grant"."company_scope" <> 'list' or ("role_grant"."company_ids" is not null and cardinality("role_grant"."company_ids") > 0))
);
--> statement-breakpoint
CREATE TABLE "request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"department_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"stage" "request_stage" DEFAULT 'raised' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"invoice_no" text,
	"invoice_date" date,
	"vendor" text,
	"note" text,
	"close_reason" text,
	"hold_review_on" date,
	"linked_request" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_ref_unique" UNIQUE("ref"),
	CONSTRAINT "request_amount_minor_positive_check" CHECK ("request"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "request_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"page_no" integer DEFAULT 1 NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"phash" text,
	"uploaded_by" uuid NOT NULL,
	"thumbnail_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_file_sha256_length_check" CHECK (char_length("request_file"."sha256") = 64)
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"actor" uuid NOT NULL,
	"role_at_time" text NOT NULL,
	"type" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "event_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grant" ADD CONSTRAINT "role_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_raised_by_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request" ADD CONSTRAINT "request_linked_request_request_id_fk" FOREIGN KEY ("linked_request") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file" ADD CONSTRAINT "request_file_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_file" ADD CONSTRAINT "request_file_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_actor_user_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_lower_idx" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "role_grant_active_user_idx" ON "role_grant" USING btree ("user_id") WHERE "role_grant"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "role_grant_department_ids_gin_idx" ON "role_grant" USING gin ("department_ids");--> statement-breakpoint
CREATE INDEX "role_grant_company_ids_gin_idx" ON "role_grant" USING gin ("company_ids");--> statement-breakpoint
CREATE INDEX "request_department_stage_idx" ON "request" USING btree ("department_id","stage");--> statement-breakpoint
CREATE INDEX "request_raised_by_idx" ON "request" USING btree ("raised_by");--> statement-breakpoint
CREATE INDEX "request_linked_request_idx" ON "request" USING btree ("linked_request");--> statement-breakpoint
CREATE INDEX "request_file_request_id_idx" ON "request_file" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_file_sha256_idx" ON "request_file" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "event_request_id_idx" ON "event" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "event_at_idx" ON "event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "event_actor_idx" ON "event" USING btree ("actor");