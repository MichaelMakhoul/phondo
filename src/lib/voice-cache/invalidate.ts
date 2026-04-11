/**
 * Fire a cache invalidation webhook to the voice server when schedule data
 * changes outside the voice server (dashboard, CRM webhook, or other non-voice-server source).
 *
 * Layer 2 of cache freshness:
 * - Layer 1: Optimistic deltas (voice server writes, instant)
 * - Layer 2: Webhook invalidation (dashboard/CRM writes, <100ms) ← THIS
 * - Layer 3: TTL safety net (3 minutes, catches everything)
 */

const VOICE_SERVER_URL = process.env.VOICE_SERVER_PUBLIC_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

export async function invalidateVoiceScheduleCache(organizationId: string): Promise<void> {
  if (!VOICE_SERVER_URL || !INTERNAL_API_SECRET) {
    return; // Voice server not configured — skip silently
  }

  try {
    const res = await fetch(`${VOICE_SERVER_URL}/cache/invalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ organizationId }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      console.warn(`[VoiceCacheInvalidate] Voice server returned ${res.status} for org=${organizationId}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[VoiceCacheInvalidate] Failed for org=${organizationId}:`, message);
  }
}
