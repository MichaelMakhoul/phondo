import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCountryConfig } from "@/lib/country-config";
import { z } from "zod";
import { getPrimaryMembership, isOrgAdminRole } from "@/lib/auth/membership";
import { withRateLimitDistributed } from "@/lib/security/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";

// SCRUM-428 (finding #37): this route drives PAID carrier search APIs —
// bound the inputs (bad values fall back to defaults).
const searchSchema = z.object({
  areaCode: z.string().regex(/^\d{2,6}$/).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(20).catch(10),
});

// POST /api/v1/phone-numbers/search - Search available phone numbers
export async function POST(request: Request) {
  try {
    // Pre-launch kill switch: match the POST /api/v1/phone-numbers gate so the
    // buy dialog can't show real purchasable numbers that would 503 on buy.
    if (process.env.PROVISIONING_ENABLED !== "true") {
      return NextResponse.json(
        {
          error: "Phone number search is temporarily unavailable. Please contact hello@phondo.ai for early access.",
          code: "PROVISIONING_DISABLED",
        },
        { status: 503 }
      );
    }

    // SCRUM-428 (finding #37): each search hits a paid carrier API — bound
    // per IP with the DISTRIBUTED limiter (per-instance memory resets on
    // every cold start; cost-control profiles use the Postgres bucket).
    const rl = await withRateLimitDistributed(
      createAdminClient(),
      request,
      "/api/v1/phone-numbers/search",
      "expensive",
    );
    if (!rl.allowed) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: rl.headers });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Look up org's country
    const membership = await getPrimaryMembership(supabase, user.id);

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // Provisioning is an owner/admin action — match the buy route's intent.
    if (!isOrgAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only organization owners and admins can search phone numbers" },
        { status: 403 }
      );
    }

    const { data: org, error: orgError } = await (supabase as any)
      .from("organizations")
      .select("country")
      .eq("id", membership.organization_id)
      .single();

    if (orgError || !org) {
      return NextResponse.json({ error: "Failed to load organization" }, { status: 500 });
    }

    const countryCode = org.country || "US";

    const config = getCountryConfig(countryCode);
    const rawBody = await request.json().catch(() => ({}));
    // Object-level catch: a non-object body (e.g. a bare string) falls back
    // to defaults instead of throwing a ZodError into the 500 path.
    const { areaCode, limit } = searchSchema
      .catch({ areaCode: undefined, limit: 10 })
      .parse(rawBody);

    if (config.phoneProvider === "telnyx") {
      const { searchAvailableNumbers, validateTelnyxConfig } = await import("@/lib/telnyx/client");
      validateTelnyxConfig(); // Fail fast if TELNYX_API_KEY or TELNYX_TEXML_APP_ID is missing
      const numbers = await searchAvailableNumbers(config.twilioCountryCode, areaCode, limit);
      return NextResponse.json(
        numbers.map((n) => ({
          number: n.number,
          locality: n.locality,
          region: n.region,
          areaCode: areaCode || undefined,
        }))
      );
    }

    if (config.phoneProvider === "twilio") {
      const { searchAvailableNumbers } = await import("@/lib/twilio/client");
      const numbers = await searchAvailableNumbers(config.twilioCountryCode, areaCode, limit);
      return NextResponse.json(
        numbers.map((n) => ({
          number: n.number,
          locality: n.locality,
          region: n.region,
          areaCode: areaCode || undefined,
        }))
      );
    }

    // SCRUM-411: only Twilio/Telnyx are supported now that Vapi is removed.
    return NextResponse.json(
      { error: `Unsupported phone provider: ${config.phoneProvider}` },
      { status: 400 }
    );
  } catch (error: any) {
    console.error("Error searching phone numbers:", error);
    const message = error?.message || "Internal server error";
    // Surface provider config errors clearly
    if (message.includes("TWILIO_ACCOUNT_SID") || message.includes("TWILIO_AUTH_TOKEN")) {
      return NextResponse.json(
        { error: "Twilio is not configured. Please add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to your environment variables." },
        { status: 503 }
      );
    }
    if (message.includes("TELNYX_API_KEY")) {
      return NextResponse.json(
        { error: "Telnyx is not configured. Please add TELNYX_API_KEY to your environment variables." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
