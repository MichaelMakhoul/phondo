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
  /dob/i, /dateOfBirth/i, /responseBody/i, /responseContent/i,
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
};

function initSentry() {
  console.log("[Sentry] Using structured-log backend (Grafana Loki AU) — all alerts go to logs");
}

module.exports = { initSentry, Sentry, _test: { scrubObject, isPiiKey } };
