-- A query can now be directed at specific people as well as at roles.
--
-- Until now directed_at (a role[]) was the only target, so a requester
-- asking "the Requester" pinged every requester in the department, not the
-- person who raised the bill. directed_user_ids names individuals. A
-- postgres array can't carry a foreign key, so each id is validated in
-- src/conversation/queriesCore.ts against app_users_with_scope (an active
-- grant with scope over the request) at raise time; the array is a
-- snapshot of who was asked, and RLS below is what decides who may answer.
--
-- The check keeps a query from being directed at nobody: role targets, user
-- targets, or both, but at least one. Every existing row has a non-empty
-- directed_at, so the constraint validates against the backfill.
ALTER TABLE "query" ADD COLUMN "directed_user_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "query" ADD CONSTRAINT "query_directed_check" CHECK (cardinality("query"."directed_at") > 0 or cardinality("query"."directed_user_ids") > 0);--> statement-breakpoint

-- query_update: an actor may answer if their current role is in directed_at
-- OR their own id is in directed_user_ids. Everything else is 0011's policy
-- unchanged: still only while open, still department-scoped for the role
-- the actor is acting as (so a named person who has lost their grant, or
-- whose grant doesn't cover this department, cannot answer), and the
-- WITH CHECK still demands the answer be attributed to the actor and
-- actually resolve the row.
DROP POLICY query_update ON "query";--> statement-breakpoint
CREATE POLICY query_update ON "query" FOR UPDATE
  USING (
    resolved_at IS NULL
    AND (
      app_actor_role() = ANY (directed_at::text[])
      OR app_actor_id() = ANY (directed_user_ids)
    )
    AND EXISTS (
      SELECT 1 FROM request r
      WHERE r.id = query.request_id AND app_has_department_scope(r.department_id)
    )
  )
  WITH CHECK (
    answered_by = app_actor_id()
    AND answered_as_role = app_actor_role()
    AND resolved_at IS NOT NULL
  );
