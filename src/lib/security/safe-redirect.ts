/**
 * Open-redirect protection for post-auth redirect targets (SCRUM-346, audit M5).
 *
 * A redirect target taken from the query string can be abused to bounce a
 * just-authenticated user to an attacker origin (post-login phishing). The
 * classic traps when a path is naively concatenated as `${origin}${redirect}`
 * (origin has no trailing slash):
 *   - `@evil.com`        -> `https://app.phondo.ai@evil.com`  (host = evil.com)
 *   - `.evil.com`        -> `https://app.phondo.ai.evil.com`
 *   - `//evil.com`       -> scheme-relative -> external origin
 *   - `/\evil.com`       -> browsers normalise `\`->`/` -> `//evil.com`
 *   - `https://evil.com` -> absolute external URL
 *
 * This module is intentionally dependency-free (no Node built-ins) so it can be
 * imported from BOTH client components (the login page's router.push) and server
 * route handlers (the /auth/callback redirect) -- unlike security/validation.ts,
 * which pulls in `dns`/`crypto`.
 */

/**
 * True if the string contains any C0 control char or DEL (CR/LF/TAB/NUL/etc.) —
 * these can smuggle a second header or confuse URL parsing. Implemented with a
 * char-code scan rather than a regex to avoid embedding control chars in source
 * (and the eslint no-control-regex rule).
 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True if the path is not a single-slash same-origin path: not absolute, or
 * scheme-relative ("//host"), or a backslash variant browsers fold to "//".
 * Applied to BOTH the raw input AND the URL-normalised result, because `..`
 * normalisation can turn a guarded input like "/..//evil.com" back into a
 * scheme-relative "//evil.com".
 */
function isUnsafePrefix(s: string): boolean {
  return !s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\");
}

/**
 * Return `redirect` only if it is a safe, same-origin internal path; otherwise
 * return `fallback`. A safe value must be an absolute path beginning with a
 * single "/", with no scheme/host, no scheme-relative or backslash escape, and
 * no control characters. The returned value is the normalised path+search+hash,
 * so it is always safe to use as `${origin}${result}` or `router.push(result)`.
 *
 * SCRUM-354: an optional `onReject(rejected, reason)` fires only when a NON-EMPTY
 * redirect value is rejected (never for an absent/empty param — that's the normal
 * "no redirect" case). Server callers pass it to log/alert on probe attempts;
 * client callers omit it (keeping this module dependency-free).
 */
export function safeRedirectPath(
  redirect: string | null | undefined,
  fallback: string = "/dashboard",
  onReject?: (rejected: string, reason: string) => void
): string {
  if (!redirect || typeof redirect !== "string") return fallback;

  // A non-empty value was supplied but failed a check — notify (best-effort) and
  // fall back. The callback must never break validation, so swallow its throws.
  const reject = (reason: string): string => {
    try {
      onReject?.(redirect, reason);
    } catch {
      /* observability must not affect the security decision */
    }
    return fallback;
  };

  // Reject bare tokens ("@evil.com", "https://..."), scheme-relative ("//host"),
  // and backslash variants on the RAW input.
  if (isUnsafePrefix(redirect)) return reject("unsafe-prefix");
  if (hasControlChars(redirect)) return reject("control-chars");

  // Defense-in-depth: resolve against a throwaway base and require the result to
  // stay on that origin. The WHATWG URL parser converts backslashes to slashes
  // for special schemes, so this also catches mid-string `\` escapes.
  try {
    const base = "https://internal.invalid";
    const resolved = new URL(redirect, base);
    if (resolved.origin !== base) return reject("external-origin");
    const candidate = resolved.pathname + resolved.search + resolved.hash;
    // Re-assert the FINAL value: `..` normalisation can collapse a guarded input
    // ("/..//evil.com") into a scheme-relative path ("//evil.com") that
    // router.push() would resolve to an external origin.
    if (isUnsafePrefix(candidate)) return reject("normalised-external");
    return candidate;
  } catch {
    return reject("parse-error");
  }
}
