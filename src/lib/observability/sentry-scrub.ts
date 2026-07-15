import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/**
 * PII scrubber for the Next.js Sentry `beforeSend` hook.
 *
 * SCRUM-312: the Next.js Sentry config previously had NO scrubber, so
 * anything a `pageSentry` caller put in `extras` — or that Sentry's
 * default integrations auto-attach (request body, cookies, breadcrumbs
 * with fetch URLs, user email) — would land verbatim in Sentry if a DSN
 * were configured. Phondo is AU data-sovereignty-sensitive and Sentry is
 * US/EU-hosted, so PII must be stripped before transport.
 *
 * This started as a port of the voice-server scrubber
 * (`voice-server/lib/sentry.js`), but the voice-server's "Sentry" is an
 * inert Loki shim that never auto-collects breadcrumbs / query strings /
 * contexts. The real `@sentry/nextjs` SDK does, so this version also
 * scrubs those live-SDK channels and is wrapped fail-closed (a scrubber
 * bug must never let an UNSCRUBBED event through, nor throw — a throw
 * makes Sentry drop the real event and re-capture our exception on a
 * path that bypasses `beforeSend`). Keep the shared field patterns in
 * sync with the voice-server when they change.
 */

// PII field-name patterns. Mostly mirrors voice-server/lib/sentry.js, but the
// two intentionally diverge on `payload`: the voice-server shim WANTS the raw
// diagnostic payload in its Loki alert, whereas the real @sentry/nextjs SDK
// auto-serialises error-internal props to a US/EU-hosted backend, so we scrub.
const PII_FIELD_PATTERNS: RegExp[] = [
  /phone/i, /email/i, /address/i, /transcript/i,
  /^to$/i, /^from$/i, /transferTo/i, /callerPhone/i,
  /attendeeName/i, /attendee_name/i, /firstName/i, /first_name/i,
  /lastName/i, /last_name/i, /^name$/i, /ruleName/i,
  /dob/i, /dateOfBirth/i, /responseBody/i, /responseContent/i,
  // SCRUM-546: Sentry's ExtraErrorData integration serialises non-standard
  // error props. A StripeSignatureVerificationError carries the raw signed
  // webhook body (customer PII) under `err.detail.payload` + `err.detail.header`.
  // Scrub the whole `detail` subtree (anchored, like `^to$`/`^name$`, so benign
  // keys like `orderDetails` are untouched) and any `payload` (distinctive —
  // always a body-carrier, matched broadly) as a belt-and-suspenders net.
  /payload/i, /^detail$/i, /^header$/i,
];

export function isPiiKey(key: string): boolean {
  return PII_FIELD_PATTERNS.some((p) => p.test(key));
}

const MAX_STRING_LEN = 200;
const DEPTH_CAP = 5;
/** Returned when recursion exceeds DEPTH_CAP. A SENTINEL (not the raw
 *  value) so deeply-nested PII fails CLOSED, and so a cyclic object
 *  terminates without leaking its contents. */
const DEPTH_CAPPED_SENTINEL = "[depth-capped]";

/**
 * Recursively scrub a value: PII-named keys become "[scrubbed]", long
 * strings truncate to 200 chars, nested objects/arrays recurse. Past
 * DEPTH_CAP the value is replaced with a sentinel (fail-closed), which
 * also bounds cyclic shapes.
 */
