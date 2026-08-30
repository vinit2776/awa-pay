-- request.ref generation (phase 3 — capture). A sequence, not a MAX+1
-- pattern: nextval() is lock-free and atomic across concurrent inserts by
-- design. Sequences carry no rows, so RLS doesn't apply to them — the
-- GRANT below is the only privilege that matters, added explicitly in its
-- own migration in the same spirit as 0001's explicit-not-implicit grants.
CREATE SEQUENCE request_ref_seq AS bigint START WITH 1 INCREMENT BY 1;
GRANT USAGE, SELECT ON SEQUENCE request_ref_seq TO app_runtime;
