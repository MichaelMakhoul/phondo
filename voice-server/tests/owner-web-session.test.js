"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isOwnerWebToken,
  ownerWebCallSid,
  buildOwnerWebPrompt,
  createOwnerWebSessions,
  finishOwnerWebSession,
} = require("../lib/owner-web-session");
const { buildOwnerPrompt } = require("../lib/owner-prompt");

// SCRUM-596: the owner assistant in the dashboard — the owner talks to it in the
// browser (/ws/test) after logging in; the login replaces the phone line's PIN.

describe("isOwnerWebToken", () => {
  it("only a token whose mode is exactly 'owner'", () => {
    assert.equal(isOwnerWebToken({ mode: "owner", organizationId: "o1" }), true);
    for (const t of [null, undefined, {}, { mode: "Owner" }, { mode: "owner " }, { mode: true }, { owner: true }, "owner"]) {
      assert.equal(isOwnerWebToken(t), false, JSON.stringify(t));
    }
  });
});

describe("ownerWebCallSid", () => {
  it("names the session after its token id, keeping only safe characters", () => {
    assert.equal(ownerWebCallSid("3f2a9c1e-0b5d-4c4e-9a7f-1d2e3f4a5b6c"), "web_owner_3f2a9c1e-0b5d-4c4e-9a7f-1d2e3f4a5b6c");
    assert.equal(ownerWebCallSid("a/b c;d"), "web_owner_abcd");
    assert.equal(ownerWebCallSid("x".repeat(80)), `web_owner_${"x".repeat(36)}`);
  });

  it("without a usable token id it falls back to a timestamp", () => {
    for (const v of [undefined, null, "", "///"]) assert.match(ownerWebCallSid(v), /^web_owner_t\d+$/, String(v));
  });
});

