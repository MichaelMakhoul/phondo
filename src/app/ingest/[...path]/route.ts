import { NextResponse } from "next/server";
import {
  posthogTargetUrl,
  buildForwardHeaders,
  RELAYED_RESPONSE_HEADERS,
} from "@/lib/analytics/ingest-proxy";

// SCRUM-566: first-party PostHog proxy as a ROUTE HANDLER, not a rewrite.
//
// Why not next.config rewrites: Next.js forwards the request Cookie header
// verbatim to an external rewrite destination, and posthog-js does not opt
// out of credentials — so a logged-in dashboard user's Supabase auth cookies
// (access JWT + refresh token) would ride every analytics beacon to PostHog's
// servers. That is session-token exfiltration to a third party, regardless of
// consent state. This handler forwards ONLY an allowlisted header set (never
// cookie/authorization) and strips set-cookie off the response.
//
// The middleware matcher excludes /ingest, so no Supabase auth work runs
// here. Helpers live in lib/analytics/ingest-proxy.ts (route files may only
// export HTTP methods) — see them for the fixed-host / allowlist details.

function relayResponse(upstream: Response, body: ArrayBuffer): NextResponse {
  const headers = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new NextResponse(body, { status: upstream.status, headers });
}

async function proxy(request: Request, pathSegments: string[]): Promise<NextResponse> {
  const url = new URL(request.url);
  const target = posthogTargetUrl(pathSegments, url.search);
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

  try {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(target, {
      method: request.method,
      headers: buildForwardHeaders(request.headers, clientIp),
      body: hasBody ? await request.arrayBuffer() : undefined,
      // Analytics latency must never hold a connection forever.
      signal: AbortSignal.timeout(10_000),
    });
    return relayResponse(upstream, await upstream.arrayBuffer());
  } catch {
    // Analytics is best-effort — a proxy failure must never surface to the
    // caller as anything actionable, and posthog-js retries batches itself.
    return new NextResponse(null, { status: 502 });
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(request: Request, context: RouteContext) {
  const { path } = await context.params;
  return proxy(request, path);
}
