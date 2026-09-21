-- Found by tests/advance-part-payment.test.ts: attachInvoice (the requester
-- attaching the tax invoice to a paid advance) failed with "new row violates
-- row-level security policy". 0024 widened request_update's USING clause to
-- admit the requester at 'awaiting_invoice', but WITH CHECK still demanded
-- company_id IS NULL OR app_has_company_scope(company_id), and a requester
-- has no company scope. Until now that never mattered: a requester only ever
-- touched rows before accounting, when company_id was still null. An advance
-- is the first request to come BACK to its requester after accounts has set
-- the company.
--
-- Not fixed by exempting requesters from the company check outright: the old
-- policy quietly guaranteed a requester can never write a company_id at all,
-- and that is worth keeping. Instead, for a requester the company on the row
-- must be one an accountant actually booked it to. accounting is append-only,
-- department-readable by every role, and its company_id is scope-checked at
-- insert, so this admits leaving company_id exactly as accounts set it and
-- nothing else.
DROP POLICY request_update ON request;--> statement-breakpoint
CREATE POLICY request_update ON request FOR UPDATE
  USING (
    app_actor_role() IN ('super_admin', 'developer')
    OR (app_actor_role() IN ('approver', 'accountant', 'payer') AND app_has_department_scope(department_id))
    OR (app_actor_role() = 'requester' AND app_has_department_scope(department_id) AND stage IN ('raised', 'awaiting_invoice'))
  )
  WITH CHECK (
    app_has_department_scope(department_id)
    AND (
      company_id IS NULL
      OR app_has_company_scope(company_id)
      OR (
        app_actor_role() = 'requester'
        AND EXISTS (
          SELECT 1 FROM accounting a
          WHERE a.request_id = request.id AND a.company_id = request.company_id
        )
      )
    )
  );
