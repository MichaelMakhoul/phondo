import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryMembership } from "@/lib/auth/membership";
import { isOwnerAssistantUiEnabled } from "@/lib/feature-flags";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";

/**
 * POST /api/v1/owner-assistant/token — SCRUM-596: a short-lived token for the
 * owner assistant in the browser.
 *
 * The voice server's /ws/test turns a token with mode "owner" into the phone
 * line's owner assistant: it reads and changes this org's real bookings. So
 * the dashboard login stands in for the phone line's PIN, and this route is the
 * web's whole access check. Only the org's owner gets a token, and only while
 * OWNER_ASSISTANT_UI_ENABLED is on. The token is signed like a test-call token
 * (TEST_CALL_SECRET), lasts 2 minutes and is used once (its jti). The org and
 * user come from the session, never from the request.
 */
export async function POST(request: Request) {
  if (!isOwnerAssistantUiEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getPrimaryMembership(supabase, user.id);
    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    if (membership.role !== "owner") {
      return NextResponse.json(
        { error: "Only the business owner can talk to the assistant here." },
        { status: 403 }
      );
    }

    const limit = await rateLimitDistributed(createAdminClient(), user.id, "owner-assistant-token", "auth");
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many tries — wait a minute and try again." },
        { status: 429, headers: limit.headers }
      );
    }

    let assistantId: string | undefined;
    try {
      const body = await request.json();
      assistantId = typeof body?.assistantId === "string" ? body.assistantId : undefined;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!assistantId) {
      return NextResponse.json({ error: "assistantId is required" }, { status: 400 });
    }

    // The assistant must be the owner's own org's. "No rows" (PGRST116) is a 404;
    // any other read error is ours, and is said as one.
    const { data: assistant, error: assistantError } = await (supabase.from("assistants") as any)
      .select("id")
      .eq("id", assistantId)
      .eq("organization_id", membership.organization_id)
      .single();
    if (assistantError && assistantError.code !== "PGRST116") {
      console.error("[OwnerAssistantToken] assistants read failed:", {
        organizationId: membership.organization_id,
        errorCode: assistantError.code,
        errorMessage: assistantError.message,
      });
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
    if (!assistant) {
      return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
    }

    const testCallSecret = process.env.TEST_CALL_SECRET;
    const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;
    if (!testCallSecret || !voiceServerUrl) {
      return NextResponse.json({ error: "The assistant isn't configured" }, { status: 503 });
    }

    const payload = {
      mode: "owner",
      assistantId,
      organizationId: membership.organization_id,
      userId: user.id,
      // 2 minutes, as for test calls: the mic prompt and a cold voice server
      // both come before the socket connects. The jti still bounds replay to one use.
      exp: Date.now() + 120_000,
      jti: crypto.randomUUID(),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", testCallSecret).update(payloadB64).digest("hex");

    return NextResponse.json({
      token: `${payloadB64}.${signature}`,
      wsUrl: voiceServerUrl.replace(/^http/, "ws") + "/ws/test",
    });
  } catch (error) {
    console.error("[OwnerAssistantToken] Failed to issue a token:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
