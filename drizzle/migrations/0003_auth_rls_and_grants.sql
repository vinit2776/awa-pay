-- RLS and app_runtime grants for phase 2 (auth).
--
-- Login has to establish identity from nothing before either app.actor_id
-- or app.actor_role exists — see src/db/runtime.ts's withActorScope and
-- docs/START-HERE.md phase 2. Three pre-identity reads need policy support
-- that phase 1's role_grant-centric policies didn't anticipate: looking a
-- user up by email, verifying a session token, and writing the pre-role
-- auth audit trail. Each is resolved the same way phase 1 already resolves
-- department/company scope: one presented value, one narrow GUC, one
-- policy branch — never a broadened trust surface.

-- ---------------------------------------------------------------------
-- 1. Replace user_select / user_update / event_insert to add the
--    pre-identity and self-access branches. Existing branches are kept
--    unchanged; only new OR branches are added.
-- ---------------------------------------------------------------------
DROP POLICY user_select ON "user";
CREATE POLICY user_select ON "user" FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM role_grant rg
    WHERE rg.user_id = app_actor_id() AND rg.role::text = app_actor_role() AND rg.revoked_at IS NULL
  )
  OR id = app_actor_id()
  OR lower(email) = nullif(current_setting('app.presented_login_email', true), '')
);

DROP POLICY user_update ON "user";
CREATE POLICY user_update ON "user" FOR UPDATE
  USING (app_actor_role() = 'super_admin' OR id = app_actor_id())
  WITH CHECK (app_actor_role() = 'super_admin' OR id = app_actor_id());
-- Named residual risk: this branch is row-scoped, not column-scoped, and
-- the blanket GRANT UPDATE ON "user" from phase 1 still applies — so a
-- self-authenticated transaction can technically write any column on its
-- own row, not just auth columns. The real boundary is code discipline in
-- src/auth/**: every self-update names exact columns explicitly. If this
-- needs to be airtight later, split credential/lockout columns into their
-- own table with a narrower grant.

DROP POLICY event_insert ON event;
CREATE POLICY event_insert ON event FOR INSERT WITH CHECK (
  actor = app_actor_id()
  AND (
    (object_type = 'auth' AND request_id IS NULL AND app_actor_role() IS NULL)
    OR EXISTS (
      SELECT 1 FROM role_grant rg
      WHERE rg.user_id = app_actor_id() AND rg.role::text = app_actor_role() AND rg.revoked_at IS NULL
    )
  )
);

-- ---------------------------------------------------------------------
-- 2. session
-- ---------------------------------------------------------------------
ALTER TABLE session ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_select ON session FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR user_id = app_actor_id()
  OR token_hash = nullif(current_setting('app.presented_token_hash', true), '')
);
CREATE POLICY session_insert ON session FOR INSERT WITH CHECK (
  user_id = app_actor_id() OR app_actor_role() = 'super_admin'
);
CREATE POLICY session_update ON session FOR UPDATE
  USING (user_id = app_actor_id() OR app_actor_role() = 'super_admin')
  WITH CHECK (user_id = app_actor_id() OR app_actor_role() = 'super_admin');
-- The super_admin branch on session_update is the literal mechanism behind
-- "a session must be revocable the instant a payer account is compromised
-- or offboarded" (START-HERE.md phase 2) — without it, revocation would
-- only be possible by the compromised account itself.

GRANT SELECT, INSERT, UPDATE ON session TO app_runtime;

-- ---------------------------------------------------------------------
-- 3. mfa_backup_code — no cross-user access at all, ever.
-- ---------------------------------------------------------------------
ALTER TABLE mfa_backup_code ENABLE ROW LEVEL SECURITY;

CREATE POLICY mfa_backup_code_select ON mfa_backup_code FOR SELECT USING (
  user_id = app_actor_id() OR app_actor_role() IN ('super_admin', 'developer')
);
CREATE POLICY mfa_backup_code_insert ON mfa_backup_code FOR INSERT WITH CHECK (
  user_id = app_actor_id()
);
CREATE POLICY mfa_backup_code_update ON mfa_backup_code FOR UPDATE
  USING (user_id = app_actor_id())
  WITH CHECK (user_id = app_actor_id());

GRANT SELECT, INSERT, UPDATE ON mfa_backup_code TO app_runtime;

-- ---------------------------------------------------------------------
-- 4. login_attempt — insert is open, same single-trusted-app-role model
--    every other table already relies on (app_runtime is the only
--    credential that can reach Postgres at all). Select is scoped by a
--    presented-value GUC for the rate-limit check itself, plus global
--    read for admins reviewing attempts.
-- ---------------------------------------------------------------------
ALTER TABLE login_attempt ENABLE ROW LEVEL SECURITY;

CREATE POLICY login_attempt_select ON login_attempt FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR lower(email) = nullif(current_setting('app.presented_login_email', true), '')
  OR ip = nullif(current_setting('app.presented_client_ip', true), '')
);
CREATE POLICY login_attempt_insert ON login_attempt FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON login_attempt TO app_runtime;
-- No UPDATE/DELETE: login_attempt is an append-only trail, same reasoning
-- as event. No policy is needed for privileges app_runtime doesn't have.
