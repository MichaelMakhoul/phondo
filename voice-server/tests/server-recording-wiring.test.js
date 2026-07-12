const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * SCRUM-212 — source-pin tests for the recording-webhook wiring in
 * server.js (same idiom as server-sentry-sites.test.js: the routes are
 * attached inside a 4000-line Express monolith that can't be required
 * without live env, so we pin the source text instead).
 *
 * What these guard against: the webhook path is constructed at THREE
 * independent sites (voicemail deps, ring-first <Connect>, REST
 * recording start). A typo or drift at any one site makes Twilio POST
 * to a 404 and the system silently degrades to the raw-URL flow — the
 * dashboard 401s on playback, which is exactly the bug SCRUM-212
 * exists to fix. The guarded fallback prevents data loss, so nothing
 * else would ever surface the drift.
 */

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

describe("SCRUM-212: recording webhook wiring in server.js", () => {
  it("all recording-webhook URL sites agree on the path", () => {
    const hits = src.match(/\/api\/webhooks\/twilio-recording-done/g) || [];
    assert.ok(
      hits.length >= 3,
      `expected ≥3 sites (voicemail deps, ring-first <Connect>, REST recording start), got ${hits.length}`,
    );
  });

  it("makeKillSwitchDeps builds recordingStatusCallbackUrl from APP_PUBLIC_URL, null when unset", () => {
    assert.match(
      src,
      /recordingStatusCallbackUrl:\s*APP_PUBLIC_URL\s*\?\s*`\$\{APP_PUBLIC_URL\}\/api\/webhooks\/twilio-recording-done`\s*:\s*null/,
    );
  });

  it("/twiml/ai-disabled-recording-done delegates behind signature validation, wrapped so a deps-construction throw can never crash the process", () => {
    const start = src.indexOf('app.post("/twiml/ai-disabled-recording-done"');
    assert.ok(start > -1, "route not found");
    const body = src.slice(start, src.indexOf("\napp.", start + 1));
    assert.match(body, /validateTwilioSignature\(req\)/);
    // The delegation must sit inside a try{} — an async throw from
    // makeKillSwitchDeps (e.g. getSupabase on missing env) would become
    // an unhandledRejection and process.exit(1) mid-call otherwise.
    assert.match(
      body,
      /try\s*\{\s*await killSwitch\.handleVoicemailRecordingDone\(req,\s*res,\s*\{\s*deps:\s*makeKillSwitchDeps\(\)\s*\}\s*\);?\s*\}\s*catch/,
    );
    // And the catch still owes the caller the goodbye TwiML.
    assert.match(body, /Thank you for your message\. Goodbye\./);
    assert.match(body, /headersSent/);
  });

  it("boot-time page when APP_PUBLIC_URL is unset (recording storage silently disabled otherwise)", () => {
    assert.match(
      src,
      /\[ALERT:error\] \[voice-server\] APP_PUBLIC_URL not set/,
    );
  });
});
