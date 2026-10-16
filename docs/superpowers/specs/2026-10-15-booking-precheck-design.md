# Booking pre-check: Gemini talks, Claude checks the booking (SCRUM-593)

**Status:** draft for owner approval, 2026-10-15
**Goal:** keep Gemini 3.8 Live's natural voice and speed, and stop bookings being saved with details the caller never confirmed. Claude Haiku 5.5 checks each booking change *before* it is written.

---

## 1. Why

We made four test calls on 14–15 Oct:

| Call | Pipeline | What went wrong |
|---|---|---|
| f57bbfa2 | Gemini | Saved the surname as "Makhlouf" when the caller spelled M-A-K-H-O-U-L. The final read-back left out the name, which the prompt requires. |
| 43d09f86 | Gemini | Booked "McCullough" without reading the surname back at all, again breaking the prompt rule. The after-the-fact checker then made the AI say "Actually, let me clarify…" about a booking that was correct. |
| e2c17143, 7035934f | Claude (classic) | Saved the correct name and date, but replies took 3–4 s, it answered half-sentences, and it didn't hang up. |

Gemini already has the rule ("NAME COLLECTION IS MANDATORY … repeat the name back and ask them to confirm", `server.js` ~2398). It just doesn't always follow it, and nothing in the code enforces it. Claude followed the same rules reliably.

## 2. Design

