-- RLS for phase 13 (extraction with confirmation).
--
-- extraction_attempt/extraction: visible to the requester who ran the
-- attempt, plus the standing super_admin/developer global-read branch
-- every table in this codebase already uses (the health console, phase
-- 16). No accountant/payer/approver branch — these rows are pre-submission
-- instrumentation, not part of a request's own trail once it exists (the
-- request's own event rows, rendered via renderEventSummary, are what
-- those roles see).
ALTER TABLE extraction_attempt ENABLE ROW LEVEL SECURITY;

CREATE POLICY extraction_attempt_select ON extraction_attempt FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR attempted_by = app_actor_id()
);
-- Only a requester can create an attempt (extraction only ever runs from
-- the capture screen), and only attributed to themselves — mirrors
-- duplicate_check_insert's own "overridden_by must be the actor's own id"
-- reasoning, just for the attempt's owner instead.
CREATE POLICY extraction_attempt_insert ON extraction_attempt FOR INSERT WITH CHECK (
  app_actor_role() = 'requester'
  AND attempted_by = app_actor_id()
);
-- The only UPDATE this table ever needs: submitRequest backfilling
-- request_id onto an attempt that's actually being submitted, inside its
-- own transaction, scoped as requester — same actor who created the row.
CREATE POLICY extraction_attempt_update ON extraction_attempt FOR UPDATE
  USING (app_actor_role() = 'requester' AND attempted_by = app_actor_id())
  WITH CHECK (app_actor_role() = 'requester' AND attempted_by = app_actor_id());

GRANT SELECT, INSERT, UPDATE ON extraction_attempt TO app_runtime;

ALTER TABLE extraction ENABLE ROW LEVEL SECURITY;

CREATE POLICY extraction_select ON extraction FOR SELECT USING (
  app_actor_role() IN ('super_admin', 'developer')
  OR EXISTS (
    SELECT 1 FROM extraction_attempt ea WHERE ea.id = extraction.attempt_id AND ea.attempted_by = app_actor_id()
  )
);
CREATE POLICY extraction_insert ON extraction FOR INSERT WITH CHECK (
  app_actor_role() = 'requester'
  AND EXISTS (
    SELECT 1 FROM extraction_attempt ea WHERE ea.id = extraction.attempt_id AND ea.attempted_by = app_actor_id()
  )
);
-- The only UPDATE: submitRequest filling in accepted_value/corrected_by
-- retroactively, in the same transaction and same scope as the INSERT
-- above.
CREATE POLICY extraction_update ON extraction FOR UPDATE
  USING (
    app_actor_role() = 'requester'
    AND EXISTS (SELECT 1 FROM extraction_attempt ea WHERE ea.id = extraction.attempt_id AND ea.attempted_by = app_actor_id())
  )
  WITH CHECK (
    app_actor_role() = 'requester'
    AND EXISTS (SELECT 1 FROM extraction_attempt ea WHERE ea.id = extraction.attempt_id AND ea.attempted_by = app_actor_id())
  );

GRANT SELECT, INSERT, UPDATE ON extraction TO app_runtime;
