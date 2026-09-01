CREATE TABLE "query" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"raised_by" uuid NOT NULL,
	"raised_as_role" text NOT NULL,
	"directed_at" "role"[] NOT NULL,
	"question" text NOT NULL,
	"answered_by" uuid,
	"answered_as_role" text,
	"answer" text,
	"resolved_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "query_answer_fields_together_check" CHECK (("query"."answered_by" is null and "query"."answered_as_role" is null and "query"."answer" is null and "query"."resolved_at" is null)
        or ("query"."answered_by" is not null and "query"."answered_as_role" is not null and "query"."answer" is not null and "query"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "query" ADD CONSTRAINT "query_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query" ADD CONSTRAINT "query_raised_by_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query" ADD CONSTRAINT "query_answered_by_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "query_request_id_idx" ON "query" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "query_open_idx" ON "query" USING btree ("request_id") WHERE "query"."resolved_at" is null;