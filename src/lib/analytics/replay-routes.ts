// SCRUM-569: session replay is DEFAULT-DENY. Only these unauthenticated
// marketing/auth route prefixes are ever recorded; every other path is
// excluded. Route groups like (dashboard) flatten in the URL, so the whole
// authenticated app sits at root paths (/calls, /appointments, /callbacks, …)
// where caller PII (names, numbers, transcripts) renders. An allowlist — not a
// denylist — is the safe default: a NEW authenticated route is excluded by
// construction, and the only failure mode of a missed public route is lost
// analytics, never a PII leak.
const PUBLIC_REPLAY_PREFIXES = [
  "/demo",
  "/pricing",
  "/privacy",
  "/terms",
  "/data-sovereignty",
  "/industries",
  "/login",
  "/signup",
  "/forgot-password",
  "/auth",
] as const;

/**
 * True only for unauthenticated marketing/auth paths that are safe to
 * session-record. Matches an exact prefix or a sub-path of it (`/industries`
 * and `/industries/dental`), but never a longer name that merely starts with
 * one (`/loginx` is not `/login`).
 */
export function isPublicReplayPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_REPLAY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}
