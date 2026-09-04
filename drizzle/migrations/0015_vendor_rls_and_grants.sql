-- RLS and app_runtime grants for phase 9 (vendor master & accounts-desk
-- matching).
--
-- vendor/vendor_bank/vendor_document are deliberately role-scoped, not
-- department- or company-scoped: a vendor is shared organization-wide
-- reference data, matched or created once and reused across every
-- department and company that bills through it (docs/START-HERE-slice-3.md's
-- "Design decisions" section) — the same shape head_of_account already
-- established (0006), narrowed here to the specific roles the brief's own
-- capability table names for vendor data (§11), rather than
-- head_of_account's "anyone holding any active grant."

ALTER TABLE vendor ENABLE ROW LEVEL SECURITY;

CREATE POLICY vendor_select ON vendor FOR SELECT USING (
  app_actor_role() IN ('accountant', 'payer', 'super_admin', 'developer')
);
CREATE POLICY vendor_insert ON vendor FOR INSERT WITH CHECK (
  created_by = app_actor_id()
  AND app_actor_role() IN ('accountant', 'super_admin')
);
CREATE POLICY vendor_update ON vendor FOR UPDATE
  USING (app_actor_role() IN ('accountant', 'super_admin'))
  WITH CHECK (app_actor_role() IN ('accountant', 'super_admin'));

GRANT SELECT, INSERT, UPDATE ON vendor TO app_runtime;

-- vendor_bank: SELECT alongside vendor (the payer needs to read it to
-- verify — phase 10). INSERT is accountant-only this phase; the payer's
-- own narrow, self-verified correction path is a SEPARATE INSERT policy
-- added in migration 0016 (phase 10), not here — keeping "who's allowed to
-- add a bank record and under what condition" out of one shared policy
-- makes each path independently auditable in the migration history.
--
-- vendor_bank_update_supersede is the one UPDATE this phase actually
-- needs: setVendorBank's supersede-then-insert sequence (src/vendors/
-- vendorsCore.ts, under lockVendorMutex) flips the PRIOR current row's
-- superseded_at from null to non-null before inserting the new one — a
-- real UPDATE, not covered by "SELECT, INSERT" alone (found the hard way:
-- an accountant's first bank-details save on a vendor with no existing
-- row works, since there's nothing to supersede; the very next save on
-- the same vendor hits `permission denied for table vendor_bank`).
-- Narrowly one-directional like query_update's answered-state policy —
-- USING only matches a still-current row, WITH CHECK only allows landing
-- on non-null, so this can never re-open an already-superseded row or
-- touch verified_by/verified_at (phase 10's own, separately-scoped UPDATE
-- policy covers those).
ALTER TABLE vendor_bank ENABLE ROW LEVEL SECURITY;

CREATE POLICY vendor_bank_select ON vendor_bank FOR SELECT USING (
  app_actor_role() IN ('accountant', 'payer', 'super_admin', 'developer')
);
CREATE POLICY vendor_bank_insert ON vendor_bank FOR INSERT WITH CHECK (
  entered_by = app_actor_id()
  AND entered_as_role::text = app_actor_role()
  AND app_actor_role() = 'accountant'
);
CREATE POLICY vendor_bank_update_supersede ON vendor_bank FOR UPDATE
  USING (app_actor_role() = 'accountant' AND superseded_at IS NULL)
  WITH CHECK (app_actor_role() = 'accountant' AND superseded_at IS NOT NULL);

GRANT SELECT, INSERT, UPDATE ON vendor_bank TO app_runtime;

-- vendor_document: same visibility as vendor/vendor_bank. INSERT is
-- accountant/super_admin, matching vendor_insert exactly — documents are
-- KYC evidence for the vendor record, not something a payer attaches.
ALTER TABLE vendor_document ENABLE ROW LEVEL SECURITY;

CREATE POLICY vendor_document_select ON vendor_document FOR SELECT USING (
  app_actor_role() IN ('accountant', 'payer', 'super_admin', 'developer')
);
CREATE POLICY vendor_document_insert ON vendor_document FOR INSERT WITH CHECK (
  uploaded_by = app_actor_id()
  AND app_actor_role() IN ('accountant', 'super_admin')
);

GRANT SELECT, INSERT ON vendor_document TO app_runtime;

-- accounting.vendor_id and request.vendor_key carry no independent
-- access-control meaning of their own — both tables already have
-- unrestricted table-level grants covering every column (accounting:
-- SELECT, INSERT since 0006; request: SELECT, INSERT, UPDATE since 0001),
-- and Postgres column privileges are only ever restrictive when a
-- narrower column-level GRANT has been issued instead (request_file's
-- thumbnail_key/phash is the one place in this schema that does that).
-- Neither new column needs that narrowing, so no grant change is needed
-- here.
