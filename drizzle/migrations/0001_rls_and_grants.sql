-- Row-level security and app_runtime privileges.
--
-- app_runtime was provisioned (phase 0) with nothing beyond CONNECT on the
-- database and USAGE on schema public — it cannot even SELECT until this
-- migration grants it explicitly. That makes every GRANT below just as
-- security-critical as the policies themselves, which is why both live in
-- one hand-authored file rather than split between generated policy code
-- and a separate grants file. See AGENTS.md rule 1 and rule 8, and
-- docs/START-HERE.md phase 1.

-- ---------------------------------------------------------------------
-- 1. Enable RLS on every table app_runtime will ever query.
-- ---------------------------------------------------------------------
ALTER TABLE "company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "department" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "request_file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2. Helper functions.
--
-- current_setting(name, true) returns NULL instead of erroring when the
-- GUC was never set for this transaction. A policy predicate compared
-- against NULL is falsy, so an unscoped query (withGrantScope never
-- called, or its SET LOCAL skipped) fails closed by construction — this
-- is exactly what the gate test's first assertion proves.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_actor_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_role', true), '')
$$;

-- Resolves department scope live from role_grant on every call — the app
-- never pre-computes or hands over a department list, only identity +
-- intended role (see src/db/runtime.ts withGrantScope). A bug in app code
-- can misidentify who's asking; it cannot fabricate scope role_grant
-- doesn't actually contain.
CREATE OR REPLACE FUNCTION app_has_department_scope(dept_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant rg
    WHERE rg.user_id = app_actor_id()
      AND rg.role::text = app_actor_role()
      AND rg.revoked_at IS NULL
      AND (rg.dept_scope = 'global' OR dept_id = ANY(rg.department_ids))
  )
$$;

CREATE OR REPLACE FUNCTION app_has_company_scope(comp_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM role_grant rg
    WHERE rg.user_id = app_actor_id()
      AND rg.role::text = app_actor_role()
      AND rg.revoked_at IS NULL
      AND (rg.company_scope = 'global' OR comp_id = ANY(rg.company_ids))
  )
$$;

-- ---------------------------------------------------------------------
-- 3. Policies.
-- ---------------------------------------------------------------------

-- role_grant: role-based, not department/company scoped — it's the
-- *source* of scope, not scoped by it.
CREATE POLICY role_grant_select ON role_grant FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer') OR user_id = app_actor_id()
);
CREATE POLICY role_grant_insert ON role_grant FOR INSERT WITH CHECK (
  app_actor_role() = 'super_admin'
);
CREATE POLICY role_grant_update ON role_grant FOR UPDATE
  USING (app_actor_role() = 'super_admin')
  WITH CHECK (app_actor_role() = 'super_admin');

-- company: super_admin/developer see everything; accountant/payer see
-- only companies within their own company scope; requester/approver see
-- none (matches AGENTS.md roles table — company scope is "n/a" for them).
CREATE POLICY company_select ON company FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR (app_actor_role() IN ('accountant', 'payer') AND app_has_company_scope(id))
);
CREATE POLICY company_insert ON company FOR INSERT WITH CHECK (
  app_actor_role() = 'super_admin'
);
CREATE POLICY company_update ON company FOR UPDATE
  USING (app_actor_role() = 'super_admin')
  WITH CHECK (app_actor_role() = 'super_admin');

-- department: visible to any role within its own department scope.
CREATE POLICY department_select ON department FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer') OR app_has_department_scope(id)
);
CREATE POLICY department_insert ON department FOR INSERT WITH CHECK (
  app_actor_role() = 'super_admin'
);
CREATE POLICY department_update ON department FOR UPDATE
  USING (app_actor_role() = 'super_admin')
  WITH CHECK (app_actor_role() = 'super_admin');

-- user: deliberately NOT department/company scoped. This is a ~30-person
-- org directory, not multi-tenant data — the sensitive boundary is on
-- request/role_grant/company, not on who's in the org. (A scoped policy
-- here would also break an approver's queue needing to display a
-- requester's name for a request it can already see.) Any actor holding
-- any active grant can read the directory; writes are admin-only, since
-- provisioning is admin-only (phase 2).
CREATE POLICY user_select ON "user" FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM role_grant rg
    WHERE rg.user_id = app_actor_id() AND rg.role::text = app_actor_role() AND rg.revoked_at IS NULL
  )
);
CREATE POLICY user_insert ON "user" FOR INSERT WITH CHECK (
  app_actor_role() = 'super_admin'
);
CREATE POLICY user_update ON "user" FOR UPDATE
  USING (app_actor_role() = 'super_admin')
  WITH CHECK (app_actor_role() = 'super_admin');

