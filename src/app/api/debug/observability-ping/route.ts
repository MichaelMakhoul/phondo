import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";

/**
 * SCRUM-323 — TEMPORARY smoke test for the Next.js → Grafana Loki transport.
 *
 * Fires exactly one `[ALERT:warning]` line through `pageSentry` so we can
 * confirm end-to-end that lines reach Loki — the transport is otherwise only
 * exercised by real error/warning paths, so there's no other way to verify it
 * without waiting for an organic failure. Platform-admin only: open it in a
 * browser where you're signed in as an admin. REMOVE once the transport is
 * confirmed (tracked on SCRUM-323).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  pageSentry({
    service: "next-api",
    reason: SENTRY_REASONS.OBSERVABILITY_SMOKE_TEST,
    level: "warning",
    message: "observability transport smoke test (SCRUM-323)",
    extras: { firedAt: new Date().toISOString() },
  });

  return NextResponse.json({
    ok: true,
    note: 'Emitted one [ALERT:warning] line. Check Loki: {service_name="phondo-next"}',
  });
}
