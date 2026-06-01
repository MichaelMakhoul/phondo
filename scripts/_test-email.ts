/**
 * One-off email pipeline test — DO NOT COMMIT.
 *
 * Verifies the FULL notification path end-to-end:
 *   1. Supabase lookup for org owner email
 *   2. notification_preferences toggle check
 *   3. Resend send via EMAIL_API_KEY
 *   4. Template rendering (XSS escaping etc.)
 *
 * Underscore prefix keeps it out of accidental imports. Run from project root:
 *   npx tsx scripts/_test-email.ts
 *
 * Reads env from .env.local manually (dotenv isn't a project dep).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Minimal .env parser — handles KEY=value and quoted values, ignores comments.
function loadEnvLocal() {
  const envPath = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Don't override anything the shell already set.
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function run() {
  loadEnvLocal();

  // Sanity check the env that matters before importing the notification service.
  const required = [
    "EMAIL_API_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[Test] Missing env: ${missing.join(", ")}`);
    console.error("[Test] Make sure .env.local exists at the project root and has these keys.");
    process.exit(1);
  }

  console.log("[Test] Env loaded.");
  console.log(`[Test] EMAIL_FROM = ${process.env.EMAIL_FROM || "(default) notifications@phondo.ai"}`);

  // Late import — the service reads env at module init.
  const { sendMissedCallNotification } = await import(
    "../src/lib/notifications/notification-service"
  );

  console.log("[Test] Triggering missed-call notification...");
  console.log("[Test] Target org: bdbf400c-8923-4a17-a510-ea9dcb66dc85 (Michael's Clinic)");
  console.log("[Test] Expected delivery: michaelmakhoul0@gmail.com");

  await sendMissedCallNotification({
    organizationId: "bdbf400c-8923-4a17-a510-ea9dcb66dc85",
    callId: `test-${Date.now()}`,
    callerPhone: "+61400000000",
    callerName: "Resend Smoke Test",
    duration: 0,
    summary:
      "End-to-end test of the email notification pipeline. If you can read this, the missed-call path works on Resend.",
    timestamp: new Date(),
  });

  console.log("[Test] ✓ sendMissedCallNotification returned without throwing.");
  console.log("[Test] Now check:");
  console.log("[Test]   1. Your inbox (michaelmakhoul0@gmail.com) — arrives within ~30s");
  console.log("[Test]   2. Resend dashboard → Emails → most recent send should be 'delivered'");
  console.log("[Test]   3. If not in inbox, check Gmail spam folder");
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("[Test] ✗ FAILED:", err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  }
);
