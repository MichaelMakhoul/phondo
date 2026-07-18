import { describe, it, expect } from "vitest";

import { posthogTargetUrl, buildForwardHeaders } from "@/lib/analytics/ingest-proxy";

// SCRUM-566: the /ingest proxy is a cookie-stripping ROUTE HANDLER, not a
// rewrite — Next.js forwards the request Cookie header verbatim to external
// rewrite destinations, which would ship the Supabase auth cookies (access
// JWT + refresh token) to PostHog on every beacon. These pin the two
// security-load-bearing behaviors: fixed destination hosts, and the header
// allowlist that can never leak credentials.

describe("posthogTargetUrl", () => {
  it("routes static assets to the EU assets host and everything else to the EU API host", () => {
    expect(posthogTargetUrl(["static", "array", "phc_k", "config.js"], "")).toBe(
      "https://eu-assets.i.posthog.com/static/array/phc_k/config.js",
    );
    expect(posthogTargetUrl(["e"], "?compression=gzip-js")).toBe(
      "https://eu.i.posthog.com/e?compression=gzip-js",
    );
    expect(posthogTargetUrl(["flags"], "?v=2")).toBe("https://eu.i.posthog.com/flags?v=2");
  });

  it("path segments cannot steer the host (no SSRF surface)", () => {
    // A hostile path segment is percent-encoded into the PATH of the fixed
    // host — never a new origin.
    expect(posthogTargetUrl(["..", "evil.com"], "")).toBe("https://eu.i.posthog.com/../evil.com");
    expect(posthogTargetUrl(["https://evil.com"], "")).toBe(
      "https://eu.i.posthog.com/https%3A%2F%2Fevil.com",
    );
  });
});

describe("buildForwardHeaders", () => {
  it("NEVER forwards cookie or authorization — the reason this proxy exists", () => {
    const incoming = new Headers({
      cookie: "sb-ref-auth-token=SECRET; sb-ref-auth-token.1=SECRET2",
      authorization: "Bearer SECRET",
      "content-type": "text/plain",
      "user-agent": "Mozilla/5.0",
      "x-custom-header": "nope",
    });
    const out = buildForwardHeaders(incoming, "203.0.113.7");

    expect(out.get("cookie")).toBeNull();
    expect(out.get("authorization")).toBeNull();
    expect(out.get("x-custom-header")).toBeNull();
    expect(out.get("content-type")).toBe("text/plain");
    expect(out.get("user-agent")).toBe("Mozilla/5.0");
    expect(out.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("omits x-forwarded-for when the client IP is unknown", () => {
    const out = buildForwardHeaders(new Headers(), null);
    expect(out.get("x-forwarded-for")).toBeNull();
  });
});
