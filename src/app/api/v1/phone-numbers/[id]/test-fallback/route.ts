import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { getTwilioClient } from "@/lib/twilio/client";
import { rateLimit } from "@/lib/security/rate-limiter";
import {
  expectedE164PrefixForCountry,
  matchesCountryPrefix,
  buildTestCallTwiml,
} from "./helpers";

interface Membership {
  organization_id: string;
  role?: string;
}

interface PhoneNumberRow {
  id: string;
  phone_number: string;
  fallback_forward_number: string | null;
  twilio_sid: string | null;
  source_type: string | null;
  organization_id: string;
  organizations: { country: string | null } | null;
}

/**
 * POST /api/v1/phone-numbers/[id]/test-fallback
 *
 * Places a brief outbound test call to the org's configured
 * `fallback_forward_number` so the owner can verify the kill-switch
 * forwarding still reaches them. The call:
 *   - dials from the inbound phone number (so the owner's mobile shows
 *     their business number, which they recognise)
 *   - speaks a single line via Twilio Polly TTS and hangs up
 *   - is capped to 10 seconds via Twilio's `timeLimit`
 *
 * Guarded by org admin role, a 1/min per-org rate limit, and a
 * country-prefix match (the saved fallback must be in the org's country,
 * otherwise the test would dial unexpectedly internationally).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };
    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const isAdmin = !!membership.role && ["owner", "admin"].includes(membership.role);
    if (!isAdmin) {
      // Mirrors the PATCH role-gate on `fallback_forward_number` itself —
      // outbound dialing must not be triggerable by a viewer.
      return NextResponse.json(
        { error: "Only org owners and admins can place test calls" },
        { status: 403 },
      );
    }

    // Per-org rate limit (1 call / min). Use orgId as identifier so two
    // admins in the same org share the budget — the limit is on the spend,
    // not the user.
    const { allowed, headers } = rateLimit(
      membership.organization_id,
      "phone-numbers/test-fallback",
      "fallbackTestCall",
    );
    if (!allowed) {
      // Make the per-org scope explicit — otherwise a second admin
      // troubleshooting fallback config is left wondering why their own
      // first request is throttled.
      return NextResponse.json(
        { error: "Your organization can place 1 test call per minute. Please wait, then try again." },
        { status: 429, headers },
      );
    }

    const { data: row, error } = await (supabase
      .from("phone_numbers") as any)
      .select("id, phone_number, fallback_forward_number, twilio_sid, source_type, organization_id, organizations(country)")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single() as { data: PhoneNumberRow | null; error: unknown };
    if (error || !row) {
      return NextResponse.json({ error: "Phone number not found" }, { status: 404 });
    }

    const fallback = (row.fallback_forward_number || "").trim();
    if (!fallback) {
      return NextResponse.json(
        { error: "Save a fallback number first, then click Test." },
        { status: 400 },
      );
    }
    // Defense-in-depth: the PATCH route already validates format and
    // rejects self-forwards, but re-check here so a stale or
    // out-of-band-written value cannot trigger a Twilio call on something
    // malformed. The self-dial check guards against the bizarre case where
    // a row migrated from outside the API has fallback == own number
    // (which would dial yourself and burn 10s of Twilio time for nothing).
    if (!/^\+[1-9]\d{7,14}$/.test(fallback)) {
      return NextResponse.json(
        { error: "Saved fallback number is not a valid E.164 number." },
        { status: 400 },
      );
    }
    if (fallback === row.phone_number) {
      return NextResponse.json(
        { error: "Saved fallback number is the same as this phone number — cannot test a self-dial." },
        { status: 400 },
      );
    }

    if (!row.twilio_sid) {
      // No Twilio SID → either a Telnyx number, or a carrier-forwarded
      // number whose Twilio provisioning failed. The outbound test-call
      // helper for non-Twilio carriers is a separate piece of work; the
      // user-facing message disambiguates the two cases the user can
      // actually act on.
      const message =
        row.source_type === "forwarded"
          ? "Test calls are not available for carrier-forwarded numbers yet."
          : "Test calls are not yet supported for this carrier.";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const orgCountry = row.organizations?.country || null;
    if (!matchesCountryPrefix(fallback, orgCountry)) {
      const expectedPrefix = expectedE164PrefixForCountry(orgCountry);
      return NextResponse.json(
        {
          error: expectedPrefix
            ? `The fallback number must be in your organization's country (expected ${expectedPrefix}…). Cross-country test calls are not yet supported.`
            : "Cannot determine the expected country prefix for your organization. Cross-country test calls are not yet supported.",
        },
        { status: 400 },
      );
    }

    let callSid: string;
    try {
      const twilio = getTwilioClient();
      const call = await twilio.calls.create({
        from: row.phone_number,
        to: fallback,
        twiml: buildTestCallTwiml(),
        // Cap call duration to 10s so a runaway dial cannot rack up cost.
        // Twilio enforces this from the moment of dial.
        timeLimit: 10,
      });
      callSid = call.sid;
    } catch (twErr) {
      const message = twErr instanceof Error ? twErr.message : "Failed to place call";
      console.error("[TestFallback] Twilio calls.create failed:", {
        orgId: membership.organization_id,
        phoneNumberId: id,
        error: message,
      });
      // Cost-related Twilio failures (insufficient balance, geo-permissions
      // disabled for the destination country, unverified caller-id on
      // trial accounts) would otherwise be invisible in Sentry. Capture
      // with org/phone context so on-call can triage which tenant tripped.
      Sentry.withScope((scope) => {
        scope.setTag("service", "next-api");
        scope.setTag("route", "phone-numbers/test-fallback");
        scope.setTag("reason", "twilio-create-call-failed");
        scope.setLevel("warning");
        scope.setExtras({
          orgId: membership.organization_id,
          phoneNumberId: id,
        });
        Sentry.captureException(twErr);
      });
      return NextResponse.json(
        { error: "Could not place the test call. Please try again in a moment." },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, callSid });
  } catch (err) {
    console.error("[TestFallback] Unexpected error:", err);
    Sentry.captureException(err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
