"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

const { CallSession } = require("../call-session");
const stamps = require("../lib/owner-turn-stamps");
const { noteAssistantSpeech, noteAssistantTurnEnd, noteOwnerSpeech } = stamps;
const { runOwnerToolCall } = require("../lib/owner-tool-runner");

// SCRUM-587 — the clock the owner confirmation gate reads (lib/owner-tool-runner.js
// readBackAnswered). The gate is only as strong as these stamps: a turn counted
// twice expires every read-back, a turn counted on a tool-call-only reply does
// the same, and an utterance stamped twice lets one "ok… thanks" confirm two writes.

function ownerSession() {
  const s = new CallSession("CA-owner");
  s.ownerMode = true;
  s.organizationId = "org-1";
  s.callRecordId = "call-1";
  return s;
}

describe("CallSession declares the confirmation-gate clock (checkJs, fail-closed defaults)", () => {
  it("a new session starts at zero with nothing armed and nothing spoken", () => {
    const s = new CallSession("CA-1");
    assert.equal(s.assistantTurnSeq, 0);
    assert.equal(s.lastAssistantTurnAt, 0);
    assert.equal(s.lastAssistantSpeechAt, 0);
    assert.equal(s.lastOwnerSpeechAt, 0);
    assert.equal(s.assistantTurnHadSpeech, false);
    assert.equal(s.ownerPendingConfirmations, null);
    assert.equal(s.ownerConfirmSpentSpeechAt, null);
  });
});

describe("owner turn stamps", () => {
  it("a turn that produced speech counts once, at its end", () => {
    const s = ownerSession();
    noteAssistantSpeech(s, 900); noteAssistantSpeech(s, 950); noteAssistantSpeech(s, 990); // three audio chunks of one reply
    assert.equal(s.lastAssistantSpeechAt, 990, "the latest assistant audio is stamped");
    assert.equal(s.assistantTurnSeq, 0, "speech alone does not end the turn");
    assert.equal(noteAssistantTurnEnd(s, 1000), true);
    assert.equal(s.assistantTurnSeq, 1);
    assert.equal(s.lastAssistantTurnAt, 1000);
    assert.equal(s.assistantTurnHadSpeech, false, "the turn's speech is spent");
  });

  it("interrupted + turnComplete of the SAME turn count once (Gemini can send both in one serverContent)", () => {
    const s = ownerSession();
    noteAssistantSpeech(s);
    assert.equal(noteAssistantTurnEnd(s, 1000), true, "interrupted");
    assert.equal(noteAssistantTurnEnd(s, 1001), false, "turnComplete of the same turn");
    assert.equal(s.assistantTurnSeq, 1);
    assert.equal(s.lastAssistantTurnAt, 1000, "the second end does not move the stamp");
  });

  it("a tool-call-only turn (no audio, no transcription) is not a turn", () => {
    const s = ownerSession();
    assert.equal(noteAssistantTurnEnd(s, 1000), false);
    assert.equal(s.assistantTurnSeq, 0);
    assert.equal(s.lastAssistantTurnAt, 0);
  });

  it("owner speech: the first fragment after an assistant turn stamps; later fragments of the same utterance don't", () => {
    const s = ownerSession();
    assert.equal(noteOwnerSpeech(s, "ok", 2000), true);
    assert.equal(noteOwnerSpeech(s, " thanks", 2500), false, "same utterance");
    assert.equal(s.lastOwnerSpeechAt, 2000);
    noteAssistantSpeech(s);
    noteAssistantTurnEnd(s, 3000);
    assert.equal(noteOwnerSpeech(s, "yes", 4000), true, "a new utterance after the assistant spoke");
    assert.equal(s.lastOwnerSpeechAt, 4000);
  });

  it("empty or wordless transcripts never stamp; any letter or digit (any script) does", () => {
    for (const text of ["", "   ", "...", "?!", " - ", null, undefined, 42, {}, "<noise>", "[inaudible]", " <noise> [music] ", "<unk>", "[laughter]<noise>"]) {
      const s = ownerSession();
      assert.equal(noteOwnerSpeech(s, text, 2000), false, JSON.stringify(text));
      assert.equal(s.lastOwnerSpeechAt, 0, JSON.stringify(text));
    }
    for (const text of ["5", "yes", "نعم", "是", " ok.", "<noise> yes", "[laughs] ok", "yes <noise>"]) {
      const s = ownerSession();
      assert.equal(noteOwnerSpeech(s, text, 2000), true, text);
      assert.equal(s.lastOwnerSpeechAt, 2000, text);
    }
  });

  it("customer sessions (and no session) are never stamped", () => {
    const s = new CallSession("CA-customer");
    noteAssistantSpeech(s, 500);
    assert.equal(s.lastAssistantSpeechAt, 0);
    assert.equal(noteAssistantTurnEnd(s, 1000), false);
    assert.equal(noteOwnerSpeech(s, "yes", 2000), false);
    assert.equal(s.assistantTurnSeq, 0);
    assert.equal(s.lastAssistantTurnAt, 0);
    assert.equal(s.lastOwnerSpeechAt, 0);
    assert.equal(s.assistantTurnHadSpeech, false);
    for (const nobody of [null, undefined]) {
      assert.doesNotThrow(() => { noteAssistantSpeech(nobody); noteAssistantTurnEnd(nobody); noteOwnerSpeech(nobody, "yes"); });
    }
    // ownerMode must be the boolean true (it only ever comes from the server-side token).
    const truthy = new CallSession("CA-truthy");
    // @ts-ignore -- deliberately the wrong type
    truthy.ownerMode = "true";
    noteAssistantSpeech(truthy);
    assert.equal(noteAssistantTurnEnd(truthy, 1000), false);
  });

  it("the sequence only ever goes up — the module exposes no way to reset it", () => {
    const s = ownerSession();
    let prev = s.assistantTurnSeq;
    for (let i = 1; i <= 25; i++) {
      noteAssistantSpeech(s);
      noteAssistantTurnEnd(s, 1000 + i);
      assert.equal(s.assistantTurnSeq, prev + 1);
      prev = s.assistantTurnSeq;
    }
    assert.deepEqual(Object.keys(stamps).sort(), ["noteAssistantSpeech", "noteAssistantTurnEnd", "noteOwnerSpeech"]);
    const moduleSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "owner-turn-stamps.js"), "utf8");
    const writes = moduleSrc.match(/assistantTurnSeq\s*(?:[-+*/]?=)(?!=)/g) || [];
    assert.deepEqual(writes, ["assistantTurnSeq +="], "the only write is the increment");
  });
});

