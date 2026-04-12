const Sentry = require("@sentry/node");

/**
 * Defense-in-depth PII scrubbing for error tracking events.
 *
 * Even though we plan to use Grafana Cloud AU for production observability
 * (not Sentry), we keep the Sentry SDK as a generic error-capture wrapper so
 * existing `Sentry.captureException` calls throughout the codebase still
 * work. This scrubber strips PII before any event is sent to ANY backend —
 * so if Sentry DSN is ever set temporarily (dev, debug), customer data is
 * protected.
 */

// Field name patterns that indicate PII — strip these from event data
const PII_FIELD_PATTERNS = [
  /phone/i,
  /email/i,
  /address/i,
  /transcript/i,
  /^to$/i,
  /^from$/i,
  /transferTo/i,
  /callerPhone/i,
  /attendeeName/i,
  /attendee_name/i,
  /firstName/i,
  /first_name/i,
  /lastName/i,
  /last_name/i,
  /^name$/i,
  /ruleName/i,
  /dob/i,
  /dateOfBirth/i,
  /responseBody/i,
  /responseContent/i,
];

// Max length for stringified values — truncate long strings as a safety net
const MAX_VALUE_LENGTH = 200;

function scrubValue(value) {
  if (typeof value !== "string") return value;
  if (value.length > MAX_VALUE_LENGTH) {
    return value.slice(0, MAX_VALUE_LENGTH) + "...[truncated]";
  }
  return value;
}

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
    } else {
      scrubbed[key] = scrubValue(value);
    }
  }
  return scrubbed;
}

function beforeSendScrubber(event) {
  // Scrub extra, contexts, tags, user — anywhere setExtra/setContext/setUser data lives
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);
  if (event.tags) event.tags = scrubObject(event.tags);

  // Never send user PII
  if (event.user) {
    event.user = {
      id: typeof event.user.id === "string" ? event.user.id : undefined,
      // Strip email, username, ip_address
    };
  }

  // Strip request bodies entirely (never needed for error debugging, high PII risk)
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
      delete event.request.headers["x-internal-secret"];
    }
  }

  return event;
}

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[Sentry] No DSN configured, error tracking disabled");
    return;
  }
  try {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV || "production",
      // Defense-in-depth: scrub PII before sending any event
      beforeSend: beforeSendScrubber,
      // Also scrub breadcrumbs (action trail leading to error)
      beforeBreadcrumb: (breadcrumb) => {
        if (breadcrumb.data) breadcrumb.data = scrubObject(breadcrumb.data);
        return breadcrumb;
      },
      // Don't send IP addresses
      sendDefaultPii: false,
    });
    console.log("[Sentry] Initialized (PII scrubbing enabled)");
  } catch (err) {
    console.error("[Sentry] Failed to initialize:", err);
  }
}

module.exports = { initSentry, Sentry, _test: { scrubObject, isPiiKey, beforeSendScrubber } };
