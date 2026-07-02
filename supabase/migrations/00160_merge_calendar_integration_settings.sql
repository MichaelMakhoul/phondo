-- SCRUM-489: atomic partial-settings merge for calendar_integrations.
--
-- reconcileClinikoOrg, markClinikoAuthFailure and the catalog-sync cron all
-- persist a single settings key (lastReconciledAt / errorState / lastSyncedAt)
-- by read-modify-writing the WHOLE settings JSONB blob (`{ ...settings, key }`).
-- Under concurrency (a voice call reconciling while a cron runs, or two calls to
-- one org) a stale-read writer silently reverts a sibling key another writer
-- just set. This function merges a partial patch server-side so each writer only
-- ever touches its own keys — jsonb `||` is right-biased, so `p_patch` wins on a
-- key conflict and every other key is preserved.
CREATE OR REPLACE FUNCTION merge_calendar_integration_settings(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE calendar_integrations
  SET settings = COALESCE(settings, '{}'::jsonb) || p_patch,
      updated_at = now()
  WHERE id = p_id;
$$;

-- Only the service role (server-side admin client) writes integration settings.
REVOKE ALL ON FUNCTION merge_calendar_integration_settings(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_calendar_integration_settings(uuid, jsonb) TO service_role;
