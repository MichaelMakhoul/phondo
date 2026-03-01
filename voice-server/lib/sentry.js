const Sentry = require("@sentry/node");

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
    });
    console.log("[Sentry] Initialized");
  } catch (err) {
    console.error("[Sentry] Failed to initialize:", err);
  }
}

module.exports = { initSentry, Sentry };
