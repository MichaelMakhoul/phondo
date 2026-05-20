import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/observability/sentry-scrub";

// SCRUM-312: this is the ACTIVE client-side Sentry init under
// @sentry/nextjs v10 (it supersedes the legacy `sentry.client.config.ts`,
// which was removed). The PII scrubber + sendDefaultPii MUST live here or
// browser events ship unscrubbed.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
});