-- request: department-scoped uniformly for every departmental role; global
-- for super_admin/developer. No company scoping here in phase 1 — company
-- assignment lives on the not-yet-built accounting table (a later slice).
-- No delete policy: app_runtime has no DELETE grant on this table either
-- (enforced twice, deliberately). RLS governs *which rows* are visible,
-- not *which stage transitions* are legal — that's the phase-4 server
-- action layer's job.
CREATE POLICY request_select ON request FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR (
    app_actor_role() IN ('requester', 'approver', 'accountant', 'payer')
    AND app_has_department_scope(department_id)
  )
);
CREATE POLICY request_insert ON request FOR INSERT WITH CHECK (
  app_actor_role() = 'requester'
  AND raised_by = app_actor_id()
  AND app_has_department_scope(department_id)
);
CREATE POLICY request_update ON request FOR UPDATE
  USING (
    app_actor_role() IN ('super_admin', 'developer')
    OR (app_actor_role() IN ('approver', 'accountant', 'payer') AND app_has_department_scope(department_id))
    OR (app_actor_role() = 'requester' AND app_has_department_scope(department_id) AND stage = 'raised')
  )
  WITH CHECK (app_has_department_scope(department_id));

-- request_file: scope resolved via a live join to request on every check,
-- not denormalized onto the file row — a cached department id here could
-- drift if a request were ever re-departmented. No blanket UPDATE grant;
-- files are immutable evidence once uploaded (see the column-level grant
-- below for the one deliberate exception).
CREATE POLICY request_file_select ON request_file FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = request_file.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY request_file_insert ON request_file FOR INSERT WITH CHECK (
  uploaded_by = app_actor_id()
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = request_file.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY request_file_update ON request_file FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM request r
      WHERE r.id = request_file.request_id AND app_has_department_scope(r.department_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM request r
      WHERE r.id = request_file.request_id AND app_has_department_scope(r.department_id)
    )
  );

-- event: same join-based visibility as request_file. System-level rows
-- (request_id IS NULL) are visible only to super_admin/developer. No
-- update/delete policy is needed — app_runtime has no UPDATE/DELETE grant
-- on this table at all (see the REVOKE below), so RLS enforcement here is
-- belt-and-suspenders on top of the grant, not the only defense.
CREATE POLICY event_select ON event FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR (
    request_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM request r
      WHERE r.id = event.request_id AND app_has_department_scope(r.department_id)
    )
  )
);
CREATE POLICY event_insert ON event FOR INSERT WITH CHECK (
  actor = app_actor_id()
  AND EXISTS (
    SELECT 1 FROM role_grant rg
    WHERE rg.user_id = app_actor_id() AND rg.role::text = app_actor_role() AND rg.revoked_at IS NULL
  )
);

-- ---------------------------------------------------------------------
-- 4. Grants to app_runtime.
--
-- No DELETE is ever granted on any table in this migration — the app has
-- no delete path anywhere in this system (soft state changes only, per
-- AGENTS.md's retention duty). Nothing here is a placeholder for a DELETE
-- to be added later.
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION app_actor_id() TO app_runtime;
GRANT EXECUTE ON FUNCTION app_actor_role() TO app_runtime;
GRANT EXECUTE ON FUNCTION app_has_department_scope(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION app_has_company_scope(uuid) TO app_runtime;

GRANT SELECT, INSERT, UPDATE ON company TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON department TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON "user" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON role_grant TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON request TO app_runtime;

-- request_file: immutable evidence. SELECT/INSERT only, plus a
-- column-level UPDATE limited to the two fields a future async job
-- (thumbnailing, phase 3+) fills in after upload — amount/sha256/
-- storage_key stay untouchable even with this grant, because column
-- privileges restrict UPDATE to exactly the named columns.
GRANT SELECT, INSERT ON request_file TO app_runtime;
GRANT UPDATE (thumbnail_key, phash) ON request_file TO app_runtime;

-- event: append-only. Explicitly no UPDATE/DELETE — revoked here even
-- though nothing has granted them yet, so the intent is unambiguous
-- rather than implicit, in the same migration that creates the table's
-- privileges at all (AGENTS.md rule 3 / START-HERE.md phase 1).
GRANT SELECT, INSERT ON event TO app_runtime;
REVOKE UPDATE, DELETE ON event FROM app_runtime;
