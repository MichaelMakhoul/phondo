import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/security/safe-redirect";
import { pageSentry } from "@/lib/observability/page-sentry";
import { SENTRY_REASONS } from "@/lib/security/error-ids";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  // SCRUM-346 (M5): validate the redirect target — an unvalidated value lets a
  // phishing link bounce the just-authenticated user to an external origin
  // (e.g. redirect=@evil.com -> https://app.phondo.ai@evil.com). safeRedirectPath
  // returns a same-origin path or falls back to /dashboard.
  // SCRUM-354: surface a rejected (non-empty) redirect — a burst signals someone
  // probing the auth flow for a post-login phishing bounce.
  const redirect = safeRedirectPath(
    requestUrl.searchParams.get("redirect"),
    "/dashboard",
    (rejected, reason) =>
      pageSentry({
        service: "next-api",
        reason: SENTRY_REASONS.OPEN_REDIRECT_BLOCKED,
        level: "warning",
        message: "Blocked an open-redirect attempt at /auth/callback",
        extras: { rejected: rejected.slice(0, 200), reason },
      })
  );
  const origin = requestUrl.origin;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Check if user has an organization, if not redirect to onboarding
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        const { data: memberships } = await supabase
          .from("org_members")
          .select("organization_id")
          .eq("user_id", user.id)
          .limit(1);

        if (!memberships || memberships.length === 0) {
          return NextResponse.redirect(`${origin}/onboarding`);
        }
      }

      return NextResponse.redirect(`${origin}${redirect}`);
    }
  }

  // URL to redirect to after sign up process completes
  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
