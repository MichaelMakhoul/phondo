import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { configureVoiceWebhook } from "@/lib/twilio/client";

/**
 * POST /api/admin/update-fallback-urls
 *
 * One-time admin endpoint to backfill fallback URLs on all existing Twilio numbers.
 *
 * SCRUM-420 (audit findings #31/#60): previously gated by the shared
 * INTERNAL_API_SECRET — the voice-server's machine-to-machine secret, which a
 * compromised voice server could replay against this operator endpoint. Now
 * requires a logged-in platform admin, matching every other /api/admin route.
 *
 * CSRF: mitigated by Supabase SSR's SameSite=Lax auth cookies (cross-site
 * POSTs don't carry them), and the handler reads zero request input — its
 * only effect derives from server env vars. Invocation (no UI caller): run a
 * fetch from a logged-in admin browser session, e.g.
 *   fetch("/api/admin/update-fallback-urls", { method: "POST" })
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await isPlatformAdmin(user.id);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;
  if (!appUrl || !voiceServerUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL and VOICE_SERVER_PUBLIC_URL must be set" },
      { status: 500 }
    );
  }

  const fallbackUrl = `${appUrl}/api/twilio/voice-fallback`;

  const adminSupabase = createAdminClient();
  const { data: numbers, error } = await (adminSupabase as any)
    .from("phone_numbers")
    .select("id, twilio_sid, phone_number")
    .not("twilio_sid", "is", null)
    .eq("is_active", true);

  if (error) {
    console.error("[Admin] Failed to fetch phone numbers:", error);
    return NextResponse.json({ error: "Failed to fetch phone numbers" }, { status: 500 });
  }

  const results: { number: string; success: boolean; error?: string }[] = [];

  for (const num of numbers || []) {
    try {
      await configureVoiceWebhook(
        num.twilio_sid,
        `${voiceServerUrl}/twiml`,
        fallbackUrl
      );
      results.push({ number: num.phone_number, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] Failed to update fallback for ${num.phone_number}:`, err);
      results.push({ number: num.phone_number, success: false, error: message });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`[Admin] Fallback URL backfill complete: ${succeeded} updated, ${failed} failed`);

  return NextResponse.json({ updated: succeeded, failed, results });
}
