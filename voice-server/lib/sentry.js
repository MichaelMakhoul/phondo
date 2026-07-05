/**
 * Structured-log replacement for Sentry SDK.
 *
 * Grafana Cloud AU (Loki) is our production observability backend.
 * Sentry has no AU region, so instead of sending events to US/EU, we
 * output structured log lines that Grafana alert rules can match on.
 *
 * The API surface is identical to @sentry/node so all existing call
 * sites (Sentry.captureException, Sentry.withScope, etc.) work without
 * changes. The output format is designed for Loki's LogQL queries:
 *
 *   [ALERT:<severity>] [<service>] <message> | key=value key=value
 *
 * Existing Grafana alert rules match on:
 *   - [FATAL] for crash detection
 *   - [ALERT:error] for high-severity issues
 *   - [ALERT:warning] for medium-severity (rebook guard, goodbye loop)
 *   - "Hallucinated booking" for the SCRUM-227 audit
 */

// PII scrubbing — same patterns as the original Sentry module
const PII_FIELD_PATTERNS = [
  /phone/i, /email/i, /address/i, /transcript/i,
  /^to$/i, /^from$/i, /transferTo/i, /callerPhone/i,
  /attendeeName/i, /attendee_name/i, /firstName/i, /first_name/i,
  /lastName/i, /last_name/i, /^name$/i, /ruleName/i,
  /dob/i, /dateOfBirth/i, /date_of_birth/i, /responseBody/i, /responseContent/i,
  // SCRUM-506: never let the per-call collected-details bag (or medicare) leak.
  /collectedDetails/i, /collected_details/i, /medicare/i,
];

function isPiiKey(key) {
  return PII_FIELD_PATTERNS.some((p) => p.test(key));
}

function scrubObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrubObject(v, depth + 1));
  const scrubbed = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isPiiKey(key)) {
      scrubbed[key] = "[scrubbed]";
    } else if (typeof value === "object" && value !== null) {
      scrubbed[key] = scrubObject(value, depth + 1);
    } else if (typeof value === "string" && value.length > 200) {
      scrubbed[key] = value.slice(0, 200) + "...[truncated]";
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

/**
 * Format extras as key=value pairs for structured logging.
 * PII is scrubbed before formatting.
 */
function formatExtras(extras) {
  if (!extras || typeof extras !== "object") return "";
  const scrubbed = scrubObject(extras);
  const pairs = Object.entries(scrubbed)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  return pairs.length > 0 ? ` | ${pairs.join(" ")}` : "";
}

/**
 * Scope object that collects tags and extras, then logs when
 * captureException/captureMessage is called inside withScope.
 */
class StructuredScope {
  constructor() {
    this._tags = {};
    this._extras = {};
    this._level = null;
  }
  setTag(key, value) { this._tags[key] = value; }
  setExtra(key, value) { this._extras[key] = value; }
  setExtras(obj) { Object.assign(this._extras, obj); }
  setLevel(level) { this._level = level; }
  setUser() { /* no-op — PII, don't log */ }
  setContext(name, ctx) { this._extras[name] = ctx; }
}

/**
 * The Sentry-compatible API object. Drop-in replacement.
 */
const Sentry = {
  /**
   * withScope(fn) — execute fn with a scope, then flush the collected
   * tags/extras when captureException/captureMessage is called inside.
   */
  withScope(fn) {
    const scope = new StructuredScope();
    // Patch capture* to use this scope's data
    const origCapture = Sentry._activeScope;
    Sentry._activeScope = scope;
    try {
      fn(scope);
    } finally {
      Sentry._activeScope = origCapture;
    }
  },

  _activeScope: null,

  captureException(err) {
    const scope = Sentry._activeScope || new StructuredScope();
    const service = scope._tags.service || "voice-server";
    const severity = scope._level || "error";
    const message = err instanceof Error ? err.message : String(err);
    const extras = { ...scope._tags, ...scope._extras };
    if (err instanceof Error && err.stack) {
      extras.stack = err.stack.split("\n").slice(0, 3).join(" → ");
    }
    console.error(`[ALERT:${severity}] [${service}] ${message}${formatExtras(extras)}`);
  },

  captureMessage(msg, level = "info") {
    const scope = Sentry._activeScope || new StructuredScope();
    const service = scope._tags.service || "voice-server";
    const severity = scope._level || level;
    const extras = { ...scope._tags, ...scope._extras };
    const logFn = severity === "error" || severity === "fatal" ? console.error
               : severity === "warning" ? console.warn
               : console.log;
    logFn(`[ALERT:${severity}] [${service}] ${msg}${formatExtras(extras)}`);
  },

  // No-ops for SDK methods that don't apply to structured logging
  init() {},
  addBreadcrumb() {},
  configureScope() {},
  setUser() {},
  setTag() {},
  setExtra() {},
  startTransaction() { return { finish() {} }; },

  /**
   * flush() is called by server.js inside uncaughtException / unhandledRejection
   * / SIGTERM handlers via `await Sentry.flush(2000).catch(() => {})`. The
   * structured-log shim writes synchronously to console — there is literally
   * nothing to flush — but the callers expect a Promise. Returning a resolved
   * Promise<true> matches @sentry/node's contract (true = all events flushed
   * within the timeout) so the chained `.catch(() => {})` doesn't throw.
   * Without this method, crash/shutdown handlers throw
   *   TypeError: Sentry.flush is not a function
   * and the original error gets swallowed by the failed cleanup.
   */
  flush(_timeoutMs) {
    return Promise.resolve(true);
  },

  /**
   * close() is the partner of flush() in @sentry/node — used during graceful
   * shutdown to flush + tear down the transport. Same Promise<true> contract.
   * Not used today but listed alongside flush() so future callers don't trip
   * on the same TypeError.
   */
  close(_timeoutMs) {
    return Promise.resolve(true);
  },
};

/**
 * Headers that must always be removed before an event is recorded.
 * Mirrors what the original @sentry/node `beforeSend` hook stripped — secrets
 * and session credentials must never leave the process boundary.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "x-internal-secret",
  "authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
]);

/**
 * Sanitize a Sentry-style event payload before it's emitted.
 *
 * Today the structured-log backend doesn't transport @sentry/node events — it
 * calls captureException/captureMessage directly and writes to stdout. But the
 * helper is still exported via `_test` so:
 *   1. It documents the PII contract that any future real Sentry transport
 *      must honour (the test suite is the canonical spec).
 *   2. If anyone re-wires a real Sentry SDK in the future, they can drop this
 *      function into the `beforeSend` hook and the PII guarantees survive.
 *
 * The function is pure — the input is deep-cloned via structuredClone() up
 * front, so callers can mutate the original event freely afterward without
 * affecting the scrubbed copy (and vice versa). All branches below operate
 * on the clone.
 *
 * structuredClone is available in Node 17+; voice-server runs on Node 20 LTS
 * (verified in voice-server/fly.toml / .github/workflows/ci.yml).
 */
function beforeSendScrubber(event) {
  if (!event || typeof event !== "object") return event;

  // Deep-clone defensively. Sentry events are JSON-shaped (no functions,
  // no class instances, no Buffers), so structuredClone is safe. If a
  // future caller passes something exotic and it throws, we fall back to
  // the JSON round-trip — same effective shape, slightly slower.
  let out;
  try {
    out = structuredClone(event);
  } catch {
    out = JSON.parse(JSON.stringify(event));
  }

  // user.id is safe to keep (UUID, no PII). Everything else on user is PII.
  if (out.user && typeof out.user === "object" && !Array.isArray(out.user)) {
    const { id } = out.user;
    out.user = id !== undefined ? { id } : {};
  }

  // request.data is the raw request body — usually contains caller input.
  // request.cookies are session tokens. Both go entirely.
  if (out.request && typeof out.request === "object" && !Array.isArray(out.request)) {
    delete out.request.data;
    delete out.request.cookies;
    // headers must be a plain object — arrays / null / undefined are skipped.
    if (
      out.request.headers
      && typeof out.request.headers === "object"
      && !Array.isArray(out.request.headers)
    ) {
      for (const k of Object.keys(out.request.headers)) {
        if (SENSITIVE_HEADER_NAMES.has(k.toLowerCase())) {
          delete out.request.headers[k];
        }
      }
    }
  }

  // extra carries developer-attached context — run the field-name scrubber so
  // anything matching PII patterns becomes "[scrubbed]" while safe technical
  // keys (orgId, callSid, httpStatus, etc.) pass through untouched.
  if (out.extra && typeof out.extra === "object" && !Array.isArray(out.extra)) {
    out.extra = scrubObject(out.extra);
  }

  // message + exception + breadcrumbs are kept as-is — they're the actual
  // diagnostic payload we WANT to see in the alert.
  return out;
}

function initSentry() {
  console.log("[Sentry] Using structured-log backend (Grafana Loki AU) — all alerts go to logs");
}

module.exports = { initSentry, Sentry, _test: { scrubObject, isPiiKey, beforeSendScrubber } };
