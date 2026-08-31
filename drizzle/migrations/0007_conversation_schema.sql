ALTER TYPE "public"."request_file_kind" ADD VALUE 'comment_attachment';--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author" uuid NOT NULL,
	"role_at_time" text NOT NULL,
	"body" text NOT NULL,
	"mentions" uuid[] DEFAULT '{}' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "request_file" ADD COLUMN "comment_id" uuid;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_request_id_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_user_id_fk" FOREIGN KEY ("author") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_request_id_idx" ON "comment" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "comment_mentions_gin_idx" ON "comment" USING gin ("mentions");--> statement-breakpoint
ALTER TABLE "request_file" ADD CONSTRAINT "request_file_comment_id_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comment"("id") ON DELETE no action ON UPDATE no action;