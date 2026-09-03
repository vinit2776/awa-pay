-- RLS and app_runtime grants for phase 7 (nudges).
--
-- Same shape as comment_select/query_select (0008, 0011): a plain
-- department-scope EXISTS join to `request` already inherits
-- request_select's own payer/company check transitively — no explicit
-- company branch needed on nudge_select either.
--
-- nudge_insert keeps an explicit payer/company check anyway, matching
-- comment_insert/query_insert's own precedent.
--
-- Append-only, same as event: no UPDATE/DELETE grant, ever. The rate
-- limit itself is enforced by nudge_one_per_person_per_request_per_day_idx
-- (0012), not by this policy — RLS governs who can insert, the unique
-- index governs how often.

ALTER TABLE nudge ENABLE ROW LEVEL SECURITY;

CREATE POLICY nudge_select ON nudge FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = nudge.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY nudge_insert ON nudge FOR INSERT WITH CHECK (
  from_user = app_actor_id()
  AND from_role = app_actor_role()
  AND app_actor_role() IN ('requester', 'approver', 'accountant', 'payer', 'super_admin')
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = nudge.request_id
      AND app_has_department_scope(r.department_id)
      AND (app_actor_role() <> 'payer' OR r.company_id IS NULL OR app_has_company_scope(r.company_id))
  )
);

GRANT SELECT, INSERT ON nudge TO app_runtime;
