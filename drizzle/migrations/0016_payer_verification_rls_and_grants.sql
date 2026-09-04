-- RLS for phase 10 (payer verification). No schema change — vendor_bank's
-- verified_by/verified_at columns already exist (0014); this migration
-- only adds the policies that let a payer actually write to them. Both
-- new GRANTs this phase would otherwise need (UPDATE, INSERT on
-- vendor_bank) were already issued to app_runtime in 0015 (UPDATE was
-- added there for the accountant's own supersede step), so there is
-- nothing to grant here — only policies.

-- Payer verification: flips a still-unverified current bank row to
-- verified, attributing it to the verifying payer. One-directional, same
-- shape as query_update's answered-state policy (0011) — USING only
-- matches an unverified row, WITH CHECK only allows landing on verified
-- and attributed to the actor doing the verifying, so this can never
-- un-verify a row or attribute a verification to someone else. Combines
-- via OR with vendor_bank_update_supersede (0015) — Postgres RLS ORs
-- multiple permissive policies for the same command together, so an
-- accountant's supersede and a payer's verify stay two independently
-- auditable policies rather than one shared, harder-to-reason-about rule.
CREATE POLICY vendor_bank_update_verify ON vendor_bank FOR UPDATE
  USING (app_actor_role() = 'payer' AND verified_at IS NULL)
  WITH CHECK (app_actor_role() = 'payer' AND verified_by = app_actor_id() AND verified_at IS NOT NULL);

-- The payer's own supersede step, needed by insertVendorBankAsPayer's
-- supersede-then-insert sequence — found the hard way, by a genuine
-- two-payer concurrency test that hit vendor_bank_current_unique_idx: a
-- payer's correction inserts an ALREADY-VERIFIED current row (verified_at
-- is never null for a row insertVendorBankAsPayer creates), so
-- vendor_bank_update_verify's own USING clause (verified_at IS NULL)
-- never matches it, and there was no other UPDATE policy letting a payer
-- supersede a current row at all. Mirrors vendor_bank_update_supersede
-- (0015) exactly, just for the payer role instead of accountant — the two
-- correction paths (accountant's normal entry, payer's narrow escape
-- hatch) each get their own independently auditable supersede policy,
-- same reasoning as vendor_bank_insert vs vendor_bank_insert_payer below.
CREATE POLICY vendor_bank_update_supersede_payer ON vendor_bank FOR UPDATE
  USING (app_actor_role() = 'payer' AND superseded_at IS NULL)
  WITH CHECK (app_actor_role() = 'payer' AND superseded_at IS NOT NULL);

-- The payer's narrow, self-verified correction path (docs/START-HERE-slice-3.md's
-- "Design decisions" — finding #3): entering bank details directly when
-- the payer is holding fresh proof, rather than routing back through
-- accounts first. Two things make this an escape hatch rather than a
-- backdoor: it's ALWAYS self-verified at insert (verified_by/verified_at
-- must already be set to the inserting payer — there is no unverified
-- state to later approve), and it requires a vendor_document row for the
-- same vendor to already exist — defense-in-depth alongside the
-- application-layer pre-check in insertVendorBankAsPayer, matching
-- payment_insert's own belt-and-suspenders style (0006).
CREATE POLICY vendor_bank_insert_payer ON vendor_bank FOR INSERT WITH CHECK (
  app_actor_role() = 'payer'
  AND entered_by = app_actor_id()
  AND entered_as_role::text = app_actor_role()
  AND verified_by = app_actor_id()
  AND verified_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM vendor_document vd WHERE vd.vendor_id = vendor_bank.vendor_id)
);
