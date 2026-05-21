import { NextResponse, type NextRequest } from "next/server";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";

/**
 * Shared auth gate for Vercel cron routes.
 *
 * Vercel attaches `Authorization: Bearer ${CRON_SECRET}` to scheduled
 * invocations when `CRON_SECRET` is set. Returns a `NextResponse` to
 * short-circuit the handler on failure, or `null` when the request is an
 * authenticated cron call.
 *
 * SCRUM-324: a missing `CRON_SECRET` is a deploy misconfig that makes EVERY
 * cron 500 and silently never run. It now pages at error level (so it reaches
 * Loki via the SCRUM-323 transport and the "Next.js — error logged" rule)
 * instead of the old bare `console.error` / silent 500. A 401 (wrong/absent
 * bearer) is deliberately NOT paged — it's mostly internet noise on a public
 * path, and legitimate Vercel cron invocations always carry the secret.
 *
 * @param req      the incoming cron request
 * @param cronName short cron identifier for the alert (e.g. "keep-alive")
 */
export function requireCronAuth(
  req: NextRequest,
  cronName: string,
): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    pageSentry({
      service: "next-cron",
      reason: SENTRY_REASONS.CRON_SECRET_MISSING,
      level: "error",
      message: `CRON_SECRET not configured — ${cronName} cron cannot authenticate`,
      tags: { cron: cronName },
    });
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}
