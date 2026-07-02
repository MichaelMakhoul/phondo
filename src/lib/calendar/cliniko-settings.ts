/**
 * SCRUM-489: atomic partial write of calendar_integrations.settings.
 *
 * Every settings writer (reconcile cursor, auth-failure flag, catalog-sync
 * markers) must patch ONLY the keys it owns — a full-object read-modify-write
 * clobbers a sibling key another concurrent writer just set. This routes through
 * the `merge_calendar_integration_settings` RPC, which does `settings || patch`
 * server-side (right-biased, so `patch` wins per key and everything else is
 * preserved). Returns the RPC error (null on success) for the caller to log.
 */
export async function mergeIntegrationSettings(
  admin: unknown,
  integrationId: string,
  patch: Record<string, unknown>
): Promise<{ error: { message?: string; code?: string } | null }> {
  const { error } = await (admin as any).rpc("merge_calendar_integration_settings", {
    p_id: integrationId,
    p_patch: patch,
  });
  return { error: error ?? null };
}
