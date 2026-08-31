-- RLS and app_runtime grants for phase 4 (the four desks).
--
-- Stage-transition legality (can this actor move this request from stage
-- X to stage Y right now) is NOT enforced here — that's deliberately
-- src/requests/transitions.ts's job, per the brief's own infra note ("one
-- server-side module with the permission check inside it"). RLS below
-- governs which rows are visible/writable by role and department/company
-- scope, exactly as it already did before this migration — see
-- request_update's unchanged USING clause below.

-- ---------------------------------------------------------------------
-- 1. head_of_account — readable by anyone holding any active grant (same
--    shape as user_select: a small reference list, not sensitive), admin
--    write only.
-- ---------------------------------------------------------------------
ALTER TABLE head_of_account ENABLE ROW LEVEL SECURITY;

CREATE POLICY head_of_account_select ON head_of_account FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM role_grant rg
    WHERE rg.user_id = app_actor_id() AND rg.role::text = app_actor_role() AND rg.revoked_at IS NULL
  )
);
CREATE POLICY head_of_account_insert ON head_of_account FOR INSERT WITH CHECK (
  app_actor_role() = 'super_admin'
);
CREATE POLICY head_of_account_update ON head_of_account FOR UPDATE
  USING (app_actor_role() = 'super_admin')
  WITH CHECK (app_actor_role() = 'super_admin');

GRANT SELECT, INSERT, UPDATE ON head_of_account TO app_runtime;

-- ---------------------------------------------------------------------
-- 2. accounting — department-scope-only at SELECT (matches
--    request_file_select's live-join shape). NOT company-scoped at read
--    time: AGENTS.md is explicit that company scope "cannot filter" for
--    the accountant, it only "constrains the dropdown" — company scope is
--    enforced at INSERT instead. No UPDATE/DELETE grant: immutable,
--    corrections are new rows (see accounting.ts's header comment).
-- ---------------------------------------------------------------------
ALTER TABLE accounting ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_select ON accounting FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = accounting.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY accounting_insert ON accounting FOR INSERT WITH CHECK (
  accounted_by = app_actor_id()
  AND app_actor_role() = 'accountant'
  AND app_has_company_scope(company_id)
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = accounting.request_id AND app_has_department_scope(r.department_id)
  )
);

GRANT SELECT, INSERT ON accounting TO app_runtime;

-- ---------------------------------------------------------------------
-- 3. payment — department-scope-only at SELECT. INSERT additionally
--    requires the joined request's cached company_id to be within the
--    payer's company scope — the concrete mechanism behind "for the
--    payer, company scope filters what they can act on." No UPDATE/
--    DELETE: "a payment is immutable once recorded" (AGENTS.md).
-- ---------------------------------------------------------------------
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_select ON payment FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = payment.request_id AND app_has_department_scope(r.department_id)
  )
);
CREATE POLICY payment_insert ON payment FOR INSERT WITH CHECK (
  paid_by = app_actor_id()
  AND app_actor_role() = 'payer'
  AND EXISTS (
    SELECT 1 FROM request r
    WHERE r.id = payment.request_id
      AND app_has_department_scope(r.department_id)
      AND (r.company_id IS NULL OR app_has_company_scope(r.company_id))
  )
);

GRANT SELECT, INSERT ON payment TO app_runtime;

-- ---------------------------------------------------------------------
-- 4. request_select: add a payer-specific branch using the new cached
--    company_id, so the queue itself is company-filtered at the data
--    layer (rule 8: hiding a row in React is not access control), not
--    just at payment_insert time.
-- ---------------------------------------------------------------------
DROP POLICY request_select ON request;
CREATE POLICY request_select ON request FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR (
    app_actor_role() IN ('requester', 'approver', 'accountant')
    AND app_has_department_scope(department_id)
  )
  OR (
    app_actor_role() = 'payer'
    AND app_has_department_scope(department_id)
    AND (company_id IS NULL OR app_has_company_scope(company_id))
  )
);

-- ---------------------------------------------------------------------
-- 5. request_update: add a company-scope check to WITH CHECK (cheap
--    defense-in-depth now that request rows carry a company_id that can
--    be written). The USING clause is UNCHANGED on purpose — phase 1
--    already lets approver/accountant/payer UPDATE any department-scoped
--    request regardless of current stage, by design ("RLS governs which
--    rows are visible, not which stage transitions are legal — that's the
--    phase-4 server action layer's job"). Every transition in
--    src/requests/transitions.ts is already permitted by the unchanged
--    USING clause; that module is the actual gate.
-- ---------------------------------------------------------------------
DROP POLICY request_update ON request;
CREATE POLICY request_update ON request FOR UPDATE
  USING (
    app_actor_role() IN ('super_admin', 'developer')
    OR (app_actor_role() IN ('approver', 'accountant', 'payer') AND app_has_department_scope(department_id))
    OR (app_actor_role() = 'requester' AND app_has_department_scope(department_id) AND stage = 'raised')
  )
  WITH CHECK (
    app_has_department_scope(department_id)
    AND (company_id IS NULL OR app_has_company_scope(company_id))
  );

-- event_select/event_insert need no changes: already generic over
-- object_type/role, and department-scope-only visibility is exactly
-- "visible to anyone in scope, not admin-only" (the brief's own words for
-- the trail).

-- ---------------------------------------------------------------------
-- 6. Event hash chain, second-link concurrency guard. Every phase-4
-- transition takes SELECT ... FOR UPDATE on the request row first (see
-- src/requests/transitions.ts), which serializes "read latest event hash
-- -> write" for a given request and is the actual race-prevention
-- mechanism. This index is defense-in-depth on top of that lock: it makes
-- every event with a non-null prev_hash provably unforkable at the
-- database level, independent of whether the lock was taken correctly.
-- It does NOT protect a request's first event (prev_hash IS NULL is not
-- unique under SQL's NULL semantics) — that event is written once, inside
-- captureCore's own atomic insert transaction, never re-entered per
-- request, so it isn't the risk this guards against.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX event_request_prev_hash_unique_idx
  ON event (request_id, prev_hash)
  WHERE request_id IS NOT NULL;
