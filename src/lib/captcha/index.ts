// SCRUM-436: Cloudflare Turnstile support for Supabase Auth endpoints.
//
// The site key is public (it identifies the widget, not a secret) and is
// inlined at build time via NEXT_PUBLIC_. Rollout is one-directional: the env
// var must be set AND deployed BEFORE the Supabase dashboard CAPTCHA toggle is
// enabled — toggle-first rejects every auth attempt (no widget exists to mint
// tokens) until a deploy ships the key. The only safe "either order" property
// is the reverse: sending a captchaToken while the toggle is OFF is harmlessly
// ignored, which is what lets this code ship ahead of the toggle.

export function isCaptchaConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}

/**
 * Supabase Auth rejects requests with a missing/expired/invalid captcha token
 * with code "captcha_failed" (GoTrue). The message fallback is anchored to the
 * one known GoTrue captcha message so unrelated future errors that merely
 * mention "captcha" aren't masked by the generic copy.
 */
export function isCaptchaFailedError(
  error: { code?: string; message?: string } | null | undefined
): boolean {
  if (!error) return false;
  if (error.code === "captcha_failed") return true;
  return /captcha verification process failed/i.test(error.message ?? "");
}

export const CAPTCHA_FAILED_MESSAGE =
  "Security check failed. Please try again — if it keeps happening, reload the page.";

export const CAPTCHA_PENDING_MESSAGE =
  "Please wait a moment for the security check to finish, then try again.";

export const CAPTCHA_BLOCKED_MESSAGE =
  "The security check couldn't load. Please disable content blockers for this site or reload the page.";

export const CAPTCHA_MISCONFIGURED_MESSAGE =
  "Sign-in is temporarily unavailable due to a configuration issue on our side. Please try again later.";

/**
 * Pick the user-facing copy for a captcha_failed rejection, and log the one
 * variant that is OUR fault: Supabase enforcing CAPTCHA while this deployment
 * has no site key is a sitewide auth outage that would otherwise look like
 * user error and emit no signal.
 */
export function captchaFailedUserMessage(opts: { widgetLoadFailed: boolean }): string {
  if (!isCaptchaConfigured()) {
    console.error(
      "[captcha] Supabase CAPTCHA is enforced but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set in this deployment — every auth attempt will fail until the key is deployed (see .env.example rollout note)."
    );
    return CAPTCHA_MISCONFIGURED_MESSAGE;
  }
  return opts.widgetLoadFailed ? CAPTCHA_BLOCKED_MESSAGE : CAPTCHA_FAILED_MESSAGE;
}
