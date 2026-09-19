-- Hand-authored (drizzle-kit does not generate functions). Additive: a new
-- function and a grant, nothing existing is altered, so the previously
-- deployed app keeps working against this schema.
--
-- The search behind the sixth duplicate verdict, matched_advance
-- (docs/concept-v2.html section 09): "a new request whose vendor has an
-- unsettled advance". It is a separate function from
-- app_duplicate_check_candidates (0018) rather than a widening of it,
-- because the two answer different questions and return different shapes:
-- that one matches a specific BILL (vendor + invoice number + FY, or a file
-- checksum) and reports the payment reference; this one matches a VENDOR
-- with money already out and no tax invoice yet, and reports the quoted
-- total and what has been paid.
--
-- Same family and same discipline as 0018: SECURITY DEFINER so it can see
-- every department, with viewable_by_actor computed INSIDE from the calling
-- session's own GUCs (app_has_department_scope reads app.actor_id /
-- app.actor_role, which SECURITY DEFINER does not change). The redaction
-- boundary lives here and nowhere else; the caller shapes what this decided.
--
-- "Open" means kind = 'advance', stage = 'awaiting_invoice' (the money has
-- moved) and no invoice attached yet. That is exactly the set attachInvoice
-- can act on. An advance still on its way to being paid is not matched: the
-- invoice cannot be attached to it, and nothing has been paid twice yet.
--
-- Three ways a vendor is recognised, strongest first, because what is known
-- differs by desk. At the accounts desk the vendor is already matched, so
-- p_vendor_key is exact. At capture nothing is matched yet; all that exists
-- is what the bill says, so the GSTIN printed on it (compared with
-- punctuation and case stripped from both sides, since vendor_key holds
-- whatever was typed into the vendor master) and the vendor name the
-- requester confirmed. The name comparison is normalised equality only
-- (case and punctuation ignored, four characters minimum), never fuzzy — the
-- verdict is advisory and a false positive costs one click, but a fuzzy
-- match on a short name would fire constantly and teach people to click
-- through it, which the brief names as the failure to avoid.
CREATE OR REPLACE FUNCTION app_open_advance_candidates(
  p_exclude_request_id uuid,
  p_vendor_key text,
  p_gstin text,
  p_vendor_name text
) RETURNS TABLE(
  request_id uuid,
  department_id uuid,
  ref text,
  stage text,
  currency text,
  quoted_minor text,
  paid_minor text,
  match_kind text,
  viewable_by_actor boolean,
  raised_by_actor boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH probe AS (
    SELECT
      nullif(p_vendor_key, '') AS vendor_key,
      nullif(upper(regexp_replace(coalesce(p_gstin, ''), '[^A-Za-z0-9]', '', 'g')), '') AS gstin,
      CASE
        WHEN length(regexp_replace(coalesce(p_vendor_name, ''), '[^A-Za-z0-9]', '', 'g')) >= 4
        THEN lower(regexp_replace(p_vendor_name, '[^A-Za-z0-9]', '', 'g'))
      END AS name_norm
  )
  SELECT
    r.id,
    r.department_id,
    r.ref,
    r.stage::text,
    r.currency,
    r.amount_minor::text,
    (SELECT coalesce(sum(p.amount_minor), 0) FROM payment p WHERE p.request_id = r.id)::text,
    CASE
      WHEN probe.vendor_key IS NOT NULL AND r.vendor_key = probe.vendor_key THEN 'vendor_key'
      WHEN probe.gstin IS NOT NULL AND (
        upper(regexp_replace(coalesce(r.vendor_key, ''), '[^A-Za-z0-9]', '', 'g')) = probe.gstin
        OR upper(regexp_replace(coalesce(r.gstin_on_bill, ''), '[^A-Za-z0-9]', '', 'g')) = probe.gstin
      ) THEN 'gstin'
      ELSE 'vendor_name'
    END,
    app_has_department_scope(r.department_id),
    r.raised_by = app_actor_id()
  FROM request r, probe
  WHERE r.kind = 'advance'
    AND r.stage = 'awaiting_invoice'
    AND r.invoice_attached_at IS NULL
    AND (p_exclude_request_id IS NULL OR r.id <> p_exclude_request_id)
    AND (
      (probe.vendor_key IS NOT NULL AND r.vendor_key = probe.vendor_key)
      OR (probe.gstin IS NOT NULL AND (
        upper(regexp_replace(coalesce(r.vendor_key, ''), '[^A-Za-z0-9]', '', 'g')) = probe.gstin
        OR upper(regexp_replace(coalesce(r.gstin_on_bill, ''), '[^A-Za-z0-9]', '', 'g')) = probe.gstin
      ))
      OR (probe.name_norm IS NOT NULL AND (
        lower(regexp_replace(coalesce(r.vendor, ''), '[^A-Za-z0-9]', '', 'g')) = probe.name_norm
        OR EXISTS (
          SELECT 1 FROM accounting a JOIN vendor v ON v.id = a.vendor_id
          WHERE a.request_id = r.id
            AND lower(regexp_replace(v.name, '[^A-Za-z0-9]', '', 'g')) = probe.name_norm
        )
      ))
    )
  ORDER BY app_has_department_scope(r.department_id) DESC, r.created_at ASC
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_open_advance_candidates(uuid, text, text, text) TO app_runtime;
