import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "@/lib/observability/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  // SCRUM-312: never auto-attach IP/cookies/headers, and run the PII
  // scrubber over every event before it leaves the process.
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
});
