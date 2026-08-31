-- RLS and app_runtime grants for phase 5 (comments & the conversation panel).
--
-- comment_select is deliberately shaped like accounting_select/
-- payment_select (0006), NOT like request_select's own payer-specific
-- company branch — verified empirically before writing this migration
-- (via psql, as the app_runtime role, with a company-excluded payer
-- session): a plain department-scope EXISTS join to `request` already
-- inherits request_select's own company check for free, because Postgres
-- RLS applies to `request` transitively inside this policy's own subquery,
-- for whichever role is running the outer query. Duplicating the company
-- check in comment_select's own text would be redundant, not safer.
--
-- comment_insert keeps an explicit payer company check anyway, matching
-- payment_insert/accounting_insert's own precedent — belt-and-suspenders
-- at write time, not required for correctness (same transitive argument
-- applies) but consistent with how this codebase already writes INSERT
-- policies.

ALTER TABLE comment ENABLE ROW LEVEL SECURITY;

CREATE POLICY comment_select ON comment FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = comment.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY comment_insert ON comment FOR INSERT WITH CHECK (
  author = app_actor_id()
  AND role_at_time = app_actor_role()
  AND app_actor_role() IN ('requester', 'approver', 'accountant', 'payer', 'super_admin')
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = comment.request_id
      AND app_has_department_scope(r.department_id)
      AND (app_actor_role() <> 'payer' OR r.company_id IS NULL OR app_has_company_scope(r.company_id))
  )
);

-- No UPDATE/DELETE grant: comment.edited_at is reserved but unwritten this
-- phase (see comment.ts's header comment) — editing is a real design
-- question deferred with a stated reason, not rushed in.
GRANT SELECT, INSERT ON comment TO app_runtime;

-- request_file already has generic, kind-agnostic RLS (its policies join
-- to `request` the same way regardless of `kind`), so a 'comment_attachment'
-- row is governed by the exact same request_file_select/insert policies a
-- 'bill' or 'payment_advice' row already is — no change needed here.

-- ---------------------------------------------------------------------
-- app_users_with_scope — reverse lookup: "which users hold role X with
-- scope over department Y (and company Z)". Needed starting this phase
-- for @mention candidate resolution (who is even mentionable on this
-- request), and reused unchanged by phase 8's email recipient
-- resolution — one function serving both, not duplicated.
--
-- Impossible under ordinary RLS: role_grant_select only permits an actor
-- to see their OWN grant rows (user_id = app_actor_id()), by design —
-- nobody's grant list is otherwise anyone else's business. This function
-- is SECURITY DEFINER, running as the migrations-role owner and exempt
-- from RLS by the same mechanism AGENTS.md rule 1 documents for table
-- ownership — used narrowly here: it returns only user_id values, and
-- "who holds which role over which department" is no more sensitive at
-- this org's scale than the already-open user_select policy. SET
-- search_path = public closes the standard search-path-hijack vector for
-- SECURITY DEFINER functions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_users_with_scope(p_roles text[], p_department_id uuid, p_company_id uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT rg.user_id
  FROM role_grant rg
  WHERE rg.role::text = ANY(p_roles)
    AND rg.revoked_at IS NULL
    AND (rg.dept_scope = 'global' OR p_department_id = ANY(rg.department_ids))
    AND (
      p_company_id IS NULL
      OR rg.company_scope IN ('global', 'n/a')
      OR p_company_id = ANY(rg.company_ids)
    )
$$;

GRANT EXECUTE ON FUNCTION app_users_with_scope(text[], uuid, uuid) TO app_runtime;
