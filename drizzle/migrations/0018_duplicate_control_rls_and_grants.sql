-- RLS for phase 11 (duplicate control).
--
-- duplicate_check: full visibility only when the actor has department
-- scope over BOTH sides of the match — the request they can already see
-- AND the one it matched against. This is deliberately narrower than
-- request_select's own department-only check: a duplicate_check row
-- exposes that a match exists in another department at all, so visibility
-- of the row itself follows the stricter of the two requests, not the
-- looser one. The redacted, cross-department "a match exists, somewhere"
-- signal is a SEPARATE thing entirely — app_duplicate_check_candidates
-- below, not this table.
ALTER TABLE duplicate_check ENABLE ROW LEVEL SECURITY;

CREATE POLICY duplicate_check_select ON duplicate_check FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR (
    EXISTS (SELECT 1 FROM request r WHERE r.id = duplicate_check.request_id AND app_has_department_scope(r.department_id))
    AND EXISTS (SELECT 1 FROM request r2 WHERE r2.id = duplicate_check.matched_request_id AND app_has_department_scope(r2.department_id))
  )
);
-- Insert only requires scope over the NEW request (duplicate_check.request_id)
-- — the matched request may legitimately be out of the inserting actor's
-- own scope, since finding that out is the entire point of the check.
-- overridden_by, when set, must be the actor's own id — found the hard
-- way (a live override attempt) that this CANNOT also require
-- app_actor_role() = 'super_admin': an override is written inside the
-- SAME transaction as the request/accounting insert it belongs to, which
-- is always scoped as requester or accountant (whichever role is doing
-- the capturing/accounting), never as super_admin, even when that same
-- actor also holds a super_admin grant — role_grant's own "three roles,
-- three rows" model means only ONE role is ever the scoped role of a
-- given transaction. The actual super-admin authorization check already
-- happened at the application layer (actorHoldsRole, in captureCore.ts/
-- transitions.ts) before this insert is ever attempted; this policy's own
-- job is narrower — just preventing an override from being attributed to
-- someone other than the actor who's actually inserting the row.
CREATE POLICY duplicate_check_insert ON duplicate_check FOR INSERT WITH CHECK (
  app_actor_role() IN ('requester', 'accountant', 'super_admin')
  AND EXISTS (SELECT 1 FROM request r WHERE r.id = duplicate_check.request_id AND app_has_department_scope(r.department_id))
  AND (overridden_by IS NULL OR overridden_by = app_actor_id())
);

-- No UPDATE/DELETE grant, ever — an immutable audit row, same discipline
-- as event.
GRANT SELECT, INSERT ON duplicate_check TO app_runtime;

-- ---------------------------------------------------------------------
-- app_duplicate_check_candidates — the redacted, cross-department search.
-- Same family as app_has_department_scope/app_has_company_scope (0001)
-- and app_users_with_scope (0008): SECURITY DEFINER, exempt from RLS by
-- the same table-ownership mechanism AGENTS.md rule 1 documents, used
-- narrowly here to search every department regardless of the caller's own
-- scope. viewable_by_actor is computed INSIDE the function, from the
-- CALLING session's own GUCs (app_has_department_scope reads
-- app.actor_id/app.actor_role, which are session-level and unaffected by
-- SECURITY DEFINER) — the redaction boundary lives entirely in this one
-- function, never as a broadened table-level policy. Two matching modes,
-- both optional and independently triggerable: the decisive
-- vendor+invoice+FY match (only meaningful once accounting has matched a
-- vendor) and the advisory file-checksum match (available from capture,
-- before any vendor is matched). SET search_path = public closes the
-- standard search-path-hijack vector for SECURITY DEFINER functions.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_duplicate_check_candidates(
  p_exclude_request_id uuid,
  p_vendor_key text,
  p_invoice_key text,
  p_fy text,
  p_checksum text
) RETURNS TABLE(
  request_id uuid,
  department_id uuid,
  stage text,
  invoice_date date,
  reference text,
  match_kind text,
  viewable_by_actor boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    r.department_id,
    r.stage::text,
    r.invoice_date,
    p.reference,
    CASE
      WHEN p_vendor_key IS NOT NULL AND p_invoice_key IS NOT NULL AND p_fy IS NOT NULL
        AND r.vendor_key = p_vendor_key AND r.invoice_key = p_invoice_key AND r.fy = p_fy
      THEN 'vendor_invoice_fy'
      ELSE 'file_checksum'
    END,
    app_has_department_scope(r.department_id)
  FROM request r
  LEFT JOIN payment p ON p.request_id = r.id
  WHERE (p_exclude_request_id IS NULL OR r.id <> p_exclude_request_id)
    AND r.stage <> 'withdrawn'
    AND (
      (p_vendor_key IS NOT NULL AND p_invoice_key IS NOT NULL AND p_fy IS NOT NULL
        AND r.vendor_key = p_vendor_key AND r.invoice_key = p_invoice_key AND r.fy = p_fy)
      OR (p_checksum IS NOT NULL AND EXISTS (
        SELECT 1 FROM request_file rf WHERE rf.request_id = r.id AND rf.sha256 = p_checksum
      ))
    )
$$;

GRANT EXECUTE ON FUNCTION app_duplicate_check_candidates(uuid, text, text, text, text) TO app_runtime;
