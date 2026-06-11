const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Stub env so the dependency graph (call-context → supabase, post-call-analysis,
// tool-executor, etc.) loads without throwing. getSupabase() is lazy, so these
// dummies are never actually used by the pure helpers under test.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

const { _test, handleConversationRelayConnection } = require("../services/conversationrelay");
const {
  crTextFrame, crEndFrame, buildCrTools, parseSetup,
  buildConversationRelayTwiml, buildCriticalRulesSuffix, runGuardedToolCall,
} = _test;

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fakeSession(overrides = {}) {
  return {
    callSid: "CA1", organizationId: "org", assistantId: "a", callRecordId: "c",
    transferRules: [], userPhoneNumber: null, forwardingStatus: null, sourceType: null,
    transferToForwardedNumber: false, organization: { timezone: "UTC" }, callerPhone: "+15550001",
    orgPhoneNumber: "+15550002", telephonyProvider: "twilio", scheduleSnapshot: null,
    behaviors: {}, calendarEnabled: false, serviceTypes: [], language: "en",
    toolCallAudit: [],
    confirmedBookings: overrides.confirmedBookings,
    _cancelOK: overrides._cancelOK ?? true,
    _unfinished: overrides._unfinished ?? false,
    _directive: overrides._directive || "",
    hasUnfinishedBooking() { return this._unfinished; },
    confirmCancel() { return this._cancelOK; },
    registerBookOutcome() { return this._directive; },
    ...overrides,
  };
}

describe("CR frame builders (SCRUM-378)", () => {
  it("crTextFrame normalizes token + last", () => {
    assert.deepEqual(crTextFrame("hi", false), { type: "text", token: "hi", last: false });
    assert.deepEqual(crTextFrame("", true), { type: "text", token: "", last: true });
    assert.deepEqual(crTextFrame(null, true), { type: "text", token: "", last: true });
  });
  it("crEndFrame optionally carries handoffData as a JSON string", () => {
    assert.deepEqual(crEndFrame(), { type: "end" });
    assert.deepEqual(crEndFrame({ a: 1 }), { type: "end", handoffData: '{"a":1}' });
    assert.deepEqual(crEndFrame("raw"), { type: "end", handoffData: "raw" });
  });
});

describe("parseSetup (SCRUM-378)", () => {
  it("pulls callSid/from/to/token from the setup message", () => {
    const p = parseSetup({ type: "setup", callSid: "CA9", from: "+111", to: "+222", customParameters: { auth_token: "abc" } });
    assert.deepEqual(p, { callSid: "CA9", from: "+111", to: "+222", token: "abc" });
  });
  it("falls back to sessionId and tolerates missing params", () => {
    const p = parseSetup({ type: "setup", sessionId: "S1" });
    assert.equal(p.callSid, "S1");
    assert.equal(p.token, null);
  });
});

describe("buildConversationRelayTwiml (SCRUM-378)", () => {
  it("emits safe defaults (Deepgram STT, en-US, no TTS override) + the auth token", () => {
    const xml = buildConversationRelayTwiml({ wsUrl: "wss://x/ws/conversationrelay", token: "tok", escapeXml: esc, env: {} });
    assert.match(xml, /<ConversationRelay /);
    assert.match(xml, /url="wss:\/\/x\/ws\/conversationrelay"/);
    assert.match(xml, /language="en-US"/);
    assert.match(xml, /transcriptionProvider="Deepgram"/);
    assert.match(xml, /<Parameter name="auth_token" value="tok" \/>/);
    assert.doesNotMatch(xml, /ttsProvider/);
    assert.doesNotMatch(xml, /speechModel/);
  });
  it("applies env overrides for the real eval (Arabic + nova-3 + ElevenLabs)", () => {
    const xml = buildConversationRelayTwiml({
      wsUrl: "wss://x", token: "t", escapeXml: esc,
      env: { CR_LANGUAGE: "ar-SA", CR_SPEECH_MODEL: "nova-3-general", CR_TTS_PROVIDER: "ElevenLabs", CR_VOICE: "voiceXYZ" },
    });
    assert.match(xml, /language="ar-SA"/);
    assert.match(xml, /speechModel="nova-3-general"/);
    assert.match(xml, /ttsProvider="ElevenLabs"/);
    assert.match(xml, /voice="voiceXYZ"/);
  });
  it("escapes attribute values", () => {
    const xml = buildConversationRelayTwiml({ wsUrl: 'wss://x?a=1&b=2', token: 't"x', escapeXml: esc, env: {} });
    assert.match(xml, /a=1&amp;b=2/);
    assert.match(xml, /value="t&quot;x"/);
  });
});

describe("buildCrTools gating (SCRUM-378)", () => {
  const names = (tools) => tools.map((t) => t.function.name);
  it("calendar + callback + end_call when scheduling on, no transfer/listServiceTypes", () => {
    const tools = names(buildCrTools(fakeSession({ calendarEnabled: true })));
    assert.ok(tools.includes("book_appointment"));
    assert.ok(tools.includes("reschedule_appointment")); // SCRUM-377 atomic move
    assert.ok(tools.includes("schedule_callback"));
    assert.ok(tools.includes("end_call"));
    assert.ok(!tools.includes("transfer_call"));
    assert.ok(!tools.includes("list_service_types"));
  });
  it("adds list_service_types + transfer_call when serviceTypes + transferRules present", () => {
    const tools = names(buildCrTools(fakeSession({ serviceTypes: [{ id: "s1" }], transferRules: [{ id: "r1" }], behaviors: {} })));
    assert.ok(tools.includes("list_service_types"));
    assert.ok(tools.includes("transfer_call"));
    assert.ok(tools.includes("book_appointment"));
  });
  it("omits transfer_call when behavior disables it", () => {
    const tools = names(buildCrTools(fakeSession({ transferRules: [{ id: "r1" }], behaviors: { transferToHuman: false } })));
    assert.ok(!tools.includes("transfer_call"));
  });
});

describe("buildCriticalRulesSuffix (SCRUM-378)", () => {
  it("includes the no-fabrication invariant + language lock for the caller language", () => {
    const s = buildCriticalRulesSuffix(fakeSession({ language: "ar" }));
    assert.match(s, /NEVER FABRICATE ACTIONS/);
    assert.match(s, /UNDERSTAND BEFORE YOU ACT/); // SCRUM-380: confirm/ask-to-repeat on unclear input
    assert.match(s, /LANGUAGE LOCK/);
    assert.match(s, /Arabic and English/);
    assert.match(s, /not configured a transfer destination/); // no rules + not eligible
  });
  it("switches to the imperative transfer rule when a transfer is available", () => {
    const s = buildCriticalRulesSuffix(fakeSession({ transferRules: [{ id: "r1" }], behaviors: {} }));
    assert.match(s, /call transfer_call immediately/);
  });
});

describe("runGuardedToolCall (SCRUM-378)", () => {
  it("holds cancel_appointment on the first (unconfirmed) request — never executes", async () => {
    const s = fakeSession({ _cancelOK: false });
    let executed = false;
    const out = await runGuardedToolCall(s, { name: "cancel_appointment", args: { phone: "+1", date: "2026-06-10" } },
      { executeToolCall: async () => { executed = true; return { message: "cancelled" }; }, now: () => 1000 });
    assert.equal(out.held, true);
    assert.equal(executed, false);
    assert.match(out.content, /DO NOT CANCEL YET/);
    assert.equal(s.toolCallAudit[0].name, "cancel_appointment_held");
  });

  it("executes cancel once confirmCancel passes", async () => {
    const s = fakeSession({ _cancelOK: true });
    const out = await runGuardedToolCall(s, { name: "cancel_appointment", args: {} },
      { executeToolCall: async () => ({ message: "Your appointment was cancelled." }), now: () => 1 });
    assert.equal(out.held, false);
    assert.match(out.content, /cancelled/);
  });

  it("blocks end_call on an unfinished booking, then allows it after a prior nudge", async () => {
    const s = fakeSession({ _unfinished: true });
    let exec = false;
    const first = await runGuardedToolCall(s, { name: "end_call", args: { reason: "done" } },
      { executeToolCall: async () => { exec = true; return { __endCall: true, message: "bye" }; }, now: () => 1 });
    assert.equal(first.held, true);
    assert.equal(exec, false);
    assert.match(first.content, /CANNOT END CALL YET/);

    const second = await runGuardedToolCall(s, { name: "end_call", args: { reason: "done" } },
      { executeToolCall: async () => ({ __endCall: true, message: "Ending the call. Goodbye." }), now: () => 2 });
    assert.equal(second.held, false);
    assert.equal(second.endCall, true);
  });

  it("blocks a duplicate book of an already-confirmed appointment", async () => {
    const s = fakeSession({ confirmedBookings: new Map([["2026-06-10T14:00|john|doe", { code: "123456" }]]) });
    let exec = false;
    const out = await runGuardedToolCall(s, { name: "book_appointment", args: { datetime: "2026-06-10T14:00", first_name: "John", last_name: "Doe" } },
      { executeToolCall: async () => { exec = true; return { message: "booked" }; }, now: () => 1 });
    assert.equal(out.held, true);
    assert.equal(exec, false);
    assert.match(out.content, /already booked this exact appointment/);
  });

  it("on a successful book: audits success, records the booking, appends the loop directive", async () => {
    const s = fakeSession({ _directive: " [PROCEED-WITH-DETAILS]" });
    const out = await runGuardedToolCall(s, { name: "book_appointment", args: { datetime: "2026-06-10T14:00", first_name: "Jane", last_name: "Roe" } },
      { executeToolCall: async () => ({ message: "You're all set! Your confirmation code is 654321.", success: true }), now: () => 5 });
    assert.equal(out.held, false);
    assert.match(out.content, /all set/);
    assert.match(out.content, /\[PROCEED-WITH-DETAILS\]/);
    const audit = s.toolCallAudit.find((a) => a.name === "book_appointment");
    assert.equal(audit.successful, true);
    assert.ok(s.confirmedBookings.get("2026-06-10T14:00|jane|roe"));
  });

  it("on an availability rejection: audits NOT successful (no fabricated success)", async () => {
    const s = fakeSession();
    const out = await runGuardedToolCall(s, { name: "book_appointment", args: { datetime: "x" } },
      { executeToolCall: async () => ({ message: "That slot is no longer available." }), now: () => 1 });
    assert.equal(out.held, false);
    const audit = s.toolCallAudit.find((a) => a.name === "book_appointment");
    assert.equal(audit.successful, false);
  });

  it("trusts result.success=false even when the message text reads positive (C-1)", async () => {
    const s = fakeSession();
    await runGuardedToolCall(s, { name: "book_appointment", args: { datetime: "2026-06-10T14:00", first_name: "A", last_name: "B" } },
      { executeToolCall: async () => ({ success: false, message: "I have not booked your appointment because the slot is taken." }), now: () => 1 });
    const audit = s.toolCallAudit.find((a) => a.name === "book_appointment");
    assert.equal(audit.successful, false);
    assert.ok(!s.confirmedBookings || s.confirmedBookings.size === 0);
  });

  it("audits a string error result as NOT successful (C-3 — protects hasUnfinishedBooking)", async () => {
    const s = fakeSession();
    await runGuardedToolCall(s, { name: "schedule_callback", args: {} },
      { executeToolCall: async () => "Error: could not reach the scheduling service", now: () => 1 });
    assert.equal(s.toolCallAudit.find((a) => a.name === "schedule_callback").successful, false);
  });

  it("audits a successful string callback result as successful", async () => {
    const s = fakeSession();
    await runGuardedToolCall(s, { name: "schedule_callback", args: {} },
      { executeToolCall: async () => "Thanks, I've noted your details and someone will call you back.", now: () => 1 });
    assert.equal(s.toolCallAudit.find((a) => a.name === "schedule_callback").successful, true);
  });

  it("propagates __endCall for a clean end_call", async () => {
    const s = fakeSession();
    const out = await runGuardedToolCall(s, { name: "end_call", args: { reason: "caller_done" } },
      { executeToolCall: async () => ({ __endCall: true, message: "Ending the call. Goodbye." }), now: () => 1 });
    assert.equal(out.endCall, true);
    assert.equal(out.held, false);
  });
});

// ── SCRUM-443: disclosure marked played only when actually SENT ──────────────

/** Minimal ws double — captures frames; open=false simulates a dead socket. */
function fakeWs({ open = true } = {}) {
  const handlers = {};
  return {
    readyState: open ? 1 : 3, // WebSocket.OPEN : WebSocket.CLOSED
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
    close() {},
    on(event, fn) { handlers[event] = fn; },
    _handlers: handlers,
  };
}

/** Injected deps for a disclosure-required call; consumeStreamToken stays null
 *  (the unit-test fallback path) so setup.to/from are used directly. */
function disclosureDeps(overrides = {}) {
  return {
    loadCallContext: async () => ({
      organizationId: "org1", assistantId: "a1", phoneNumberId: "p1",
      transferRules: [], userPhoneNumber: null, forwardingStatus: null, sourceType: null,
      calendarEnabled: false, serviceTypes: [], telephonyProvider: "twilio",
      isAfterHours: false, afterHoursConfig: null, knowledgeBase: [],
      assistant: { language: "en", promptConfig: {}, settings: {} },
      organization: { name: "Acme Dental", country: "US", businessState: "CA", recordingConsentMode: "auto", recording_disclosure_text: null, timezone: "UTC" },
    }),
    buildSystemPrompt: () => "SYSTEM PROMPT",
    getGreeting: () => "Thanks for calling Acme Dental!",
    createCallRecord: async () => "rec-1",
    requiresRecordingDisclosureHybrid: () => ({ required: true }),
    getRecordingDisclosureText: () => "This call may be recorded for quality purposes.",
    analyzeCallTranscript: async () => null,
    notifyCallCompleted: async () => {},
    internalApiUrl: null,
    internalApiSecret: null,
    ...overrides,
  };
}

/** Runs setup → hangup against the real handler; resolves with the
 *  completeCallRecord fields the pipeline persisted. */
async function runDisclosureCall({ open, deps: depOverrides = {} }) {
  const ws = fakeWs({ open });
  let persisted = null;
  let resolvePersisted;
  const persistedP = new Promise((r) => { resolvePersisted = r; });
  const deps = disclosureDeps({
    completeCallRecord: async (id, fields) => { persisted = { id, fields }; resolvePersisted(); },
    ...depOverrides,
  });
  handleConversationRelayConnection(/** @type {any} */ (ws), {}, deps);
  await ws._handlers.message(JSON.stringify({ type: "setup", callSid: "CA443", from: "+15550001", to: "+15550002" }));
  ws._handlers.close(); // caller hangs up → finalize
  await persistedP;
  return { ws, persisted };
}

describe("CR recording-disclosure timing (SCRUM-443)", () => {
  it("disclosure required + speak succeeds → played=true, failed=false", async () => {
    const { ws, persisted } = await runDisclosureCall({ open: true });
    const textFrames = ws.sent.filter((f) => f.type === "text");
    assert.equal(textFrames.length, 1);
    assert.match(textFrames[0].token, /^This call may be recorded/); // disclosure leads the first message
    assert.equal(persisted.fields.recordingDisclosurePlayed, true);
    assert.equal(persisted.fields.recordingDisclosureFailed, false);
  });

  it("disclosure required but the ws send never happens → played=false, cleanup marks failed", async () => {
    const { ws, persisted } = await runDisclosureCall({ open: false });
    assert.equal(ws.sent.length, 0); // nothing reached Twilio
    assert.equal(persisted.fields.recordingDisclosurePlayed, false);
    assert.equal(persisted.fields.recordingDisclosureFailed, true);
  });

  it("disclosure NOT required → neither flag is set (no false 'failed')", async () => {
    const { persisted } = await runDisclosureCall({
      open: true,
      deps: { requiresRecordingDisclosureHybrid: () => ({ required: false }) },
    });
    assert.equal(persisted.fields.recordingDisclosurePlayed, false);
    assert.equal(persisted.fields.recordingDisclosureFailed, false);
  });
});
