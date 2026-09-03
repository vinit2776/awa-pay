CREATE TABLE "nudge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"from_user" uuid NOT NULL,
	"from_role" text NOT NULL,
	"to_role" "role" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nudge" ADD CONSTRAINT "nudge_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudge" ADD CONSTRAINT "nudge_from_user_user_id_fk" FOREIGN KEY ("from_user") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nudge_request_id_idx" ON "nudge" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nudge_one_per_person_per_request_per_day_idx" ON "nudge" USING btree ("from_user","request_id",(("at" AT TIME ZONE 'Asia/Kolkata')::date));