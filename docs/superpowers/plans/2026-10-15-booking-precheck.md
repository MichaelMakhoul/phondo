# Booking pre-check implementation plan (SCRUM-593)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Just before Gemini writes a booking change, Claude Haiku 5.5 checks the details against what the caller said and confirmed. If the check fails, nothing is written and Gemini is told what to confirm. The Tier-2 checker also gets today's date.

**Architecture:**
- A new module, `voice-server/lib/booking-precheck.js`, builds a prompt (the conversation so far, the proposed tool arguments, "now" in the business timezone, and the assistant's name-confirmation method), calls the Anthropic Messages API, and returns proceed or hold. It never throws, and it fails open.
- The server.js glue (`applyBookingPrecheck`) runs it in both Gemini `onToolCall` handlers, right before the write.
- A shared `lib/now-line.js` gives the check, the Tier-2 checker and `get_current_datetime` the same "now" wording.

**Tech Stack:** Node 20, CommonJS, `node:test` + `node:assert/strict`, raw `fetch` to `https://api.anthropic.com/v1/messages` (no SDK, matching `services/turn-validator.js`), and JSDoc types under `npm run typecheck` (checkJs).

**Spec:** `docs/superpowers/specs/2026-10-15-booking-precheck-design.md`

## Global Constraints

- **Branch:** `feature/SCRUM-593-booking-precheck` off `origin/develop`. Commits are named `feat(SCRUM-593): …` / `test(SCRUM-593): …` and end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WsMvFfmjCv3mhYEfJW5MQB
  ```
- **Scope of the check:** the Gemini paths only (production inbound and `/ws/test`). Classic pipeline untouched. Owner calls never reach it.
- **Checked tools:** exactly `book_appointment`, `reschedule_appointment`, `update_appointment`.
- **Failure behaviour:** fail-open. Any error, timeout (3000 ms), missing key or unreadable reply means the write proceeds. The module never throws.
- **Hold cap:** `MAX_HOLDS = 2` per (call, tool). The third attempt goes through, with a warning. A successful write resets the count.
- **Environment:**
  - `PRECHECK_MODE` = `enforce` (default) | `shadow` | `off`.
  - `PRECHECK_MODEL` defaults to `claude-haiku-5-5`. Haiku runs with thinking disabled; any other model runs at `output_config.effort: "low"`.
- **Logging (SCRUM-339):** no caller words, no tool argument values and no model instruction text in logs, unless `DEBUG_TRANSCRIPTS`. Problem codes, tool names, timings and callSid are fine.
- **Alerts:** a config failure (400/401/403/404, missing key) raises `[ALERT:error]` at once. Any other unreadable verdict raises `[ALERT:error]` from the 3rd in a row (the same contract as `services/turn-validator.js`).
- **Verification:** `cd voice-server && npm test` and `npm run typecheck` must pass. Each new test must FAIL with its line of the fix removed (mutation bar).

---

## File map

| File | Change |
|---|---|
| `voice-server/lib/now-line.js` | **New.** `nowLine(timezone, now?)` gives the exact `get_current_datetime` wording |
| `voice-server/lib/model-params.js` | Add `readAnthropicError(res)` (moved from turn-validator) |
| `voice-server/services/tool-executor.js` | `resolveCurrentDatetime` uses `nowLine` |
| `voice-server/services/turn-validator.js` | Takes `timezone`; prompt gains a NOW line and the relative-date rule; uses `readAnthropicError` |
| `voice-server/lib/booking-precheck.js` | **New.** The check itself, plus the `applyBookingPrecheck` glue |
| `voice-server/call-session.js` | `this.precheckHolds = new Map()` |
| `voice-server/server.js` | Wiring in both Gemini `onToolCall` handlers; reset on success; Tier-2 call site passes the timezone |
| `voice-server/.env.example` | `PRECHECK_MODE`, `PRECHECK_MODEL` |
| `voice-server/tests/now-line.test.js` | **New** |
| `voice-server/tests/turn-validator.test.js` | Add NOW-line tests |
| `voice-server/tests/booking-precheck.test.js` | **New** |
| `voice-server/tests/server-booking-precheck-wiring.test.js` | **New.** Source pins |

---

### Task 1: The shared "now" line, and the Tier-2 checker gets today's date

**Files:**
- Create: `voice-server/lib/now-line.js`, `voice-server/tests/now-line.test.js`
- Modify:
  - `voice-server/lib/model-params.js` (exports, end of file)
  - `voice-server/services/tool-executor.js:459-484` (`resolveCurrentDatetime`)
  - `voice-server/services/turn-validator.js` (imports, `readApiError` at ~96-107, the prompt at ~173-189, JSDoc at ~138-145)
  - `voice-server/server.js:3118-3122` (Tier-2 call site)
- Test: `voice-server/tests/turn-validator.test.js` (append)

**Interfaces:**
- Produces:
  - `nowLine(timezone: string, now?: Date): string`
  - `readAnthropicError(res: { json: () => Promise<unknown> }): Promise<{ errorType?: string, errorMessage?: string }>`, exported from `lib/model-params.js`
  - `validateToolResponse({ toolName, toolResult, spokenResponse, timezone? })`, with `timezone` defaulting to `"Australia/Sydney"`

- [ ] **Step 1: Write the failing tests**

Create `voice-server/tests/now-line.test.js`:

```js
"use strict";

// SCRUM-593 — one "now" wording for get_current_datetime, the Tier-2 checker
// and the booking pre-check, so all three resolve "today"/"tomorrow" alike.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { nowLine } = require("../lib/now-line");
const { _test } = require("../services/tool-executor");

describe("nowLine", () => {
  it("words the business's local date and time like get_current_datetime", () => {
    // 2026-10-14T10:56Z = Wednesday 9:56 PM in Sydney (AEDT, UTC+11).
    assert.equal(
      nowLine("Australia/Sydney", new Date("2026-10-14T10:56:00Z")),
      "Current date and time: Wednesday, October 14, 2026, 09:56 PM (Australia/Sydney). Today's date in YYYY-MM-DD format: 2026-10-14."
    );
  });

  it("follows the zone, not the server clock", () => {
    assert.equal(
      nowLine("America/New_York", new Date("2026-10-14T10:56:00Z")),
      "Current date and time: Wednesday, October 14, 2026, 06:56 AM (America/New_York). Today's date in YYYY-MM-DD format: 2026-10-14."
    );
  });

  it("is what get_current_datetime returns", () => {
    const { message } = _test.resolveCurrentDatetime("Australia/Sydney");
    assert.match(
      message,
      /^Current date and time: [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4}, \d{2}:\d{2} (AM|PM) \(Australia\/Sydney\)\. Today's date in YYYY-MM-DD format: \d{4}-\d{2}-\d{2}\.$/
    );
  });
});
```

Append to `voice-server/tests/turn-validator.test.js` (reusing the file's existing `loadValidator`, `ARGS` and `afterEach` restore):

```js
describe("SCRUM-593: the Tier-2 checker knows today's date", () => {
  /** Capture the prompt the validator sends. */
  function capturePrompt() {
    const seen = { prompt: "" };
    globalThis.fetch = async (_url, init) => {
      seen.prompt = JSON.parse(init.body).messages[0].content;
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"accurate": true}' }], stop_reason: "end_turn" }) };
    };
    return seen;
  }

  it("puts NOW in the business's timezone into the prompt", async () => {
    const validate = loadValidator();
    const seen = capturePrompt();
    await validate({ ...ARGS, timezone: "America/New_York" });
    assert.match(seen.prompt, /NOW \(the business's timezone\): Current date and time: .*\(America\/New_York\)/);
  });

  it("defaults NOW to Sydney when no timezone is passed", async () => {
    const validate = loadValidator();
    const seen = capturePrompt();
    await validate(ARGS);
    assert.match(seen.prompt, /NOW \(the business's timezone\): Current date and time: .*\(Australia\/Sydney\)/);
  });

  it("tells the checker that 'today'/'tomorrow'/weekdays resolving to the tool's date are correct", async () => {
    const validate = loadValidator();
    const seen = capturePrompt();
    await validate(ARGS);
    assert.match(seen.prompt, /"today", "tomorrow" or a weekday name — are CORRECT when they resolve to the tool's date from NOW/);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd voice-server && node --test tests/now-line.test.js tests/turn-validator.test.js`
Expected: FAIL. `Cannot find module '../lib/now-line'`, and the three SCRUM-593 validator tests fail with no NOW line.

- [ ] **Step 3: Create `voice-server/lib/now-line.js`**

```js
"use strict";

/**
 * SCRUM-593: "now" in the business's timezone, worded exactly as the
 * get_current_datetime tool gives it to the voice model. The Tier-2 checker
 * and the booking pre-check need the same anchor to judge "today",
 * "tomorrow" and weekday names — without it the Tier-2 checker flagged a
 * correct "tomorrow" as a mismatch and the AI "corrected" a right booking
 * out loud (call 43d09f86, 2026-10-15).
 *
 * @param {string} timezone - IANA zone, e.g. "Australia/Sydney"
 * @param {Date} [now]
 * @returns {string}
 */
function nowLine(timezone, now = new Date()) {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: timezone,
  });
  const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  return `Current date and time: ${dateFormatter.format(now)}, ${timeFormatter.format(now)} (${timezone}). Today's date in YYYY-MM-DD format: ${isoDateFormatter.format(now)}.`;
}

module.exports = { nowLine };
```

- [ ] **Step 4: `resolveCurrentDatetime` uses it** (`voice-server/services/tool-executor.js`)

Add near the other `require`s at the top of the file:

```js
const { nowLine } = require("../lib/now-line"); // SCRUM-593: shared "now" wording
```

Replace the body of `resolveCurrentDatetime` (keep its JSDoc) with:

```js
function resolveCurrentDatetime(timezone) {
  return { message: nowLine(timezone) };
}
```

- [ ] **Step 5: Move `readApiError` to `lib/model-params.js` as `readAnthropicError`**

Append to `voice-server/lib/model-params.js`, before `module.exports`:

```js
/**
 * Error type + message from an Anthropic error body — never anything else.
 * Shared by the Tier-2 checker and the booking pre-check (SCRUM-593).
 * @param {{ json: () => Promise<unknown> }} res
 * @returns {Promise<{ errorType?: string, errorMessage?: string }>}
 */
async function readAnthropicError(res) {
  try {
    const body = /** @type {any} */ (await res.json());
    return {
      errorType: typeof body?.error?.type === "string" ? body.error.type : undefined,
      errorMessage: typeof body?.error?.message === "string" ? body.error.message.slice(0, 200) : undefined,
    };
  } catch {
    return {};
  }
}
```

Add `readAnthropicError,` to `module.exports` in `lib/model-params.js`. In `services/turn-validator.js`:
- delete the local `readApiError` function and its JSDoc;
- change the import line to `const { claudeLatencyParams, claudeResponseText, readAnthropicError } = require("../lib/model-params");`;
- change the one call `await readApiError(res)` to `await readAnthropicError(res)`.

- [ ] **Step 6: Give the Tier-2 prompt the NOW line** (`voice-server/services/turn-validator.js`)

Add the import: `const { nowLine } = require("../lib/now-line");`

In the `validateToolResponse` JSDoc, add `@param {string} [params.timezone] — IANA zone of the business (SCRUM-593); defaults to Australia/Sydney`. Change the signature to `async function validateToolResponse({ toolName, toolResult, spokenResponse, timezone })`.

In the prompt template, replace these lines:

```
AI SPOKE TO CALLER: "${spokenResponse}"

Check for:
1. Date mismatch (tool says one date, AI says different date)
```

with:

```
AI SPOKE TO CALLER: "${spokenResponse}"
NOW (the business's timezone): ${nowLine(timezone || "Australia/Sydney")}

Check for:
1. Date mismatch (tool says one date, AI says a different date). Relative words the AI used — "today", "tomorrow" or a weekday name — are CORRECT when they resolve to the tool's date from NOW.
```

(The `nowLine` call sits inside the existing `try`, so a bad timezone string fails open like any other request error.)

- [ ] **Step 7: The Tier-2 call site passes the timezone** (`voice-server/server.js`, the `validateToolResponse({` call at ~3118)

```js
                        validateToolResponse({
                          toolName: lastTool.name,
                          toolResult: lastTool.message,
                          spokenResponse: aiTurnText,
                          timezone: session.organization?.timezone || "Australia/Sydney", // SCRUM-593
                        }).then((validation) => {
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `cd voice-server && node --test tests/now-line.test.js tests/turn-validator.test.js && npm test 2>&1 | grep -E "^# (pass|fail)" && npm run typecheck`
Expected: all pass, `# fail 0`, typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add voice-server/lib/now-line.js voice-server/lib/model-params.js voice-server/services/tool-executor.js voice-server/services/turn-validator.js voice-server/server.js voice-server/tests/now-line.test.js voice-server/tests/turn-validator.test.js
git commit -m "fix(SCRUM-593): the Tier-2 checker judges 'today'/'tomorrow' against today's date

It was never told the date, so a correct 'tomorrow' read as a mismatch and the
AI said 'Actually, let me clarify that…' about a right booking (call 43d09f86).
One nowLine() now words 'now' for get_current_datetime, the Tier-2 checker
and (next) the booking pre-check.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WsMvFfmjCv3mhYEfJW5MQB"
```

---

### Task 2: The booking pre-check module

> Superseded in places by controller Rulings 5, 7–12 (see the SDD ledger) — the module in lib/booking-precheck.js is authoritative.

**Files:**
- Create: `voice-server/lib/booking-precheck.js`, `voice-server/tests/booking-precheck.test.js`

**Interfaces:**
- Consumes (Task 1): `nowLine`; `readAnthropicError`, `claudeLatencyParams` and `claudeResponseText` from `lib/model-params.js`.
- Produces:
  - `precheckBookingWrite(input) → Promise<{ action: "proceed" } | { action: "hold", problem: string, message: string }>`, where `input = { toolName, args, messages, pendingUser?, pendingAi?, timezone?, nameMethod?, holds: Map<string, number>, callSid?, now?: Date }`.
  - `applyBookingPrecheck(session, toolCall, { pendingUser?, pendingAi?, promptConfig?, audit?: boolean }) → Promise<{ message: string } | null>`.
  - `nameVerificationMethod(promptConfig) → "spell-out" | "read-back-characters" | "repeat-confirm"`.
  - `PRECHECKED_TOOLS`, `MAX_HOLDS`.

- [ ] **Step 1: Write the failing tests**

Create `voice-server/tests/booking-precheck.test.js`:

```js
"use strict";

/**
 * SCRUM-593 — booking pre-check contract (spec:
 * docs/superpowers/specs/2026-10-15-booking-precheck-design.md).
 * Pins: only book/reschedule/update are checked; enforce/shadow/off; a fix
 * verdict holds the write with the model's instruction; at most 2 holds per
 * tool; every failure lets the write through (fail-open) and alerts like the
 * Tier-2 checker; the request carries NOW, the name method, the args and the
 * conversation (system prompt excluded, in-progress turn appended); no caller
 * words or model text in logs.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const SAVED = { key: process.env.ANTHROPIC_API_KEY, mode: process.env.PRECHECK_MODE, model: process.env.PRECHECK_MODEL };
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;
/** @type {string[]} */
let logs = [];

beforeEach(() => {
  logs = [];
  console.warn = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
});

afterEach(() => {
  for (const [envName, v] of [["ANTHROPIC_API_KEY", SAVED.key], ["PRECHECK_MODE", SAVED.mode], ["PRECHECK_MODEL", SAVED.model]]) {
    if (v === undefined) delete process.env[envName];
    else process.env[envName] = v;
  }
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  console.log = realLog;
});

/** Fresh module = fresh unreadable streak. */
function load({ mode, model, noKey = false } = {}) {
  if (noKey) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = "test-key";
  if (mode === undefined) delete process.env.PRECHECK_MODE;
  else process.env.PRECHECK_MODE = mode;
  if (model === undefined) delete process.env.PRECHECK_MODEL;
  else process.env.PRECHECK_MODEL = model;
  const p = require.resolve("../lib/booking-precheck");
  delete require.cache[p];
  return require(p);
}

/** Stub fetch with a 2xx reply carrying one text block; records requests. */
function replyText(text) {
  const seen = { calls: 0, body: /** @type {any} */ (null) };
  globalThis.fetch = async (_url, init) => {
    seen.calls++;
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) };
  };
  return seen;
}

const CONVERSATION = [
  { role: "system", content: "SECRET SYSTEM PROMPT" },
  { role: "assistant", content: "Thanks for calling. How can I help?" },
  { role: "user", content: "I need a plumber tomorrow morning." },
  { role: "assistant", content: "Sure. What's your first name?" },
  { role: "user", content: "Michael." },
];
const ARGS = { first_name: "Michael", last_name: "Makhlouf", datetime: "2026-10-15T09:00" };
const NOW = new Date("2026-10-14T10:56:00Z");
const input = (over = {}) => ({
  toolName: "book_appointment",
  args: ARGS,
  messages: CONVERSATION,
  pendingUser: "Morning is good.",
  pendingAi: "Let me book that for you.",
  timezone: "Australia/Sydney",
  nameMethod: "repeat-confirm",
  holds: new Map(),
  callSid: "CAtest",
  now: NOW,
  ...over,
});
const FIX = JSON.stringify({ verdict: "fix", problem: "name_unconfirmed", instruction: "Spell back the surname M-A-K-H-L-O-U-F and ask if it is right." });

describe("which writes are checked", () => {
  it("checks book, reschedule and update", async () => {
    const m = load();
    for (const toolName of ["book_appointment", "reschedule_appointment", "update_appointment"]) {
      const seen = replyText('{"verdict":"allow"}');
      assert.deepEqual(await m.precheckBookingWrite(input({ toolName })), { action: "proceed" });
      assert.equal(seen.calls, 1, toolName);
    }
  });

  it("never calls Claude for any other tool", async () => {
    const m = load();
    for (const toolName of ["cancel_appointment", "check_availability", "schedule_callback", "end_call", "get_current_datetime"]) {
      const seen = replyText(FIX);
      assert.deepEqual(await m.precheckBookingWrite(input({ toolName })), { action: "proceed" });
      assert.equal(seen.calls, 0, toolName);
    }
  });
});

describe("verdicts and modes", () => {
  it("allow → proceed", async () => {
    const m = load();
    replyText('{"verdict":"allow"}');
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
  });

  it("fix (enforce, the default) → hold with the model's instruction and a call-again", async () => {
    const m = load();
    replyText(FIX);
    const r = await m.precheckBookingWrite(input());
    assert.equal(r.action, "hold");
    assert.equal(r.problem, "name_unconfirmed");
    assert.equal(
      r.message,
      "NOT DONE YET — nothing was saved. Spell back the surname M-A-K-H-L-O-U-F and ask if it is right. Then call book_appointment again with the confirmed details."
    );
  });

  it("a fenced JSON reply is still read", async () => {
    const m = load();
    replyText("```json\n" + FIX + "\n```");
    assert.equal((await m.precheckBookingWrite(input())).action, "hold");
  });

  it("a fix without an instruction falls back to the problem's default", async () => {
    const m = load();
    replyText('{"verdict":"fix","problem":"date_mismatch"}');
    const r = await m.precheckBookingWrite(input());
    assert.equal(r.action, "hold");
    assert.match(r.message, /The date or time you were about to save is not the one the caller agreed to\./);
  });

  it("an unknown problem code becomes 'other' with its default instruction", async () => {
    const m = load();
    replyText('{"verdict":"fix","problem":"weird"}');
    const r = await m.precheckBookingWrite(input());
    assert.equal(r.problem, "other");
    assert.match(r.message, /Confirm the booking details with the caller before saving them\./);
  });

  it("shadow mode logs the would-be hold and proceeds", async () => {
    const m = load({ mode: "shadow" });
    replyText(FIX);
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
    assert.ok(logs.some((l) => /\[Precheck\] \(shadow\) would hold book_appointment: name_unconfirmed/.test(l)));
  });

  it("off mode never calls Claude", async () => {
    const m = load({ mode: "off" });
    const seen = replyText(FIX);
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
    assert.equal(seen.calls, 0);
  });

  it("an unrecognised PRECHECK_MODE enforces", async () => {
    const m = load({ mode: "enforced" });
    replyText(FIX);
    assert.equal((await m.precheckBookingWrite(input())).action, "hold");
  });
});

describe("hold cap", () => {
  it("holds a tool twice, then lets the third attempt through with a warning", async () => {
    const m = load();
    replyText(FIX);
    const holds = new Map();
    assert.equal((await m.precheckBookingWrite(input({ holds }))).action, "hold");
    assert.equal((await m.precheckBookingWrite(input({ holds }))).action, "hold");
    const seen = replyText(FIX);
    assert.deepEqual(await m.precheckBookingWrite(input({ holds })), { action: "proceed" });
    assert.equal(seen.calls, 0, "the capped attempt is not re-checked");
    assert.ok(logs.some((l) => /book_appointment let through unchecked after 2 holds/.test(l)));
  });

  it("counts per tool", async () => {
    const m = load();
    replyText(FIX);
    const holds = new Map([["book_appointment", 2]]);
    assert.equal((await m.precheckBookingWrite(input({ toolName: "reschedule_appointment", holds }))).action, "hold");
  });

  it("shadow mode never counts a hold", async () => {
    const m = load({ mode: "shadow" });
    replyText(FIX);
    const holds = new Map();
    await m.precheckBookingWrite(input({ holds }));
    assert.equal(holds.size, 0);
  });
});

describe("fail-open", () => {
  it("no API key → proceed, [ALERT:error] at once", async () => {
    const m = load({ noKey: true });
    const seen = replyText(FIX);
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
    assert.equal(seen.calls, 0);
    assert.ok(logs.some((l) => /\[ALERT:error\].*Booking pre-check producing no verdicts/.test(l)));
  });

  it("HTTP 404 (bad model) → proceed, [ALERT:error] at once", async () => {
    const m = load({ model: "claude-nope" });
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }) });
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
    assert.ok(logs.some((l) => /\[ALERT:error\].*Booking pre-check producing no verdicts \(HTTP 404\)/.test(l)));
  });

  it("timeout / network error → proceed", async () => {
    const m = load();
    globalThis.fetch = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
    assert.deepEqual(await m.precheckBookingWrite(input()), { action: "proceed" });
  });

  it("unreadable replies proceed quietly twice, then page from the third in a row", async () => {
    const m = load();
    replyText("I think the name is fine");
    for (let i = 0; i < 2; i++) await m.precheckBookingWrite(input());
    assert.ok(!logs.some((l) => /\[ALERT:error\]/.test(l)), "no page before the third");
    await m.precheckBookingWrite(input());
    assert.ok(logs.some((l) => /\[ALERT:error\].*3 unreadable in a row/.test(l)));
  });

  it("a readable verdict resets the unreadable streak", async () => {
    const m = load();
    replyText("prose");
    await m.precheckBookingWrite(input());
    await m.precheckBookingWrite(input());
    replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input());
    replyText("prose");
    await m.precheckBookingWrite(input());
    assert.ok(!logs.some((l) => /\[ALERT:error\]/.test(l)));
  });

  it("a bad timezone string still checks, against Sydney", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    assert.deepEqual(await m.precheckBookingWrite(input({ timezone: "Not/AZone" })), { action: "proceed" });
    assert.match(seen.body.messages[0].content, /\(Australia\/Sydney\)/);
  });
});

describe("the request", () => {
  it("carries NOW, the name method, the args and the conversation — never the system prompt", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input({ nameMethod: "spell-out" }));
    const prompt = seen.body.messages[0].content;
    assert.match(prompt, /NOW \(the business's timezone\): Current date and time: Wednesday, October 14, 2026, 09:56 PM \(Australia\/Sydney\)/);
    assert.match(prompt, /TOOL: book_appointment/);
    assert.match(prompt, /DETAILS THE AI WANTS TO SAVE: \{"first_name":"Michael","last_name":"Makhlouf","datetime":"2026-10-15T09:00"\}/);
    assert.match(prompt, /the AI must have spelled it back letter by letter/);
    assert.match(prompt, /AI: Thanks for calling\. How can I help\?\nCALLER: I need a plumber tomorrow morning\./);
    assert.match(prompt, /CALLER: Morning is good\.\nAI: Let me book that for you\.$/m, "the in-progress turn comes last");
    assert.doesNotMatch(prompt, /SECRET SYSTEM PROMPT/);
  });

  it("Haiku runs with thinking disabled; other models at low effort", async () => {
    let m = load();
    let seen = replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input());
    assert.equal(seen.body.model, "claude-haiku-5-5");
    assert.deepEqual(seen.body.thinking, { type: "disabled" });
    assert.equal(seen.body.output_config, undefined);

    m = load({ model: "claude-sonnet-5-5" });
    seen = replyText('{"verdict":"allow"}');
    await m.precheckBookingWrite(input());
    assert.equal(seen.body.model, "claude-sonnet-5-5");
    assert.equal(seen.body.thinking, undefined);
    assert.deepEqual(seen.body.output_config, { effort: "low" });
  });

  it("keeps only the latest part of a very long call", async () => {
    const m = load();
    const seen = replyText('{"verdict":"allow"}');
    const long = Array.from({ length: 800 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `line ${i} ${"x".repeat(20)}` }));
    await m.precheckBookingWrite(input({ messages: long, pendingUser: "", pendingAi: "" }));
    const prompt = seen.body.messages[0].content;
    assert.match(prompt, /\[earlier part of the call omitted\]/);
    assert.match(prompt, /line 799 x+/);
    assert.doesNotMatch(prompt, /line 0 x/);
  });
});

describe("logs never carry caller words or model text", () => {
  it("a hold logs the problem code only", async () => {
    const m = load();
    replyText(FIX);
    await m.precheckBookingWrite(input());
    const all = logs.join("\n");
    assert.match(all, /\[Precheck\] Holding book_appointment: name_unconfirmed — hold 1\/2/);
    assert.doesNotMatch(all, /Makhlouf|M-A-K-H|Michael|plumber/);
  });
});

describe("nameVerificationMethod", () => {
  it("reads the first_name (or full_name) field's verification, defaulting to repeat-confirm", () => {
    const m = load();
    assert.equal(m.nameVerificationMethod({ fields: [{ id: "first_name", verification: "spell-out" }] }), "spell-out");
    assert.equal(m.nameVerificationMethod({ fields: [{ id: "full_name", verification: "read-back-characters" }] }), "read-back-characters");
    assert.equal(m.nameVerificationMethod({ fields: [{ id: "first_name", verification: "something-else" }] }), "repeat-confirm");
    assert.equal(m.nameVerificationMethod(undefined), "repeat-confirm");
  });
});

describe("applyBookingPrecheck (server.js glue)", () => {
  const session = (over = {}) => ({
    messages: CONVERSATION,
    organization: { timezone: "Australia/Sydney" },
    precheckHolds: new Map(),
    toolCallAudit: [],
    callSid: "CAtest",
    ...over,
  });

  it("returns null for unchecked tools without calling Claude", async () => {
    const m = load();
    const seen = replyText(FIX);
    assert.equal(await m.applyBookingPrecheck(session(), { name: "check_availability", args: {} }, { audit: true }), null);
    assert.equal(seen.calls, 0);
  });

  it("a hold returns the message and audits it under the tool's own name", async () => {
    const m = load();
    replyText(FIX);
    const s = session();
    const r = await m.applyBookingPrecheck(s, { name: "book_appointment", args: ARGS }, { pendingUser: "x", pendingAi: "y", promptConfig: undefined, audit: true });
    assert.match(r.message, /^NOT DONE YET — nothing was saved\./);
    assert.equal(s.toolCallAudit.length, 1);
    assert.equal(s.toolCallAudit[0].name, "book_appointment");
    assert.equal(s.toolCallAudit[0].successful, false);
    assert.equal(s.toolCallAudit[0].precheckHold, true);
  });

  it("audit:false (the /ws/test path) holds without touching the audit", async () => {
    const m = load();
    replyText(FIX);
    const s = session();
    assert.ok(await m.applyBookingPrecheck(s, { name: "book_appointment", args: ARGS }, { audit: false }));
    assert.equal(s.toolCallAudit.length, 0);
  });

  it("allow returns null and audits nothing", async () => {
    const m = load();
    replyText('{"verdict":"allow"}');
    const s = session();
    assert.equal(await m.applyBookingPrecheck(s, { name: "book_appointment", args: ARGS }, { audit: true }), null);
    assert.equal(s.toolCallAudit.length, 0);
  });

  it("creates the hold map if a session has none", async () => {
    const m = load();
    replyText(FIX);
    const s = session({ precheckHolds: undefined });
    await m.applyBookingPrecheck(s, { name: "book_appointment", args: ARGS }, { audit: true });
    assert.ok(s.precheckHolds instanceof Map);
    assert.equal(s.precheckHolds.get("book_appointment"), 1);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd voice-server && node --test tests/booking-precheck.test.js`
Expected: FAIL with `Cannot find module '../lib/booking-precheck'`.

- [ ] **Step 3: Create `voice-server/lib/booking-precheck.js`**

```js
"use strict";

/**
 * SCRUM-593 — booking pre-check. Gemini Live runs the conversation; just
 * before a booking change is WRITTEN, Claude checks the details against what
 * the caller actually said and confirmed. Gemini 3.8 saved "Makhlouf" for a
 * caller who spelled M-A-K-H-O-U-L, and booked "McCullough" without the
 * read-back its prompt requires — its words and its action agreed, so every
 * after-the-fact check (Tier-2, phantom detector, SCRUM-559) passed.
 *
 * Spec: docs/superpowers/specs/2026-10-15-booking-precheck-design.md
 *
 * Contract: never throws; fails OPEN (any failure lets the write through,
 * alerting like the Tier-2 checker); holds a tool at most MAX_HOLDS times per
 * call; logs no caller words, argument values or model text unless
 * DEBUG_TRANSCRIPTS (SCRUM-339).
 */

const { DEBUG_TRANSCRIPTS } = require("./log-transcript");
const { claudeLatencyParams, claudeResponseText, readAnthropicError } = require("./model-params");
const { nowLine } = require("./now-line");
const { Sentry } = require("./sentry");

const PRECHECKED_TOOLS = new Set(["book_appointment", "reschedule_appointment", "update_appointment"]);
const MAX_HOLDS = 2;
const PRECHECK_TIMEOUT_MS = 3000;
const PRECHECK_MAX_TOKENS = 300;
const MAX_TRANSCRIPT_CHARS = 12000;
const DEFAULT_TIMEZONE = "Australia/Sydney";
/** A bad PRECHECK_MODEL (404), a refused request field (400) or a bad key (401/403) fail every check. */
const CONFIG_FAILURE_STATUSES = new Set([400, 401, 403, 404]);
const UNREADABLE_ALERT_AFTER = 3;

/** @type {Record<string, string>} */
const DEFAULT_INSTRUCTIONS = {
  name_unconfirmed:
    "Read the caller's name back to them — spell the surname letter by letter — and ask them to confirm it. Use their correction if they give one.",
  name_mismatch:
    "The name you were about to save is not the one the caller gave. Ask the caller for their name again, read it back, and get a clear yes.",
  date_mismatch:
    "The date or time you were about to save is not the one the caller agreed to. Confirm the day and time with the caller.",
  not_agreed: "The caller has not agreed to this yet. Tell them the details and ask whether they want to go ahead.",
  other: "Confirm the booking details with the caller before saving them.",
};

/** @type {Record<string, string>} */
const METHOD_WORDING = {
  "spell-out": "spelled it back letter by letter",
  "read-back-characters": "read it back character by character",
  "repeat-confirm": "repeated it back",
};

/** @type {{ action: "proceed" }} */
const PROCEED = Object.freeze({ action: "proceed" });

// Checks in a row that produced no usable verdict (process-wide). Reset only
// by a verdict that could actually be read.
let unreadableStreak = 0;

/** @returns {"enforce" | "shadow" | "off"} */
function precheckMode() {
  const v = String(process.env.PRECHECK_MODE || "").trim().toLowerCase();
  return v === "shadow" || v === "off" ? v : "enforce";
}

/** @returns {string} */
function precheckModel() {
  return String(process.env.PRECHECK_MODEL || "").trim() || "claude-haiku-5-5";
}

/**
 * Lowest-latency request shape per model family: Haiku takes thinking
 * disabled (claudeLatencyParams); Sonnet/Opus 5.5 reject disabled thinking,
 * so they run at low effort instead.
 * @param {string} model
 * @returns {Record<string, unknown>}
 */
function precheckModelParams(model) {
  return /^claude-haiku-/i.test(model) ? claudeLatencyParams(model) : { output_config: { effort: "low" } };
}

/**
 * The assistant's name-confirmation method — the same lookup the Gemini
 * prompt's "NAME COLLECTION IS MANDATORY" rule uses (server.js).
 * @param {any} promptConfig - assistant.promptConfig
 * @returns {"spell-out" | "read-back-characters" | "repeat-confirm"}
 */
function nameVerificationMethod(promptConfig) {
  const fields = Array.isArray(promptConfig?.fields) ? promptConfig.fields : [];
  const field = fields.find((/** @type {any} */ f) => f && (f.id === "first_name" || f.id === "full_name"));
  const v = field?.verification;
  return v === "spell-out" || v === "read-back-characters" ? v : "repeat-confirm";
}

/**
 * The call so far as CALLER/AI lines: system prompt excluded, the turn still
 * in progress appended (Gemini adds it to session.messages only at
 * turnComplete). Keeps the latest MAX_TRANSCRIPT_CHARS.
 * @param {Array<{ role?: string, content?: unknown }>} messages
 * @param {string} [pendingUser]
 * @param {string} [pendingAi]
 * @returns {string}
 */
function conversationText(messages, pendingUser, pendingAi) {
  /** @type {string[]} */
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (text) lines.push(`${m.role === "user" ? "CALLER" : "AI"}: ${text}`);
  }
  const u = typeof pendingUser === "string" ? pendingUser.trim() : "";
  if (u) lines.push(`CALLER: ${u}`);
  const a = typeof pendingAi === "string" ? pendingAi.trim() : "";
  if (a) lines.push(`AI: ${a}`);
  let out = lines.join("\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    out = out.slice(out.length - MAX_TRANSCRIPT_CHARS);
    const nl = out.indexOf("\n");
    out = "[earlier part of the call omitted]\n" + (nl >= 0 ? out.slice(nl + 1) : out);
  }
  return out;
}

/**
 * @param {{ toolName: string, args: Record<string, unknown>, conversation: string, now: string, nameMethod: string }} p
 * @returns {string}
 */
function buildPrecheckPrompt({ toolName, args, conversation, now, nameMethod }) {
  const readBack = METHOD_WORDING[nameMethod] || METHOD_WORDING["repeat-confirm"];
  return `You check a phone receptionist AI's booking change BEFORE it is saved. The AI is about to call ${toolName} with the details below. Decide whether the details are what the caller actually said and confirmed.

NOW (the business's timezone): ${now}
TOOL: ${toolName}
DETAILS THE AI WANTS TO SAVE: ${JSON.stringify(args)}

CONVERSATION SO FAR (machine transcription of a phone call: CALLER lines can contain mishearings, and a spelled name can appear as separate or missing letters):
${conversation || "(nothing transcribed yet)"}

Rules — check ONLY these:
1. NAME (only if the details contain a first or last name): it must be the name the caller gave. After the caller last gave or corrected it, the AI must have ${readBack} and the caller must have clearly agreed (yes, that's right, correct — in any language). If the caller spelled it, the saved spelling must match their letters. A name the caller never clearly gave or never confirmed is NOT confirmed.
2. DATE/TIME (datetime, new_datetime): it must be the slot the caller agreed to. Work out "today", "tomorrow" and weekday names from NOW.
3. AGREEMENT: the caller must have asked for or agreed to this booking or change — not only asked what is free.
Ignore wording, email, notes, phone number, service, and practitioner (unless the caller asked for one practitioner and a different one is being saved).

Reply with ONLY one JSON object, no markdown:
{"verdict":"allow"}
or
{"verdict":"fix","problem":"name_unconfirmed"|"name_mismatch"|"date_mismatch"|"not_agreed","instruction":"one or two short sentences telling the AI exactly what to say or ask the caller next"}
If you are unsure whether the NAME was confirmed, answer fix with "name_unconfirmed".`;
}

/**
 * @param {string} text - the reply's text block
 * @returns {{ verdict: { allow: true } | { allow: false, problem: string, instruction: string } } | { unreadable: "not-json" | "no-verdict" }}
 */
function parsePrecheck(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  /** @type {any} */
  let result;
  try {
    result = JSON.parse(unfenced);
  } catch {
    return { unreadable: "not-json" };
  }
  if (!result || typeof result !== "object") return { unreadable: "no-verdict" };
  if (result.verdict === "allow") return { verdict: { allow: true } };
  if (result.verdict === "fix") {
    const problem = typeof result.problem === "string" && result.problem in DEFAULT_INSTRUCTIONS ? result.problem : "other";
    let instruction = typeof result.instruction === "string" ? result.instruction.replace(/\s+/g, " ").trim() : "";
    if (!instruction || instruction.length > 400) instruction = DEFAULT_INSTRUCTIONS[problem];
    return { verdict: { allow: false, problem, instruction } };
  }
  return { unreadable: "no-verdict" };
}

/**
 * The ONE exit for "no usable verdict": the write goes through, never
 * quietly. Config failures page at once; anything else from the 3rd in a row.
 * @param {{ cause: string, config?: boolean, status?: number, stopReason?: string, errorType?: string, errorMessage?: string }} info
 *   Shape only — never model output, tool args or caller words.
 * @param {string} model
 * @returns {{ allow: true }}
 */
function noVerdict(info, model) {
  unreadableStreak++;
  const details = {
    model,
    cause: info.cause,
    status: info.status,
    stop_reason: info.stopReason,
    error_type: info.errorType,
    error_message: info.errorMessage,
    unreadable_in_a_row: unreadableStreak,
  };
  if (info.config || unreadableStreak >= UNREADABLE_ALERT_AFTER) {
    const what = info.config
      ? info.status !== undefined ? `HTTP ${info.status}` : info.cause
      : `${unreadableStreak} unreadable in a row`;
    Sentry.withScope((scope) => {
      scope.setTag("service", "booking_precheck");
      scope.setExtras(details);
      Sentry.captureMessage(`Booking pre-check producing no verdicts (${what}) — writes go through unchecked`, "error");
    });
  } else {
    const shown = Object.entries(details)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.warn(`[Precheck] No usable verdict (${shown}) — letting the write through`);
  }
  return { allow: true };
}

/**
 * @param {string} prompt
 * @returns {Promise<{ allow: true } | { allow: false, problem: string, instruction: string }>}
 */
async function requestVerdict(prompt) {
  const model = precheckModel();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return noVerdict({ cause: "ANTHROPIC_API_KEY not set", config: true }, model);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: PRECHECK_MAX_TOKENS,
        ...precheckModelParams(model),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(PRECHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      const { errorType, errorMessage } = await readAnthropicError(res);
      return noVerdict(
        { cause: "http-error", status: res.status, config: CONFIG_FAILURE_STATUSES.has(res.status), errorType, errorMessage },
        model
      );
    }
    const data = /** @type {{ content?: unknown, stop_reason?: string }} */ (await res.json());
    const text = claudeResponseText(data.content).trim();
    if (!text) return noVerdict({ cause: "no-text", stopReason: data.stop_reason ?? "unknown" }, model);
    const parsed = parsePrecheck(text);
    if ("unreadable" in parsed) return noVerdict({ cause: parsed.unreadable, stopReason: data.stop_reason ?? "unknown" }, model);
    unreadableStreak = 0;
    return parsed.verdict;
  } catch (err) {
    const e = /** @type {any} */ (err);
    const name = e && e.name ? e.name : "Error";
    return noVerdict(
      { cause: "request-failed", errorType: name, errorMessage: name === "SyntaxError" ? "response body is not JSON" : String(e && e.message).slice(0, 200) },
      model
    );
  }
}

/**
 * Pre-check one tool call. Never throws.
 * @param {{
 *   toolName: string,
 *   args: Record<string, unknown>,
 *   messages: Array<{ role?: string, content?: unknown }>,
 *   pendingUser?: string,
 *   pendingAi?: string,
 *   timezone?: string,
 *   nameMethod?: string,
 *   holds: Map<string, number>,
 *   callSid?: string,
 *   now?: Date,
 * }} input
 * @returns {Promise<{ action: "proceed" } | { action: "hold", problem: string, message: string }>}
 */
async function precheckBookingWrite(input) {
  const { toolName, holds, callSid } = input;
  if (!PRECHECKED_TOOLS.has(toolName)) return PROCEED;
  const mode = precheckMode();
  if (mode === "off") return PROCEED;
  try {
    const held = holds.get(toolName) || 0;
    if (held >= MAX_HOLDS) {
      console.warn(`[Precheck] ${toolName} let through unchecked after ${MAX_HOLDS} holds. callSid=${callSid}`);
      Sentry.withScope((scope) => {
        scope.setTag("service", "booking_precheck");
        scope.setExtras({ callSid, toolName, holds: held });
        Sentry.captureMessage(`Booking pre-check: ${toolName} let through after ${MAX_HOLDS} holds`, "warning");
      });
      return PROCEED;
    }
    let now;
    try {
      now = nowLine(input.timezone || DEFAULT_TIMEZONE, input.now);
    } catch {
      now = nowLine(DEFAULT_TIMEZONE, input.now); // an invalid zone string in org data
    }
    const prompt = buildPrecheckPrompt({
      toolName,
      args: input.args || {},
      conversation: conversationText(input.messages, input.pendingUser, input.pendingAi),
      now,
      nameMethod: input.nameMethod || "repeat-confirm",
    });
    const started = Date.now();
    const verdict = await requestVerdict(prompt);
    const ms = Date.now() - started;
    if (verdict.allow) {
      console.log(`[Precheck] allow ${toolName} (${ms}ms). callSid=${callSid}`);
      return PROCEED;
    }
    if (mode === "shadow") {
      console.warn(`[Precheck] (shadow) would hold ${toolName}: ${verdict.problem} (${ms}ms). callSid=${callSid}`);
      return PROCEED;
    }
    holds.set(toolName, held + 1);
    console.warn(
      `[Precheck] Holding ${toolName}: ${verdict.problem} — hold ${held + 1}/${MAX_HOLDS} (${ms}ms)` +
        `${DEBUG_TRANSCRIPTS ? ` instruction="${verdict.instruction}"` : ""}. callSid=${callSid}`
    );
    return {
      action: "hold",
      problem: verdict.problem,
      message: `NOT DONE YET — nothing was saved. ${verdict.instruction} Then call ${toolName} again with the confirmed details.`,
    };
  } catch (err) {
    const e = /** @type {any} */ (err);
    console.error(`[Precheck] Unexpected error — letting ${toolName} through: ${e && e.message}. callSid=${callSid}`);
    return PROCEED;
  }
}

/**
 * server.js glue for the Gemini onToolCall handlers. Runs the pre-check with
 * this call's state; on a hold, records it in the tool audit (under the
 * tool's OWN name, successful:false — hasUnfinishedBooking's funnel matches
 * exact names, so the booking stays open for the end_call guard) and returns
 * the result to hand Gemini. null = go ahead and write.
 * @param {any} session - CallSession
 * @param {{ name: string, args?: Record<string, unknown> }} toolCall
 * @param {{ pendingUser?: string, pendingAi?: string, promptConfig?: any, audit?: boolean }} turn
 * @returns {Promise<{ message: string } | null>}
 */
async function applyBookingPrecheck(session, toolCall, turn) {
  if (!PRECHECKED_TOOLS.has(toolCall.name)) return null;
  if (!(session.precheckHolds instanceof Map)) session.precheckHolds = new Map();
  const result = await precheckBookingWrite({
    toolName: toolCall.name,
    args: toolCall.args || {},
    messages: session.messages,
    pendingUser: turn.pendingUser,
    pendingAi: turn.pendingAi,
    timezone: session.organization?.timezone,
    nameMethod: nameVerificationMethod(turn.promptConfig),
    holds: session.precheckHolds,
    callSid: session.callSid,
  });
  if (result.action !== "hold") return null;
  if (turn.audit && Array.isArray(session.toolCallAudit)) {
    session.toolCallAudit.push({ name: toolCall.name, successful: false, precheckHold: true, at: Date.now() });
  }
  return { message: result.message };
}

module.exports = {
  precheckBookingWrite,
  applyBookingPrecheck,
  nameVerificationMethod,
  PRECHECKED_TOOLS,
  MAX_HOLDS,
  // Exposed for unit tests only.
  _test: { parsePrecheck, conversationText, buildPrecheckPrompt, UNREADABLE_ALERT_AFTER },
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd voice-server && node --test tests/booking-precheck.test.js && npm run typecheck`
Expected: all pass, typecheck exits 0. (`lib/sentry.js` prints `captureMessage` as `[ALERT:<level>] [<service tag>] <message> | k=v…` through `console.*`, which the tests capture.)

- [ ] **Step 5: Commit**

```bash
git add voice-server/lib/booking-precheck.js voice-server/tests/booking-precheck.test.js
git commit -m "feat(SCRUM-593): booking pre-check — Claude checks a booking change before it is written

Book/reschedule/update details are checked against the conversation, NOW in
the business timezone and the assistant's name-confirmation method. A fix
verdict holds the write with an instruction for Gemini (max 2 per tool per
call); every failure lets the write through and alerts like the Tier-2
checker. PRECHECK_MODE enforce|shadow|off, PRECHECK_MODEL (default Haiku 5.5).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WsMvFfmjCv3mhYEfJW5MQB"
```

---

### Task 3: Wire it into both Gemini handlers

**Files:**
- Modify:
  - `voice-server/call-session.js:~106` (constructor)
  - `voice-server/server.js`: the imports (~35); the inbound Gemini `onToolCall`, between the RebookGuard block ending ~2708 and `if (session) session._toolCallInFlight = true;` ~2712; the audit push ~2779; the `/ws/test` Gemini `onToolCall`, between its CancelGate block and `session.rememberDetails` (~4642)
  - `voice-server/.env.example` (after the `VALIDATOR_MODEL` line)
- Create: `voice-server/tests/server-booking-precheck-wiring.test.js`

**Interfaces:**
- Consumes (Task 2): `applyBookingPrecheck(session, toolCall, { pendingUser, pendingAi, promptConfig, audit })`.

- [ ] **Step 1: Write the failing wiring test**

Create `voice-server/tests/server-booking-precheck-wiring.test.js`:

```js
"use strict";

// SCRUM-593 — source pins for the booking pre-check in the server.js monolith
// (idiom: server-owner-mode-wiring.test.js). The behaviour is unit-tested in
// booking-precheck.test.js; these pin WHERE it runs: in both Gemini
// onToolCall handlers, after the owner early-return and the existing guards,
// before anything is remembered or written.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const inboundStart = src.indexOf("onToolCall: async (toolCall) => {");
const inbound = src.slice(inboundStart, src.indexOf("onToolCallCancellation", inboundStart));
const testStart = src.indexOf("onToolCall: async (toolCall) => {", inboundStart + 1);
const testPath = src.slice(testStart, src.indexOf("onTranscriptIn", testStart));

describe("SCRUM-593: booking pre-check wiring", () => {
  it("imports the module", () => {
    assert.match(src, /const \{ applyBookingPrecheck \} = require\("\.\/lib\/booking-precheck"\);/);
  });

  it("inbound: runs after the owner return and the RebookGuard, before rememberDetails and the write", () => {
    const call = inbound.indexOf("await applyBookingPrecheck(session, toolCall, {");
    assert.ok(call > 0, "inbound handler calls applyBookingPrecheck");
    assert.ok(inbound.indexOf("runOwnerToolCall(") < call, "owner calls return first");
    assert.ok(inbound.indexOf("DUPLICATE_REBOOK_MESSAGE") < call, "after the RebookGuard");
    assert.ok(call < inbound.indexOf("session.rememberDetails(toolCall.name, toolCall.args)"), "before details are remembered");
    assert.ok(call < inbound.indexOf("result = await executeToolCall(toolCall.name"), "before the write");
    assert.match(inbound, /pendingUser: pendingUserTranscript,\s*pendingAi: pendingAiTranscript,\s*promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: true,/);
    assert.match(inbound, /if \(!session\) return \{ message: "" \};\s*if \(precheckHold\) return precheckHold;/);
  });

  it("inbound: the goodbye auto-end stays off while the check runs", () => {
    const call = inbound.indexOf("await applyBookingPrecheck(session, toolCall, {");
    const before = inbound.slice(Math.max(0, call - 400), call);
    assert.match(before, /if \(session\) session\._toolCallInFlight = true;/);
    assert.match(inbound.slice(call, call + 400), /finally \{\s*if \(session\) session\._toolCallInFlight = false;/);
  });

  it("inbound: a successful write resets that tool's hold count", () => {
    assert.match(inbound, /if \(successful\) session\.precheckHolds\?\.delete\(toolCall\.name\);/);
  });

  it("/ws/test: runs before the write, without auditing", () => {
    const call = testPath.indexOf("await applyBookingPrecheck(session, toolCall, {");
    assert.ok(call > 0, "test handler calls applyBookingPrecheck");
    assert.ok(call < testPath.indexOf("executeToolCall(toolCall.name"), "before the write");
    assert.match(testPath, /promptConfig: context\?\.assistant\?\.promptConfig,\s*audit: false,/);
    assert.match(testPath, /if \(!session\) return \{ message: "" \};\s*if \(precheckHold\) return precheckHold;/);
  });

  it("the Tier-2 call site passes the business timezone", () => {
    assert.match(src, /spokenResponse: aiTurnText,\s*timezone: session\.organization\?\.timezone \|\| "Australia\/Sydney",/);
  });
});

describe("SCRUM-593: CallSession", () => {
  it("starts every call with an empty hold map", () => {
    const { CallSession } = require("../call-session");
    const s = new CallSession("CAtest");
    assert.ok(s.precheckHolds instanceof Map);
    assert.equal(s.precheckHolds.size, 0);
  });
});
```

(`call-session.js` exports `module.exports = { CallSession };`.)

- [ ] **Step 2: Run it and watch it fail**

Run: `cd voice-server && node --test tests/server-booking-precheck-wiring.test.js`
Expected: FAIL. No `applyBookingPrecheck` import or calls, and `precheckHolds` is undefined. (The Tier-2 timezone pin already passes after Task 1.)

- [ ] **Step 3: CallSession gets the hold map** (`voice-server/call-session.js`, right after `this.toolCallAudit = [];`)

```js

    // SCRUM-593: booking pre-check holds per tool this call
    // (lib/booking-precheck.js). A tool held MAX_HOLDS times goes through
    // unchecked; a successful write of that tool resets its count.
    /** @type {Map<string, number>} */
    this.precheckHolds = new Map();
```

- [ ] **Step 4: Import in server.js** (next to the other `./lib/...` requires near line 35)

```js
const { applyBookingPrecheck } = require("./lib/booking-precheck"); // SCRUM-593
```

- [ ] **Step 5: Inbound Gemini handler.** Insert immediately after the RebookGuard `if (toolCall.name === "book_appointment" && session.confirmedBookings?.size > 0) { … }` block, and immediately before the existing `// Flag so goodbye-loop auto-end knows a tool call is in progress` comment:

```js
                  // SCRUM-593: before ANY booking change is written, Claude
                  // checks it against what the caller said and confirmed
                  // (lib/booking-precheck.js). A hold hands Gemini an
                  // instruction instead of writing. The in-flight flag keeps
                  // the goodbye-loop auto-end off while the check runs.
                  if (session) session._toolCallInFlight = true;
                  let precheckHold = null;
                  try {
                    precheckHold = await applyBookingPrecheck(session, toolCall, {
                      pendingUser: pendingUserTranscript,
                      pendingAi: pendingAiTranscript,
                      promptConfig: context?.assistant?.promptConfig,
                      audit: true,
                    });
                  } finally {
                    if (session) session._toolCallInFlight = false;
                  }
                  if (!session) return { message: "" };
                  if (precheckHold) return precheckHold;

```

- [ ] **Step 6: Reset on success.** In the same handler, directly after `session.toolCallAudit.push(auditEntry);`:

```js
                    if (successful) session.precheckHolds?.delete(toolCall.name); // SCRUM-593: a confirmed write resets its hold count
```

- [ ] **Step 7: `/ws/test` Gemini handler.** Insert after its CancelGate `if (toolCall.name === "cancel_appointment" && !session.confirmCancel(...)) { … }` block and before `session.rememberDetails(toolCall.name, toolCall.args); // SCRUM-506`:

```js
              // SCRUM-593: booking pre-check (test/demo path — parity with production; no tool audit here)
              const precheckHold = await applyBookingPrecheck(session, toolCall, {
                pendingUser: pendingUserTranscript,
                pendingAi: pendingAiTranscript,
                promptConfig: context?.assistant?.promptConfig,
                audit: false,
              });
              if (!session) return { message: "" };
              if (precheckHold) return precheckHold;
```

`context`, `pendingUserTranscript` and `pendingAiTranscript` are closure variables in both handlers: inbound `context` is assigned ~1967 and its pendings are declared ~2449; `/ws/test` `context` is at ~4449 and its pendings at ~4610. `npm run typecheck` fails if either name is out of scope.

- [ ] **Step 8: `.env.example`** (after the `VALIDATOR_MODEL` line)

```
# PRECHECK_MODE=enforce                     # SCRUM-593 booking pre-check before book/reschedule/update writes: enforce (default) | shadow (log only, never holds) | off
# PRECHECK_MODEL=claude-haiku-5-5           # model for the pre-check; Haiku runs with thinking off, Sonnet/Opus at low effort
```

- [ ] **Step 9: Run everything**

Run: `cd voice-server && node --test tests/server-booking-precheck-wiring.test.js && npm test 2>&1 | grep -E "^# (tests|pass|fail)" && npm run typecheck`
Expected: wiring tests pass, `# fail 0`, typecheck exits 0.

- [ ] **Step 10: Commit**

```bash
git add voice-server/call-session.js voice-server/server.js voice-server/.env.example voice-server/tests/server-booking-precheck-wiring.test.js
git commit -m "feat(SCRUM-593): run the booking pre-check in both Gemini tool-call handlers

After the owner return and the existing guards, before details are remembered
or anything is written. Holds are audited under the tool's own name so the
end_call guard keeps the booking open; a successful write resets the count.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WsMvFfmjCv3mhYEfJW5MQB"
```

---

### Task 4 (controller, not a subagent): replay the real calls against the live API

This is evidence only, with no repo changes. The fixtures hold the owner's own name and number, so they stay in the session scratchpad and are never committed.

- [ ] Build fixtures from the `calls` rows, using Gemini's own transcription (`raw_transcript`, or `transcript` where `transcript_source` is null). Cut each one just before the AI's booking line, and use the args Gemini sent (from the saved `appointments` row):
  - **f57bbfa2:** `{first_name:"Michael", last_name:"Makhlouf", datetime:"2026-10-15T09:00"}`. "Now" is 2026-10-14T10:56Z. Expected: fix (name).
  - **43d09f86:** `{first_name:"Michael", last_name:"McCullough", datetime:"2026-10-15T13:30"}`. "Now" is 2026-10-15T01:44Z. Expected: fix (name).
  - **7035934f:** `{first_name:"Michael", last_name:"Makhoul", datetime:"2026-10-16T09:00"}`. "Now" is 2026-10-15T03:20Z. Expected: fix (the caller asked to correct the name, and no clear yes followed).
  - **Synthetic A:** the name is given, repeated back and confirmed, and the caller picks "tomorrow at 9". Expected: allow.
  - **Synthetic B:** like A, but the args say a different day. Expected: fix (date).
  - **Synthetic C:** a spell-out business. The AI spells the name back and the caller says "yes". Expected: allow.
- [ ] Run each fixture 3× through `precheckBookingWrite` from the branch, on `claude-haiku-5-5` and `claude-sonnet-5-5`. Record each verdict, its problem code and the latency (p50 and max).
- [ ] **Pass bar:** every expected verdict matches in at least 3 out of 3 runs on the chosen model, and the median latency is at or under 1.5 s. If Haiku misses and Sonnet passes within latency, set `PRECHECK_MODEL` and record why. If neither passes, stop and report.
- [ ] Put the results table in the PR body.

### After the tasks

1. Run `/review-and-fix` (the 4-lens gate) on the branch against `origin/develop`.
2. Push and open a PR to `develop`. Do not merge it yet.
3. **Owner test before merge.** Deploy the branch build, with gemini-live as the pipeline:
   ```
   cd ~/projects/phondo && git fetch && git worktree add /tmp/phondo-precheck origin/feature/SCRUM-593-booking-precheck && cd /tmp/phondo-precheck && ./voice-server/deploy.sh
   ```
   Then make test calls (spell "Makhoul", book "tomorrow", and a clean "John Smith" booking). I check the logs (`[Precheck]` lines) and the saved rows.
4. **If it's good:** squash-merge to `develop`, release (merge commit), and the owner deploys from `main`.
5. **If it's not:** run `fly secrets set PRECHECK_MODE=off -a phondo-voice`, or redeploy `main` from `~/projects/phondo` (`./voice-server/deploy.sh`).