### When it runs
- **Pipelines:** the Gemini paths only. That means production inbound calls (`server.js` `onToolCall`, ~2567) and the browser test call (`/ws/test`, ~4691), so dashboard test calls behave the same as real ones.
- **Tools:** `book_appointment`, `reschedule_appointment` and `update_appointment`.
- **Position:** after the existing guards (end-call guard, cancel gate, RebookGuard) and **immediately before `executeToolCall`**. Nothing is written until the check passes. The RebookGuard's name-correction branch (a re-book with a corrected surname becomes an in-place attendee update) is checked too, before that write; its hold is not audited, because a booking already stands and a held fix must not reopen the end-call guard.
- **If the call ends during the check:** the handler holds the session it started with. A write the check **allowed** still happens, as it did when the write started in the same tick as the tool call (`[Precheck] session ended during the check — writing the allowed <tool> anyway`); a held write is dropped.
- **Skipped for:**
  - owner calls (they return earlier and have their own read-back gate) and every other tool;
  - a call that saves no name or date (an `update_appointment` that changes only phone, email or notes, even one that names its booking's `datetime`): there is nothing to compare with the call, so no request, no hold and a `[Precheck] skip <tool> (no name or date to save)` line;
  - the **public website demo** (`/ws/test` with `DEMO_ORG_ID`): every write there is simulated, and its prompt has no pre-booking read-back by design (3-minute cap), so a check would protect nothing and hold its bookings (`[Precheck] skip <tool> (public demo)`).

### What Claude sees
1. **The whole call so far:** the session's unwindowed transcript (`fullTranscriptMessages`: user and assistant turns, no system prompt), plus the turn still in progress, read live from the handler's transcript buffers. `session.messages` keeps only the last 20 messages, so on a longer call the name read-back and the caller's yes would fall out of it; it is used only while the unwindowed transcript is empty (a failed transfer's reconnect restores just the window). The text is labelled as Gemini's own transcription, which may contain mishearings and partial letter-spelling. A call over 12,000 characters keeps its first 3,000 and its last 9,000, in whole lines around a `[middle of the call omitted]` line. The name is usually confirmed early, and a tail-only cut held a correct booking as unconfirmed in the live replay.
2. **The change Gemini wants to make:** the tool name and only that tool's decision fields, in two sections. The RebookGuard's name fix says what it is. Its prompt opens "The AI already booked this caller earlier in this call and is about to CORRECT the caller's name on that booking (same appointment, same time)…", and its TOOL line reads `book_appointment (name correction on the booking already made in this call)`. Told only that a booking was about to be made, Claude compared the corrected name with the old one and held a confirmed fix (live replay).

   | Tool | DETAILS THAT WILL BE SAVED | DETAILS THAT ONLY IDENTIFY THE EXISTING APPOINTMENT |
   |---|---|---|
   | `book_appointment` | `first_name`, `last_name`, `datetime`, `practitioner` | (none: the section is left out) |
   | `reschedule_appointment` | `new_datetime`, `first_name`, `last_name`, `practitioner` | `name`, `current_datetime`, `current_date` |
   | `update_appointment` | `first_name`, `last_name` (the corrected values) | `datetime` (it picks this call's booking; time changes go through reschedule, SCRUM-558) |

   - Rules 1 and 2 below judge the saved section only. Reschedule's `name` is "for identity verification only" (`tool-executor.js`), so judging it as a name being saved would hold a correct change.
   - **Saved dates are spelled out** beside the ISO value: `"2026-10-17T09:00 = Saturday, October 17, 2026, 9:00 AM"`. Only a naive local value is spelled out (`YYYY-MM-DDTHH:MM`, optional seconds), read from its wall-clock fields with no zone conversion. A value carrying `Z` or `±HH:MM` is an absolute instant to the writer (`src/lib/calendar/tool-handlers.ts`, `ensureTimezoneOffset`), so its digits are not the business's clock: it is sent as given. So are a value that is not a real date and time, and every date in the identify section. Without reasoning, Haiku missed ISO-date arithmetic in the live replay ("tomorrow, Friday October 16" was allowed against `2026-10-17T09:00`, 3 of 3).
   - **`practitioner` is a name, never the raw `practitioner_id`.** The id is resolved against the call's own staff list (`session.scheduleSnapshot.practitioners`, the list the model took the id from), quoted as one line (controls and line separators become a space, invisible characters are dropped, at most 80 characters), and left out when it cannot be resolved (an unknown id, or no snapshot, as for a Cliniko org). It is never logged.
   - **Never sent:** phone, email, notes, service ids, confirmation codes or the raw practitioner id. Less PII offshore, and no free text for the checker to misjudge or be steered by.
3. **"Now"** in the business's timezone (weekday, date, time, zone), formatted the same way `get_current_datetime` does it (`services/tool-executor.js` ~454).
4. **The business's name-confirmation method** from the assistant's prompt config: `spell-out`, `read-back-characters` or `repeat-confirm` (the default).

### What Claude checks
- **Name** (saved details only): the first and last name being saved are the ones the caller gave. Since the caller last corrected them, the AI must have read them back using the business's method and the caller must have said yes. If the caller spelled the name, the saved spelling matches their letters.
- **Date and time** (saved details only): the slot being saved is the one the caller agreed to, with "today", "tomorrow" and "Friday" worked out from *now*.
- **Agreement:** the caller actually agreed to this booking or change, not just asked what's free.
- **Practitioner** (rule 4): only if a practitioner is being saved AND the caller asked for a specific person, the saved practitioner must be that person (`practitioner_mismatch`). It is a numbered rule of its own: inside the old "Ignore … (unless …)" sentence it was missed live (3 of 3).
- **Not checked:** wording, optional fields (email, notes), the phone number (caller ID is fine), and the details that only identify the existing appointment.

### What comes back
The answer is strict JSON, either `{"verdict":"allow","problem":"none"}` or `{"verdict":"fix","problem":"name_unconfirmed|name_mismatch|date_mismatch|practitioner_mismatch|not_agreed"}`. Claude is asked for a problem code only, never for wording. The request uses structured outputs (`output_config.format`, a `json_schema`), so the reply can only be `{verdict, problem}`: with thinking off, Haiku 5.5 otherwise wrote its reasoning before the JSON, and those replies were unreadable and failed open (8 of 18 in the live replay).

- **allow:** the write runs exactly as it does today.
- **fix:** nothing is written. Gemini gets the tool result `<opening> <instruction> Then call <tool> again with the confirmed details.` Both parts are **fixed server-side text**:
  - `<opening>` is chosen by the write. A new booking gets `NOT DONE YET — nothing was saved.` A reschedule, an update and the RebookGuard's name fix (held while a booking already stands) get `NOT CHANGED YET — the existing booking still stands exactly as it was.`, so Gemini never tells a booked caller they have nothing.
  - `<instruction>` is chosen by the problem code (an unrecognised code becomes `other`). For example, for `name_unconfirmed`: *"Read back the name you were about to save — spell the surname letter by letter — and ask the caller to confirm it. Use their correction if they give one."*
  - **Claude's wording never reaches Gemini** (SCRUM-593 security ruling). The transcript is in Claude's prompt, so a caller can shape what Claude writes; relaying it would give caller speech the authority of a tool result ("transfer the caller to …"). Only the problem code is taken from the reply, and only when it is exactly one of the known codes.
  - **A late "yes":** Gemini's transcription of the caller has no guaranteed order against its tool calls (SCRUM-587), so the yes that confirmed a booking can land after the call. On a fix, if the caller's words **grew** during the check, the check asks **once** more with them. Words that shrank or changed are no new evidence: cleanup clears the turn in progress, for example. In that case the first verdict stands. Shadow mode never re-checks; it logs the first verdict. A re-check that reads a verdict is final. One that produces none (an error, a timeout, an unreadable reply) **holds on the first verdict** (`[Precheck] re-check failed — holding on the first verdict <tool>: <problem>`): a real verdict already found a problem, and failing open there could save the data it caught. That failure still counts toward the run that pages, and if it pages, the page says it held on the first verdict. An allow never waits for any of this.
  - Because the tool is BLOCKING, Gemini waits for this, then asks the caller.
  - The audit records the attempt under the tool's own name with `successful: false, precheckHold: true`. `hasUnfinishedBooking` counts exactly `book_appointment` and `reschedule_appointment` as funnel steps, so this keeps the end-call guard treating the booking as unfinished.
  - It does **not** count against the booking-failure loop caps, because the write was never attempted.
  - It clears the Tier-2 checker's last tool result, so the read-back it asks for is never judged against an older result from the last 10 s.

### Limits and failures
- **Hold limit:** at most **2 holds per write**. The third attempt goes through, with a `[ALERT:warning]`, so a caller is never trapped when Claude can't be satisfied (for example on a garbled transcript). The count resets when that write succeeds (on both Gemini paths, and when a name fix succeeds).
- **When Claude fails:** this covers a timeout over **3 s**, an HTTP error, a missing key, or an unreadable reply. In each case the write **goes through as today** (fail-open) and is logged as `unchecked`. A run of failures pages, using the same mechanism the existing checker uses. Logs never contain transcript text (SCRUM-339).
- **Modes:** `PRECHECK_MODE=enforce` (default), `shadow` or `off`. `shadow` checks and logs the first verdict when it lands (no re-check), and never holds or delays a write. `off` also accepts `disabled`, `false`, `0` and `no`, so the kill switch fails toward off; any other unknown value warns once and enforces. Changing it is a Fly secret change, with no code deploy.
- **Model:** `PRECHECK_MODEL`, default `claude-haiku-5-5` with thinking off (the latency settings the validator already uses).

### Cost and delay
- **Delay:** about 0.7–1.5 s, added only at the booking moment, after Gemini's "let me book that" filler. A hold where the caller spoke during the check can take one more request. The rest of the call is unchanged.
- **Cost:** under 0.1¢ per check, around 0.2¢ per booking call. It runs on the Anthropic account the app already uses.

## 3. Fix the existing after-the-fact checker

The Tier-2 checker (`services/turn-validator.js`) is never told today's date, so it flags "tomorrow" and "today" as mismatches and injects false corrections. It will get the same "now" line (date, time, timezone), and its call site will pass the session's timezone. Its job is unchanged: catching the AI *saying* something different from what the tool did.

## 4. Approaches considered

- **A. Claude checks before the write (this design).** Stops wrong data being saved, and the caller hears the fix during the call. Costs about a second at booking.
- **B. Fixed code rules, no LLM** (regex: "did the AI say the name, did the caller say yes"). Faster, but brittle across phrasing and languages. An English-phrase guard already failed us on Arabic (SCRUM-373).
- **C. Repair after the call** (compare the booking with the Deepgram transcript and fix the name). No delay, but the caller has already heard and confirmed the wrong details. Worth adding later as a safety net.

## 5. Decisions (override any on review)

1. **Strict on names.** No booking unless the caller confirmed the name the AI read back. This enforces the rule the prompt already has, rather than intervening only when a name "looks wrong". *Why:* the "looks fine" judgement would come from Gemini's own transcript, which is what misheard "Makhoul".
2. **Fail-open.** If Claude is slow or down, the booking goes through as today, with an alert. *Why:* a checker outage must not stop bookings.
3. **Two holds maximum, then let it through.** *Why:* never trap a caller.
4. **Gemini paths only.** The classic pipeline is unchanged.
5. **Book, reschedule and update only.** Cancellations already need a second, confirmed request (SCRUM-372), and callbacks are lower stakes.
6. **Haiku 5.5 by default, for speed.** The replay test (§6) compares it with Sonnet 5.5 and may switch if Haiku misjudges and Sonnet is still fast enough.
7. **Ships in `enforce` mode**, with `PRECHECK_MODE=off` as the kill switch.

## 6. Testing and rollout

- **Unit tests** (`lib/booking-precheck.js`):
  - the request contains "now", the confirmation method, each tool's decision fields (saved vs identify-only, the practitioner by name) and the whole transcript (system prompt excluded);
  - JSON parsing works;
  - timeout, error and garbage replies all mean allow;
  - `shadow` and `off` modes work;
  - the hold cap and reset work.
- **Wiring tests** (`server.js`):
  - the check runs before `executeToolCall` for the 3 tools on both Gemini paths;
  - other tools and owner calls skip it;
  - a hold doesn't write;
  - a hold isn't a booking failure;
  - `end_call` after a hold is still nudged.
  - Mutation testing is the bar: each test must fail with its line of the fix removed.
- **Replay on real transcripts.** Run the check live, with the exact arguments Gemini sent:

  | Transcript | Expected verdict |
  |---|---|
  | f57bbfa2 (Makhlouf) | **fix** (name) |
  | 43d09f86 (McCullough) | **fix** (name) |
  | 7035934f, cut at the booking | **fix** (name). The caller had just asked "correct my last name, please" and gave no clear yes. |
  | Synthetic clean bookings (confirmed name, "tomorrow at 9") | **allow** |
  | A synthetic wrong-day booking | **fix** (date) |

  It runs on Haiku 5.5 and Sonnet 5.5, recording accuracy and latency.
- **Tier-2 test:** a "tomorrow" phrasing with a matching date is not flagged.
- **Gate:** the usual 4-lens review, then `develop` → release (merge commit) → `./voice-server/deploy.sh`.
- **Owner test calls:** spell "Makhoul", book for "tomorrow", then a clean "John Smith" booking. If it misbehaves: `fly secrets set PRECHECK_MODE=off -a phondo-voice`.

## 7. Not in this change

- **Phase 2: hearing.** Run Deepgram live on the caller's audio and give Claude that transcript too, because Deepgram heard M-A-K-H-O-U-L correctly where Gemini didn't. Decide after Phase 1: if holds keep firing because Gemini's transcript of letters is wrong, this is the fix.
- **Arabic speech recognition.** This needs a better multilingual speech-to-text and is a separate project.
- **Other pipelines and tools:** the classic pipeline, cancellations, callbacks.
- **Separate small PR, already promised:** owner calls exempt from the demo line's 3-minute cap, and the spam filter matching whole words only ("first" currently matches "IRS").

## 8. Files

- **New:** `voice-server/lib/booking-precheck.js` (the Claude request, verdict parsing, mode, and hold counter keyed per session and tool), plus its tests.
- `voice-server/server.js`: called in both Gemini `onToolCall` handlers, just before `executeToolCall`.
- `voice-server/services/turn-validator.js` and its call site: the "now" line.
- `voice-server/services/tool-executor.js`: export the "now" formatter for reuse.
- `voice-server/.env.example`: `PRECHECK_MODE`, `PRECHECK_MODEL`.

**Estimate:** 1–2 days including review. Owner deploy needed.
