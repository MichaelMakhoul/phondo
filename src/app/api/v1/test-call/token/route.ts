import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import crypto from "crypto";

interface Membership {
  organization_id: string;
}

// POST /api/v1/test-call/token — Issue a short-lived token for browser test calls
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    let body: { assistantId?: string; simulateAfterHours?: boolean };
    try {
      const rawBody = await request.json();
      body = {
        assistantId: typeof rawBody.assistantId === "string" ? rawBody.assistantId : undefined,
        simulateAfterHours: rawBody.simulateAfterHours === true ? true : undefined,
      };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { assistantId, simulateAfterHours } = body;

    if (!assistantId) {
      return NextResponse.json({ error: "assistantId is required" }, { status: 400 });
    }

    // Verify assistant belongs to user's org
    const { data: assistant } = await (supabase
      .from("assistants") as any)
      .select("id")
      .eq("id", assistantId)
      .eq("organization_id", membership.organization_id)
      .single();

    if (!assistant) {
      return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
    }

    const testCallSecret = process.env.TEST_CALL_SECRET;
    const voiceServerUrl = process.env.VOICE_SERVER_PUBLIC_URL;

    if (!testCallSecret || !voiceServerUrl) {
      return NextResponse.json(
        { error: "Test calls not configured" },
        { status: 503 }
      );
    }

    // Build token: base64url(payload).hmac_signature
    const payload = {
      assistantId,
      organizationId: membership.organization_id,
      exp: Date.now() + 30_000, // 30 second expiry
      ...(simulateAfterHours ? { simulateAfterHours: true } : {}),
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", testCallSecret)
      .update(payloadB64)
      .digest("hex");

    const token = `${payloadB64}.${signature}`;
    const wsUrl = voiceServerUrl.replace(/^http/, "ws") + "/ws/test";

    return NextResponse.json({ token, wsUrl });
  } catch (error) {
    console.error("Error creating test call token:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