// ─── The stamps feeding the REAL gate (lib/owner-tool-runner.js) ────────────

const NEEDS_CONFIRMATION = { success: false, message: "Read this back and get a clear yes before cancelling: cancel Bob Lee's job on Friday, October 16 at 3:00 PM.", data: { outcome: "needs_confirmation", appointment_id: "a1", customer_notified: false } };
const CANCELLED = { success: true, message: "Cancelled Bob Lee's job on Friday, October 16 at 3:00 PM. The customer has NOT been notified.", data: { outcome: "cancelled", appointment_id: "a1", customer_notified: false } };

/** Real runner, stub executor: needs_confirmation until a confirmed:true arrives. */
function makeDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      executeToolCall: async (name, args) => {
        calls.push({ name, args });
        return args.confirmed === true ? CANCELLED : NEEDS_CONFIRMATION;
      },
      scheduleCache: { invalidate: () => {} },
    },
  };
}
const cancel = (id, confirmed) => ({ name: "owner_cancel_appointment", args: { appointment_id: id, ...(confirmed === undefined ? {} : { confirmed }) } });
/** server.js stamps with Date.now(); the runner arms with Date.now() too — stay strictly after it. */
let clock = 0;
const later = () => (clock = Math.max(Date.now() + 50, clock + 10));
function assistantTurn(s, { spoke = true, ends = 1 } = {}) {
  if (spoke) noteAssistantSpeech(s, later());
  const at = later();
  for (let i = 0; i < ends; i++) noteAssistantTurnEnd(s, at + i);
}
const ownerSays = (s, text) => noteOwnerSpeech(s, text, later());

