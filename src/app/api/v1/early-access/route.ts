import { NextResponse } from "next/server";
import { getClientIp, rateLimitDistributed } from "@/lib/security/rate-limiter";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateEarlyAccessInput } from "@/lib/early-access/validate";
import { sendEarlyAccessNotification } from "@/lib/early-access/notify";

// Resend + Supabase admin need the Node runtime (not edge).
export const runtime = "nodejs";

/**
 * Public, unauthenticated: the private-beta signup page's "Request early
 * access" form posts here. Persists the lead (service-role) and emails the
 * founder. Protected by a honeypot + per-IP rate limit; no auth by design.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const validation = validateEarlyAccessInput((body ?? {}) as Record<string, unknown>);
  if (!validation.ok) {
    if (validation.botDetected) {
      // Pretend success so a bot learns nothing — but LOG the trip (no PII) so
      // the rate is visible in Loki. A spike would mean the honeypot is eating
      // real leads (e.g. a password manager autofilling the hidden field),
      // which is otherwise an invisible loss: no row, no email, no error, and
      // the user sees "you're on the list". Telemetry makes that detectable.
      console.info("[EarlyAccess] honeypot tripped — dropped silently", {
        ip: getClientIp(request.headers),
      });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const admin = createAdminClient();

  // Rate-limit before any DB write. Two layers, mirroring demo-call/token:
  //   1. Per-IP (10/min, "auth") — stops a single hammering client.
  //   2. Global across ALL IPs (200/hr) — the per-IP layer is bypassable by an
  //      IP-rotating bot spreading across lambdas (SCRUM-340), and each accepted
  //      POST writes PII + emails the founder, so the funnel needs a hard ceiling.
  const ip = getClientIp(request.headers);
  const perIp = await rateLimitDistributed(admin, ip, "early-access", "earlyAccessPerIp");
  if (!perIp.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: perIp.headers },
    );
  }
  const global = await rateLimitDistributed(admin, "global", "early-access", "earlyAccessGlobal");
  if (!global.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: global.headers },
    );
  }

  // Persist FIRST — this row is the durable record of the lead. If it fails we
  // must tell the user (they can retry / email), because nothing was captured.
  // early_access_requests isn't in the generated Database types yet; cast per
  // the repo's Supabase convention (see CLAUDE.md).
  const { error: insertError } = await (admin as unknown as {
    from: (t: string) => { insert: (v: Record<string, unknown>) => Promise<{ error: unknown }> };
  })
    .from("early_access_requests")
    .insert({ ...validation.data, source: "signup_page" });

  if (insertError) {
    console.error("[EarlyAccess] insert failed:", insertError);
    return NextResponse.json(
      { error: "Something went wrong saving your request. Please email hello@phondo.ai." },
      { status: 500 },
    );
  }

  // Notify the founder — best-effort. The lead is already saved, so a mail
  // failure must not fail the request (a server-side swallow that is correct,
  // unlike a client-side one: the durable write already succeeded).
  try {
    await sendEarlyAccessNotification(validation.data);
  } catch (err) {
    console.error("[EarlyAccess] notification email failed (lead is saved):", err);
  }

  // `tracked: true` marks a GENUINE persisted lead. The honeypot path (line ~34)
  // returns { ok: true } WITHOUT it, so the client fires the Google Ads
  // conversion only for real leads — a honeypot trip (bot spam, or a password
  // manager autofilling the hidden field) must never record a phantom
  // conversion that poisons cost-per-lead. Visible UX is identical either way.
  return NextResponse.json({ ok: true, tracked: true });
}