export function scrubObject(obj: unknown, depth = 0): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (depth > DEPTH_CAP) return DEPTH_CAPPED_SENTINEL;
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v, depth + 1));
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isPiiKey(key)) {
      scrubbed[key] = "[scrubbed]";
    } else if (typeof value === "object" && value !== null) {
      scrubbed[key] = scrubObject(value, depth + 1);
    } else if (typeof value === "string" && value.length > MAX_STRING_LEN) {
      scrubbed[key] = value.slice(0, MAX_STRING_LEN) + "...[truncated]";
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

/** Headers stripped entirely — secrets + session credentials. */
const SENSITIVE_HEADER_NAMES = new Set([
  "x-internal-secret",
  "authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
]);

/** Drop the query string from a URL (a classic ?email=…&phone=… carrier). */
function stripQueryString(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function scrubInternal(event: ErrorEvent): ErrorEvent {
  // user.id is safe to keep (UUID); email/username/ip_address are PII.
  if (event.user && typeof event.user === "object" && !Array.isArray(event.user)) {
    const { id } = event.user;
    event.user = id !== undefined ? { id } : {};
  }

  // request: drop the raw body + cookies + query string entirely, strip
  // the query off the URL, and remove sensitive headers.
  if (event.request && typeof event.request === "object" && !Array.isArray(event.request)) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (typeof event.request.url === "string") {
      event.request.url = stripQueryString(event.request.url);
    }
    const headers = event.request.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      for (const k of Object.keys(headers)) {
        if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) {
          delete headers[k];
        }
      }
    }
  }

  // extra = pageSentry's `extras`; contexts = setContext + auto device/os.
  if (event.extra && typeof event.extra === "object" && !Array.isArray(event.extra)) {
    event.extra = scrubObject(event.extra) as Record<string, unknown>;
  }
  if (event.contexts && typeof event.contexts === "object" && !Array.isArray(event.contexts)) {
    event.contexts = scrubObject(event.contexts) as typeof event.contexts;
  }

  // breadcrumbs: the SDK auto-records fetch/xhr (URLs incl. query),
  // console, and ui.input crumbs. Strip query strings off crumb URLs,
  // scrub the structured `data`, and truncate free-text messages.
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (!crumb || typeof crumb !== "object") continue;
      if (typeof crumb.message === "string" && crumb.message.length > MAX_STRING_LEN) {
        crumb.message = crumb.message.slice(0, MAX_STRING_LEN) + "...[truncated]";
      }
      if (crumb.data && typeof crumb.data === "object" && !Array.isArray(crumb.data)) {
        if (typeof crumb.data.url === "string") {
          crumb.data.url = stripQueryString(crumb.data.url);
        }
        crumb.data = scrubObject(crumb.data) as Record<string, unknown>;
      }
    }
  }

  return event;
}

/**
 * Sentry `beforeSend` hook. Scrubs PII in place and returns the event.
 *
 * Wrapped fail-closed: if scrubbing throws on an exotic event shape, we
 * must NOT (a) throw — Sentry would drop the original event and
 * re-capture our exception on a path that skips `beforeSend`, possibly
 * leaking — nor (b) return the raw event. Instead we return a minimal
 * envelope (ids + level + exception TYPE only, never values/messages)
 * tagged `scrubber_failed` so the alert still fires and on-call can grep
 * Loki for the failure, without leaking the unscrubbed payload.
 */
export function scrubSentryEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent {
  if (!event || typeof event !== "object") return event;
  try {
    return scrubInternal(event);
  } catch (scrubErr) {
    console.error(
      "[sentry-scrub] scrub_failed — emitting minimal fail-closed event:",
      scrubErr instanceof Error ? scrubErr.message : scrubErr,
    );
    try {
      // buildFailClosedEvent reads a few fields off `event`. If those
      // fields have throwing getters (the same exotic-shape class that
      // broke scrubInternal), this throws too — so it's nested. A throw
      // escaping here would make Sentry drop the event and re-capture
      // our exception on a path that bypasses beforeSend (possible leak).
      return buildFailClosedEvent(event);
    } catch {
      // Last resort: a fully static envelope that touches NOTHING on
      // `event`, so it cannot throw. Sentry generates event_id/timestamp
      // when absent; the tag still lets on-call see the scrubber failed.
      return { type: undefined, tags: { scrubber_failed: "true" } } as ErrorEvent;
    }
  }
}

/** Minimal known-safe event: never carries unscrubbed payload. */
function buildFailClosedEvent(event: ErrorEvent): ErrorEvent {
  const safe: ErrorEvent = {
    // `type: undefined` is the ErrorEvent discriminant (vs TransactionEvent).
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    tags: { scrubber_failed: "true" },
  };
  // Preserve exception TYPES only (class names like "TypeError") — never
  // the value/message (may carry PII) or stacktrace.
  const values = event.exception?.values;
  if (Array.isArray(values)) {
    safe.exception = {
      values: values.map((v) => ({ type: v?.type })),
    };
  }
  return safe;
}
