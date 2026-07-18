// SCRUM-566: pure helpers for the first-party PostHog proxy route
// (src/app/ingest/[...path]/route.ts). Split out because Next.js route files
// may only export HTTP methods — and these two behaviors are the
// security-load-bearing ones, so they live where tests can import them.

const POSTHOG_API_HOST = "https://eu.i.posthog.com";
const POSTHOG_ASSETS_HOST = "https://eu-assets.i.posthog.com";

/**
 * Fixed-host target for a proxied path: static assets vs the event API. The
 * hosts are constants — callers control only the path+query appended to
 * them, so there is no SSRF/open-proxy surface.
 */
export function posthogTargetUrl(pathSegments: string[], search: string): string {
  const path = pathSegments.map(encodeURIComponent).join("/");
  const host = pathSegments[0] === "static" ? POSTHOG_ASSETS_HOST : POSTHOG_API_HOST;
  return `${host}/${path}${search}`;
}

/**
 * Request headers safe to forward. Deny-by-default: cookie and authorization
 * must never reach PostHog — forwarding cookies is the exact session-token
 * exfiltration the route-handler proxy exists to prevent (Next.js rewrites
 * forward them verbatim).
 */
const FORWARDED_REQUEST_HEADERS = ["content-type", "user-agent", "accept", "accept-language"] as const;

export function buildForwardHeaders(incoming: Headers, clientIp: string | null): Headers {
  const out = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const v = incoming.get(name);
    if (v) out.set(name, v);
  }
  // Real client IP for PostHog's geo enrichment (Vercel sets x-forwarded-for;
  // first hop is the client).
  if (clientIp) out.set("x-forwarded-for", clientIp);
  return out;
}

/** Response headers safe to relay back. set-cookie is deliberately absent. */
export const RELAYED_RESPONSE_HEADERS = ["content-type", "cache-control", "etag"] as const;
