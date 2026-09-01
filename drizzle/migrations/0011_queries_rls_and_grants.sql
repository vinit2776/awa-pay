-- RLS and app_runtime grants for phase 6 (queries, the freeze, and
-- Withdraw).
--
-- query_select mirrors comment_select's verified shape (0008): a plain
-- department-scope EXISTS join to `request` already inherits
-- request_select's own payer/company check transitively — no explicit
-- company branch needed here either.
--
-- query_insert allows any of requester/approver/accountant/payer/
-- super_admin (not developer) with department scope over the request to
-- raise a query, at any stage — raising is not gated on current stage,
-- matching "any desk can raise a query" (docs/concept-v2.html §01).
--
-- query_update is the interesting one: only an actor whose current role is
-- a member of the query's own directed_at array may answer it, and only
-- while it's still open (resolved_at IS NULL). WITH CHECK requires the
-- answer to be attributed to the actor answering and to actually resolve
-- the row — an UPDATE that tried to change directed_at, question, or
-- raised_by, or that left resolved_at null, is rejected. Two concurrent
-- answer attempts: whichever transaction's SELECT ... FOR UPDATE (taken in
-- src/conversation/queriesCore.ts's answerQuery, before this UPDATE runs)
-- commits first wins; the second sees resolved_at already set and its own
-- USING clause then excludes the row.

ALTER TABLE query ENABLE ROW LEVEL SECURITY;

CREATE POLICY query_select ON query FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = query.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY query_insert ON query FOR INSERT WITH CHECK (
  raised_by = app_actor_id()
  AND raised_as_role = app_actor_role()
  AND app_actor_role() IN ('requester', 'approver', 'accountant', 'payer', 'super_admin')
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = query.request_id
      AND app_has_department_scope(r.department_id)
      AND (app_actor_role() <> 'payer' OR r.company_id IS NULL OR app_has_company_scope(r.company_id))
  )
);
CREATE POLICY query_update ON query FOR UPDATE
  USING (
    resolved_at IS NULL
    AND app_actor_role() = ANY (directed_at::text[])
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

-- No DELETE grant, ever — a query is part of the request's permanent
-- record once raised, answered or not.
GRANT SELECT, INSERT, UPDATE ON query TO app_runtime;