describe("buildOwnerWebPrompt", () => {
  const organization = { name: "Copperline Plumbing", timezone: "Australia/Sydney" };
  // Sun 25 Oct 2026 16:36 UTC = Mon 26 Oct 03:36 in Sydney (AEDT).
  const now = new Date(Date.UTC(2026, 9, 25, 16, 36));

  it("the phone line's owner prompt, dated in the org's own timezone, with the owner signed in to the dashboard", () => {
    const { systemPrompt, greeting } = buildOwnerWebPrompt({ organization, serviceTypes: [], ownerFirstName: "Michael", now });
    assert.match(systemPrompt, /You are the private assistant for Copperline Plumbing\. You are speaking with Michael, who is signed in to the business's Phondo dashboard\./);
    assert.ok(!systemPrompt.includes("PIN"), "no PIN on the web");
    assert.match(systemPrompt, /Today is Monday 2026-10-26 \(Australia\/Sydney\)/);
    assert.equal(greeting, "Hi Michael, what do you need?");
  });

  it("a malformed timezone falls back to Sydney, as on the phone line", (t) => {
    t.mock.method(console, "warn", () => {});
    const { systemPrompt } = buildOwnerWebPrompt({ organization: { name: "X", timezone: "AEST" }, serviceTypes: [], ownerFirstName: null, now });
    assert.match(systemPrompt, /Today is Monday 2026-10-26 \(Australia\/Sydney\)/);
  });

  it("a missing timezone is Sydney; a missing first name greets 'there'", () => {
    const { systemPrompt, greeting } = buildOwnerWebPrompt({ organization: { name: "X" }, serviceTypes: [], ownerFirstName: null, now });
    assert.match(systemPrompt, /\(Australia\/Sydney\)/);
    assert.equal(greeting, "Hi there, what do you need?");
  });

  it("service types reach the prompt", () => {
    const { systemPrompt } = buildOwnerWebPrompt({ organization, serviceTypes: [{ id: "st1", name: "Blocked drain", duration_minutes: 60 }], ownerFirstName: "Michael", now });
    assert.match(systemPrompt, /SERVICE TYPES[^\n]*Blocked drain/);
  });

  it("the phone line's prompt is unchanged", () => {
    const phone = buildOwnerPrompt({ orgName: "Copperline Plumbing", ownerFirstName: "Michael", timezone: "Australia/Sydney", todayStr: "2026-10-26" });
    assert.match(phone, /who has verified their identity with a PIN\./);
  });
});

describe("createOwnerWebSessions (one browser session per org)", () => {
  it("a second session for the same org is refused until the first closes; other orgs are independent", () => {
    const gate = createOwnerWebSessions();
    assert.equal(gate.tryOpen("org-1"), true);
    assert.equal(gate.tryOpen("org-1"), false);
    assert.equal(gate.tryOpen("org-2"), true);
    gate.close("org-1");
    assert.equal(gate.tryOpen("org-1"), true);
  });

  it("closing an org that isn't open is harmless", () => {
    const gate = createOwnerWebSessions();
    gate.close("org-9");
    assert.equal(gate.tryOpen("org-9"), true);
  });
});

/** A session the way /ws/test leaves it at the end of an owner web session. */
function ownerSession(over = {}) {
  return {
    ownerMode: true,
    ownerAuth: "verified",
    ownerFirstName: "Michael",
    callRecordId: "call-1",
    callSid: "web_owner_abc",
    organizationId: "org-1",
    assistantId: "asst-1",
    piiRedactionEnabled: false,
    toolCallAudit: [{ name: "owner_cancel_appointment", successful: true, at: 1, ownerDetail: "Cancelled Bob Lee's job." }],
    ...over,
  };
}

function makeDeps(over = {}) {
  const calls = [];
  const deps = {
    settleOwnerToolRuns: async (s) => { calls.push(["settle", s.callSid]); },
    buildOwnerCallSummary: (audit) => { calls.push(["summary", audit.length]); return "Owner call: Cancelled Bob Lee's job."; },
    detectAndRedact: (text) => { calls.push(["redact", text]); return { piiFound: true, redacted: `[R]${text}` }; },
    completeCallRecord: async (id, fields) => { calls.push(["complete", id, fields]); },
    notifyCallCompleted: async (url, secret, payload) => { calls.push(["notify", url, secret, payload]); },
    internalApiUrl: "http://next.internal",
    internalApiSecret: "secret",
    sleep: async (ms) => { calls.push(["sleep", ms]); },
    ...over,
  };
  return { deps, calls };
}

describe("finishOwnerWebSession (the phone line's owner post-call, for the browser)", () => {
  it("settles the tool calls, builds the summary, writes the owner row, then notifies", async () => {
    const { deps, calls } = makeDeps();
    const res = await finishOwnerWebSession(ownerSession(), { transcript: "User: cancel Bob\nAI: Done.", durationSeconds: 42 }, deps);
    assert.deepEqual(res, { recordWritten: true });
    assert.deepEqual(calls.map((c) => c[0]), ["settle", "summary", "complete", "notify"]);
    const [, id, fields] = calls.find((c) => c[0] === "complete");
    assert.equal(id, "call-1");
    assert.deepEqual(fields, {
      status: "completed",
      durationSeconds: 42,
      transcript: "User: cancel Bob\nAI: Done.",
      summary: "Owner call: Cancelled Bob Lee's job.",
      callerName: "Michael",
      actionTaken: "owner_call",
      callType: "owner",
      ownerAuth: "verified",
      channel: "web",
      piiRedacted: false,
    });
    const [, url, secret, payload] = calls.find((c) => c[0] === "notify");
    assert.equal(url, "http://next.internal");
    assert.equal(secret, "secret");
    assert.deepEqual(payload, {
      callId: "call-1",
      organizationId: "org-1",
      assistantId: "asst-1",
      callerPhone: null,
      status: "completed",
      durationSeconds: 42,
      transcript: "User: cancel Bob\nAI: Done.",
      endedReason: "web-session-ended",
      callType: "owner",
      ownerAuth: "verified",
    });
  });

  it("an owner with no first name is logged as 'Owner'", async () => {
    const { deps, calls } = makeDeps();
    await finishOwnerWebSession(ownerSession({ ownerFirstName: null }), { transcript: "x", durationSeconds: 3 }, deps);
    assert.equal(calls.find((c) => c[0] === "complete")[2].callerName, "Owner");
  });

  it("with the org's PII redaction on, the transcript and the summary are redacted before they are stored", async () => {
    const { deps, calls } = makeDeps();
    await finishOwnerWebSession(ownerSession({ piiRedactionEnabled: true }), { transcript: "T", durationSeconds: 5 }, deps);
    const fields = calls.find((c) => c[0] === "complete")[2];
    assert.equal(fields.transcript, "[R]T");
    assert.equal(fields.summary, "[R]Owner call: Cancelled Bob Lee's job.");
    assert.equal(fields.piiRedacted, true);
    assert.equal(calls.find((c) => c[0] === "notify")[3].transcript, "[R]T", "the webhook gets the redacted transcript too");
  });

  it("redaction that finds nothing leaves the text and the flag alone", async () => {
    const { deps, calls } = makeDeps({ detectAndRedact: (text) => ({ piiFound: false, redacted: text }) });
    await finishOwnerWebSession(ownerSession({ piiRedactionEnabled: true }), { transcript: "T", durationSeconds: 5 }, deps);
    const fields = calls.find((c) => c[0] === "complete")[2];
    assert.equal(fields.transcript, "T");
    assert.equal(fields.piiRedacted, false);
  });

  it("a failed write is retried once after a second, and then notifies", async (t) => {
    t.mock.method(console, "error", () => {});
    let attempts = 0;
    const { deps, calls } = makeDeps({
      completeCallRecord: async (id, fields) => {
        attempts++;
        calls.push(["complete", id, fields]);
        if (attempts === 1) throw new Error("connection reset");
      },
    });
    const res = await finishOwnerWebSession(ownerSession(), { transcript: "x", durationSeconds: 3 }, deps);
    assert.deepEqual(res, { recordWritten: true });
    assert.deepEqual(calls.map((c) => c[0]), ["settle", "summary", "complete", "sleep", "complete", "notify"]);
    assert.equal(calls.find((c) => c[0] === "sleep")[1], 1000);
  });

  it("a row still not written after the retry pages and skips the webhook (it would be read as a customer call)", async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
    const { deps, calls } = makeDeps({ completeCallRecord: async () => { throw new Error("db down"); } });
    const res = await finishOwnerWebSession(ownerSession(), { transcript: "x", durationSeconds: 3 }, deps);
    assert.deepEqual(res, { recordWritten: false });
    assert.ok(!calls.some((c) => c[0] === "notify"));
    assert.ok(errors.some((e) => e.startsWith("[ALERT:error] [OwnerWeb] owner web session record not written — call-completed webhook skipped (callSid=web_owner_abc, callId=call-1, org=org-1)")), errors.join("\n"));
  });

  it("no call record (it was never created): nothing to write, a warning, no webhook", async (t) => {
    const warned = [];
    t.mock.method(console, "warn", (...a) => warned.push(a.join(" ")));
    const { deps, calls } = makeDeps();
    const res = await finishOwnerWebSession(ownerSession({ callRecordId: null }), { transcript: "x", durationSeconds: 3 }, deps);
    assert.deepEqual(res, { recordWritten: false });
    assert.deepEqual(calls.map((c) => c[0]), ["settle"]);
    assert.ok(warned.some((w) => w.includes("[OwnerWeb] no call record for web_owner_abc")), warned.join("\n"));
  });

  it("without the internal API settings the row is still written, and no webhook is sent", async () => {
    const { deps, calls } = makeDeps({ internalApiUrl: "", internalApiSecret: "" });
    const res = await finishOwnerWebSession(ownerSession(), { transcript: "x", durationSeconds: 3 }, deps);
    assert.deepEqual(res, { recordWritten: true });
    assert.ok(!calls.some((c) => c[0] === "notify"));
  });

  it("a webhook that rejects is logged, never thrown", async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...a) => errors.push(a.join(" ")));
    const { deps } = makeDeps({ notifyCallCompleted: async () => { throw new Error("next down"); } });
    await finishOwnerWebSession(ownerSession(), { transcript: "x", durationSeconds: 3 }, deps);
    await new Promise((r) => setImmediate(r));
    assert.ok(errors.some((e) => e.includes("[OwnerWeb] Failed to notify call completed")), errors.join("\n"));
  });
});

