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
- **Pipelines:** the Gemini paths only. That means production inbound calls (`server.js` `onToolCall`, ~2566) and the browser test call (`/ws/test`, ~4627), so test calls behave the same as real ones.
- **Tools:** `book_appointment`, `reschedule_appointment` and `update_appointment`.
- **Position:** after the existing guards (end-call guard, cancel gate, RebookGuard) and **immediately before `executeToolCall`**. Nothing is written until the check passes.
- **Skipped for:** owner calls (they return earlier and have their own read-back gate), and every other tool.

### What Claude sees
1. **The conversation so far.** This is `session.messages` (user and assistant turns, no system prompt) plus the turn still in progress (`pendingUserTranscript` / `pendingAiTranscript`). The text is labelled as Gemini's own transcription, which may contain mishearings and partial letter-spelling.
2. **The change Gemini wants to make:** the tool name and its arguments. For a booking that's the names, `datetime`, `phone`, practitioner and service; for a reschedule it's the current and new times.
3. **"Now"** in the business's timezone (weekday, date, time, zone), formatted the same way `get_current_datetime` does it (`services/tool-executor.js` ~481).
4. **The business's name-confirmation method** from the assistant's prompt config: `spell-out`, `read-back-characters` or `repeat-confirm` (the default).

### What Claude checks
- **Name:** the first and last name being saved are the ones the caller gave. Since the caller last corrected them, the AI must have read them back using the business's method and the caller must have said yes. If the caller spelled the name, the saved spelling matches their letters.
- **Date and time:** the slot being saved is the one the caller agreed to, with "today", "tomorrow" and "Friday" worked out from *now*.
- **Agreement:** the caller actually agreed to this booking or change, not just asked what's free.
- **Not checked:** wording, optional fields (email, notes), the phone number (caller ID is fine), and the practitioner unless the caller asked for one.

### What comes back
The answer is strict JSON, either `{"verdict":"allow"}` or `{"verdict":"fix","problem":"name_unconfirmed|name_mismatch|date_mismatch|not_agreed","instruction":"…"}`.

- **allow:** the write runs exactly as it does today.
- **fix:** nothing is written. Gemini gets the tool result `NOT DONE YET: <instruction> Then call <tool> again.` For example: *"NOT BOOKED YET: the surname wasn't confirmed. Spell back the surname you have, ask the caller if it's right, and use their correction. Then call book_appointment again."*
  - Because the tool is BLOCKING, Gemini waits for this, then asks the caller.
  - The audit records the attempt under the tool's own name with `successful: false, precheckHold: true`. `hasUnfinishedBooking` counts exactly `book_appointment` and `reschedule_appointment` as funnel steps, so this keeps the end-call guard treating the booking as unfinished.
  - It does **not** count against the booking-failure loop caps, because the write was never attempted.

### Limits and failures
- **Hold limit:** at most **2 holds per write**. The third attempt goes through, with a `[ALERT:warning]`, so a caller is never trapped when Claude can't be satisfied (for example on a garbled transcript). The count resets when that write succeeds.
- **When Claude fails:** this covers a timeout over **3 s**, an HTTP error, a missing key, or an unreadable reply. In each case the write **goes through as today** (fail-open) and is logged. A run of failures pages, using the same mechanism the existing checker uses. Logs never contain transcript text (SCRUM-339).
- **Modes:** `PRECHECK_MODE=enforce` (default), `shadow` (check and log, never hold) or `off`. Changing it is a Fly secret change, with no code deploy.
- **Model:** `PRECHECK_MODEL`, default `claude-haiku-5-5` with thinking off (the latency settings the validator already uses).

### Cost and delay
- **Delay:** about 0.7–1.5 s, added only at the booking moment, after Gemini's "let me book that" filler. The rest of the call is unchanged.
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
  - the request contains "now", the confirmation method, the arguments and the transcript (system prompt excluded);
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