async function arm(s, d, id = "a1") {
  const r = await runOwnerToolCall(s, cancel(id), d.deps);
  assert.equal(r.data.outcome, "needs_confirmation", "precondition: PR B handed back a read-back");
}

describe("the stamps drive the real confirmation gate", () => {
  it("arm → read-back (interrupted + turnComplete) → owner 'yes' → the confirm goes through as confirmed:true", async () => {
    const s = ownerSession(); const d = makeDeps();
    assistantTurn(s); // the greeting
    ownerSays(s, "cancel Bob's job");
    await arm(s, d);
    assistantTurn(s, { ends: 2 }); // the read-back, barged in on: interrupted + turnComplete
    ownerSays(s, "yes");
    const r = await runOwnerToolCall(s, cancel("a1", true), d.deps);
    assert.equal(d.calls.at(-1).args.confirmed, true);
    assert.equal(r.data.outcome, "cancelled");
  });

  it("a tool-call-only turn between the arm and the read-back does not expire it (Gemini 3.8 non-blocking calls)", async () => {
    const s = ownerSession(); const d = makeDeps();
    await arm(s, d);
    assistantTurn(s, { spoke: false }); // turnComplete with no audio — just the tool call
    assistantTurn(s); // the read-back
    ownerSays(s, "yep");
    await runOwnerToolCall(s, cancel("a1", true), d.deps);
    assert.equal(d.calls.at(-1).args.confirmed, true);
  });

  it("speech before the read-back ended is no answer (the gate's settle wait gives up after 1500 ms)", async (t) => {
    const s = ownerSession(); const d = makeDeps();
    await arm(s, d);
    ownerSays(s, "yes"); // over the top of the read-back, before it ended
    assistantTurn(s); // the read-back ends after it
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const confirm = runOwnerToolCall(s, cancel("a1", true), d.deps);
    for (let i = 0; i < 16; i++) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(100); }
    await confirm;
    assert.equal(d.calls.at(-1).args.confirmed, false);
  });

  it("a read-back whose only audio came BEFORE the arm (a filler) can't be confirmed", async () => {
    const s = ownerSession(); const d = makeDeps();
    noteAssistantSpeech(s, Date.now() - 1000); // "one moment" — before PR B handed back the read-back
    await arm(s, d);
    noteAssistantTurnEnd(s, later()); // the turn ends with no read-back audio
    ownerSays(s, "hello?");
    await runOwnerToolCall(s, cancel("a1", true), d.deps);
    assert.equal(d.calls.at(-1).args.confirmed, false);
  });

  it("two fragments of ONE utterance confirm at most one write", async () => {
    const s = ownerSession(); const d = makeDeps();
    await arm(s, d, "a1");
    await arm(s, d, "a2"); // both read-backs armed in the same assistant turn
    assistantTurn(s);
    ownerSays(s, "ok");
    ownerSays(s, "thanks"); // same utterance — must not re-stamp
    await runOwnerToolCall(s, cancel("a1", true), d.deps);
    assert.equal(d.calls.at(-1).args.confirmed, true, "the first write is confirmed");
    await runOwnerToolCall(s, cancel("a2", true), d.deps);
    assert.equal(d.calls.at(-1).args.confirmed, false, "the second needs its own yes");
  });

  it("a declined read-back can't be confirmed after the assistant has spoken again", async () => {
    const s = ownerSession(); const d = makeDeps();
    await arm(s, d);
    assistantTurn(s); // the read-back
    ownerSays(s, "no, leave it");
    assistantTurn(s); // "OK, I'll leave it."
    ownerSays(s, "actually yes");
    await runOwnerToolCall(s, cancel("a1", true), d.deps);
    assert.equal(d.calls.at(-1).args.confirmed, false);
  });

  it("the model confirming in the same turn as its read-back is refused (the turn has not ended)", async () => {
    const s = ownerSession(); const d = makeDeps();
    ownerSays(s, "cancel Bob's job");
    await arm(s, d);
    noteAssistantSpeech(s, later()); // read-back audio streaming…
    await runOwnerToolCall(s, cancel("a1", true), d.deps); // …and confirmed:true before the owner could answer
    assert.equal(d.calls.at(-1).args.confirmed, false);
  });
});
