import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { configureVoiceWebhook } from "@/lib/twilio/client";

/**
 * POST /api/admin/update-fallback-urls
 *
 * One-time admin endpoint to backfill fallback URLs on all existing Twilio numbers.
 * Protected by INTERNAL_API_SECRET header.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error("[Admin] INTERNAL_API_SECRET not configured");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;
  if (!appUrl || !voiceServerUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL and VOICE_SERVER_PUBLIC_URL must be set" },
      { status: 500 }
    );
  }

  const fallbackUrl = `${appUrl}/api/twilio/voice-fallback`;

  const supabase = createAdminClient();
  const { data: numbers, error } = await (supabase as any)
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
