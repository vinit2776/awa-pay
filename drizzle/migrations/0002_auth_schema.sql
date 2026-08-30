CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending_mfa' NOT NULL,
	"mfa_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "session_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "session_status_check" CHECK ("session"."status" in ('pending_mfa', 'active'))
);
--> statement-breakpoint
CREATE TABLE "mfa_backup_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text,
	"succeeded" boolean NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempt_failure_reason_check" CHECK ("login_attempt"."failure_reason" is null or "login_attempt"."failure_reason" in ('no_such_user', 'disabled', 'locked', 'bad_password', 'bad_mfa', 'bad_backup_code'))
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "password_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_backup_code" ADD CONSTRAINT "mfa_backup_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mfa_backup_code_unused_user_idx" ON "mfa_backup_code" USING btree ("user_id") WHERE "mfa_backup_code"."used_at" is null;--> statement-breakpoint
CREATE INDEX "login_attempt_email_created_idx" ON "login_attempt" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "login_attempt_ip_created_idx" ON "login_attempt" USING btree ("ip","created_at");