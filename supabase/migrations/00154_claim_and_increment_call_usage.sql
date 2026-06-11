-- SCRUM-432 (audit finding #48): usage counting was undercount-biased — the
-- claim (calls.usage_counted flip) and the increment (subscriptions.calls_used)
-- were two separate round-trips, so a crash between them permanently lost the
-- count. One function = one transaction: the claim and the increment commit or
-- roll back together.
--
-- Service-role only: this runs from the internal call-completed route via the
-- admin client. PostgREST clients have no business invoking it.

CREATE OR REPLACE FUNCTION public.claim_and_increment_call_usage(p_call_id UUID, p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claimed BOOLEAN;
BEGIN
  -- Atomic claim: only the first caller wins the false→true flip (a voice-
  -- server retry of notifyCallCompleted loses and skips — SCRUM-361).
  UPDATE calls
  SET usage_counted = TRUE
  WHERE id = p_call_id
    AND organization_id = p_org_id
    AND usage_counted = FALSE;
  v_claimed := FOUND;

  IF v_claimed THEN
    UPDATE subscriptions
    SET calls_used = COALESCE(calls_used, 0) + 1
    WHERE organization_id = p_org_id;
  END IF;

  RETURN v_claimed;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_and_increment_call_usage(UUID, UUID) FROM PUBLIC, anon, authenticated;