describe("createOwnerTokenLedger (an owner token works once)", () => {
  const { createOwnerTokenLedger, OWNER_WEB_MAX_SESSION_MS } = require("../lib/owner-web-session");

  it("a jti is refused a second time until its token expires, then forgotten", () => {
    const ledger = createOwnerTokenLedger();
    assert.equal(ledger.claim("jti-1", 2_000, 1_000), true);
    assert.equal(ledger.claim("jti-1", 2_000, 1_500), false, "reused before expiry");
    assert.equal(ledger.claim("jti-2", 2_000, 1_500), true, "another token is unaffected");
    assert.equal(ledger.claim("jti-1", 2_000, 2_000), false, "still refused AT the expiry millisecond (/ws/test accepts now <= exp)");
    assert.equal(ledger.claim("jti-1", 3_000, 2_001), true, "expired: the entry is purged (the token itself is rejected as expired anyway)");
  });

  it("no jti (or not a string) is refused", () => {
    const ledger = createOwnerTokenLedger();
    for (const jti of [undefined, null, "", 42, {}]) assert.equal(ledger.claim(jti, 2_000, 1_000), false, JSON.stringify(jti));
  });

  it("a token with no usable expiry is kept for the longest session", () => {
    const ledger = createOwnerTokenLedger();
    assert.equal(ledger.claim("jti-1", undefined, 1_000), true);
    assert.equal(ledger.claim("jti-1", undefined, 1_000 + OWNER_WEB_MAX_SESSION_MS - 1), false);
    assert.equal(ledger.claim("jti-1", undefined, 1_000 + OWNER_WEB_MAX_SESSION_MS), false);
    assert.equal(ledger.claim("jti-1", undefined, 1_000 + OWNER_WEB_MAX_SESSION_MS + 1), true);
  });
});

describe("the owner row's metadata and session length", () => {
  const { OWNER_WEB_RECORD_METADATA, OWNER_WEB_MAX_SESSION_MS } = require("../lib/owner-web-session");

  it("the row is an owner call from the web from the moment it is created", () => {
    assert.deepEqual({ ...OWNER_WEB_RECORD_METADATA }, { call_type: "owner", owner_auth: "verified", channel: "web" });
    assert.ok(Object.isFrozen(OWNER_WEB_RECORD_METADATA));
  });

  it("a session lasts up to 8 minutes: under Gemini Live's ~10-minute connection lifetime", () => {
    assert.equal(OWNER_WEB_MAX_SESSION_MS, 480_000);
  });
});

describe("finishOwnerWebSession: a session that broke", () => {
  it("is stored and reported as failed, not completed", async () => {
    const { deps, calls } = makeDeps();
    await finishOwnerWebSession(ownerSession({ callFailed: true }), { transcript: "x", durationSeconds: 3 }, deps);
    assert.equal(calls.find((c) => c[0] === "complete")[2].status, "failed");
    assert.equal(calls.find((c) => c[0] === "notify")[3].status, "failed");
  });
});
