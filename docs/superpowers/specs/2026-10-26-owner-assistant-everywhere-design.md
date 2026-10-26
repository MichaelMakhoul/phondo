# Owner assistant everywhere: design (SCRUM-597, SCRUM-598)

**Status:** approved by the owner in chat on 2026-10-26 ("alright, sounds good"). This doc records what was agreed and how it is built.

**Builds on:** SCRUM-585/586/587 (phone owner line) and SCRUM-596 (owner assistant in the dashboard): `docs/superpowers/specs/2026-10-26-owner-assistant-web-design.md`.

## What the owner asked for

From the owner's first browser test (call `9a3838b9`, 2026-10-26) and the follow-ups:

1. **"Keep the assistant visible on all pages, just like a bot."** The owner can see it at all times, minimise it, see the transcript, and move between pages while it keeps running.
2. **A readable transcript.** Gemini's own input transcription turned 4 of the owner's 6 lines into random Spanish or Korean, although the model understood them. Phone calls get a Deepgram re-transcription after the call; web sessions get none, so the nonsense was what the owner saw and what was saved.
3. **"When cancelling or moving an appointment, the owner should be asked if the client should be informed, in case they forgot."**
4. **"They can ask for an SMS or a call (consider the expenses of both). If the caller is on a landline, or can't receive SMS for some reason, we shouldn't send an SMS."**
5. **"Inform the business owner by email after the action they asked for is done ... in case the AI made a mistake or hallucinated."** This avoids a dispute between the client and the business that our system caused.

## Scope and split

- **PR 1 (SCRUM-597):**
  - the always-on bubble (1);
  - the Deepgram transcript (2);
  - the "let them know?" question, with texts as the channel (3, 4);
  - the owner recap email for in-session changes (5).
- **PR 2 (SCRUM-598):** the AI call to the customer, as the second channel for (3, 4), plus its outcome email (5).

Both PRs share one contract (below), so PR 2 adds a channel without reworking PR 1.

**Out of scope:**
- booking new jobs from the owner assistant;
- typed (text) chat in the bubble;
- scheduling a call or text for later;
- per-org SMS sender registration (still blocked on the ABN, SCRUM-264).

## 1. The always-on bubble (website)

- **Where it shows:** a floating bubble at the bottom right of every dashboard page (`src/app/(dashboard)/layout.tsx`). It appears only when all of these hold:
  - `OWNER_ASSISTANT_UI_ENABLED` is on;
  - the current org membership (`memberships[0]`, the same choice as `getPrimaryMembership`) is the `owner` role;
  - the org has an active assistant, whose voice the bubble uses, exactly as `/assistant-line` picks it.
- **The session:** one session per dashboard tab, owned by a client provider (`OwnerAssistantProvider`, wrapping the layout's content, keyed by org id). It wraps the existing `useVoiceTest({ tokenUrl: OWNER_ASSISTANT_TOKEN_URL, trackingSource: "owner_assistant" })`.
  - The App Router keeps the layout mounted across client-side navigation, so the session survives moving between pages.
  - A full reload, closing the tab or switching org ends it. That is a browser limit; the hook's `pagehide` teardown already handles it.
- **Collapsed:** a round button showing the state: ready, connecting (spinner), listening, speaking (pulse), muted, or error (dot).
- **Expanded:** a panel holding:
  - a header ("Your assistant"), a minimise button, and Escape to minimise;
  - one line saying changes are real (it reads every change back and waits for a yes; sessions last up to 8 minutes);
  - Start talking, Mute and End;
  - the live transcript, auto-scrolled;
  - errors, and the ended state with "Talk again".
- **Layout:**
  - The open/minimised state is remembered per viewer in `localStorage`, with every access in try/catch; it renders correctly without it.
  - On mobile it sits above the bottom nav, and the panel goes almost full width.
  - It respects `prefers-reduced-motion` for the pulse.
- **`/assistant-line`:** keeps its explainer and renders the full panel inline from the same provider, so there is never a second session. The floating bubble hides on that page.
- **No new API or authority.** The token route and voice server gates are unchanged.

## 2. A readable transcript (voice server)

- **The change:**
  - Owner web sessions on the Gemini pipeline open a parallel Deepgram Nova-3 stream (English, `mip_opt_out=true` as everywhere) and get the same inbound mulaw frames the browser sends.
  - Deepgram's final results become the owner's lines: the `pendingUserTranscript` buffer that is flushed at turn end, sent to the browser and saved.
  - Gemini's input transcription is no longer used as text on these sessions.
- **Unchanged:** Gemini's input transcription still stamps the confirmation gate's clock (`noteOwnerSpeech`). That stamp is content-blind (it needs any word), so the reviewed gate is untouched.
- **Fallback:** if Deepgram can't connect, errors or closes unexpectedly, the session goes on and the owner's lines fall back to Gemini's text, with a logged warning. It is never fatal: the conversation does not depend on it.
- **Cost:** under 1¢ a minute.
- **Not touched:**
  - customer test calls;
  - the phone owner line, which gets the post-call Deepgram re-transcription where recorded;
  - the classic owner pipeline (already Deepgram).

## 3–4. "Let them know?" (contract shared by PR 1 and PR 2)

### The owner's experience

On every cancel or move, the read-back asks how to let the customer know, offering only what works for that customer. For example: "Cancel Michael Dunn's 12:30 on Monday, and shall I text him to let him know, or leave it?"

- If a channel can't be used, the assistant says why in a few words, for example:
  - "texts are switched off for now";
  - "that's a landline";
  - "they've opted out of texts";
  - "there's no mobile on the booking".

  It then offers the number after the change.
- **Nothing changes until the owner has answered.** A confirmed write without a valid choice changes nothing. It comes back as `needs_confirmation`, asking the question, and re-arms the gate.
- **After the change**, the assistant says exactly what happened: texted, couldn't text (and why), calling them now (PR 2), or not told. It never claims a contact the result doesn't confirm.

### Tool contract

`owner_reschedule_appointment` and `owner_cancel_appointment` gain `notify_customer`: `"text" | "call" | "none"`.

- **The read-back result** (`needs_confirmation`) adds:
  - `data.contact_options`: the subset of `["text", "call", "none"]` that works now (`"none"` is always present);
  - `data.contact_note`: one short sentence when text or call is not offered and why, else absent.
- **On a confirmed write:**
  - `notify_customer` must be one of the three values. Otherwise the result is `needs_confirmation` and nothing changes.
  - If the owner picked a channel that isn't available (the model offered it against the rules), the change still happens: the owner said yes to the change. The contact is reported as not made, with the reason.
- **Results** carry:
  - `data.customer_contact`: `{ method, status, reason? }`;
  - `status`: `"sent"` (text) | `"calling"` (PR 2: call placed) | `"not_sent"` | `"not_available"` | `"not_requested"`;
  - `data.customer_notified`: true only for `"sent"` or `"calling"`.

### Who can be texted

Checked in this order, each fail-closed:

1. `CALLER_SMS_ENABLED` is off: "texts to customers are switched off for now". This is today's production state.
2. No phone on the booking, or it can't be normalised (`parsePhoneToE164`, in the org's country): "there's no mobile number on this booking".
3. **Line type:**
   - **AU:** only `+614…` numbers are mobiles. Landlines (`+612`, `+613`, `+617`, `+618`) and 13, 1300 and 1800 numbers can't take a text. The check is free and needs no I/O; AU mobile numbers can't be ported to a fixed line.
   - **US:** Twilio Lookup Line Type Intelligence (US$0.008 a lookup, only on an owner read-back), where only `mobile` qualifies. A lookup error means no text.
   - **Other countries:** no text.
4. The customer replied STOP (`caller_sms_optouts`): "they've opted out of texts".
5. The rest (the org's own confirmation toggle, rate limits, plan) is applied by `sendCallerSMS` at send time and reported as `not_sent` with its reason.

The free AU line-type rule is also added to `sendCallerSMS` itself, so no customer text of any kind (confirmation, cancellation, missed-call text-back) goes to an AU landline or 13/1300/1800 number. It is recorded as `skipped_no_contact`. With texts paused today, this changes nothing in production.

### What the text says

The text reuses the dashboard's existing messages:
- a cancel uses `sendCancellationSMS`;
- a move uses `sendAppointmentConfirmationSMS` for the new time, as the dashboard's SCRUM-399 "text the customer" does.

Both record an `appointment_confirmations` row. The owner path cancels with `suppressSms: true` and sends afterwards itself, so the rules above always apply and the result is captured.

### Costs (Twilio list prices, US$, 2026-10-26)

| | Cost |
|---|---|
| Text | 5.15¢ a segment (cancellation texts are usually 2) |
| Call to an AU mobile | 7.5¢/min, plus Gemini audio ≈ 2.25¢/min |
| Call to an AU landline | 2.52¢/min |
| Answering-machine detection | 0.75¢ a call |
| US line-type lookup | 0.8¢ |

A one-minute call costs about the same as a two-part text.

## 5. The owner recap email

- **When:**
  - after every owner session (web or phone) that changed at least one booking;
  - in PR 2, also after every AI call to a customer.
- **Where it is built:** `POST /api/internal/call-completed` (new step 4d, owner calls only), after the call row is final. The status doesn't matter: a session that failed after making a change still gets its recap.
- **Built from the system's records, never from the AI's words:**
  - **What changed:** `appointment_events` rows with `call_id` = the session's call (`cancelled` / `rescheduled`; PR 2 adds `created`), joined to `appointments`. A move shows its old time, from the `rescheduled_from_id` leg, and its new time.
  - **Whether the customer was told:**
    - **texts:** `appointment_confirmations` for that appointment and intent, created since the session started. `sent`/`delivered` reads "texted"; `skipped_*` reads "not texted" with the reason; `failed`/`undelivered` reads "the text failed".
    - **calls (PR 2):** the outbound call's outcome.
    - **no record:** "not told".
- **Who gets it and how:** the org owner only (`getOrganizationOwnerEmail`), like the PIN-lockout email. There is no preference gate: it is the safety net the owner asked for.
- **Content:**
  - Subject: "Your assistant made N change(s)".
  - One row per change.
  - "This list comes from your diary, not from what the AI said. If anything here isn't what you asked for, fix it in Appointments and let the customer know."
  - Links to Appointments and to the session (`/calls/<id>`).
  - All customer text is HTML-escaped inside the template, because array fields bypass the top-level escaping.
- **Once per call:**
  - A conditional claim on `calls.metadata.owner_recap_emailed_at`: the update is filtered on the key being absent, so a retried `call-completed` can't send twice.
  - A failure pages (`[ALERT:error]`) and never fails the route.
- **Demo org:** skipped, as for every owner alert.

## PR 2: the AI call to the customer (SCRUM-598)

Detailed on 2026-10-26, after PR 1 shipped. It builds on the PR 1 contract and stays within what the owner approved. The owner's own examples:
- "call the client ... confirm the appointment or cancel it";
- "call them and get another time, or call them and cancel".

Rulings made while detailing it are marked **Ruling**.

### What the owner gets

- **Calling after a change.** `notify_customer: "call"` on a confirmed cancel or move, offered in `contact_options` only when a call can be placed now. The call says:
  - for a cancel: "it's been cancelled, would you like another time?";
  - for a move: "it's been moved to X, does that suit you?".
- **Calling without a change** (**Ruling:** a new owner tool, `owner_call_customer`, because the owner asked for both):
  - `purpose: "confirm"`: "are you still OK for X?";
  - `purpose: "find_new_time"`: "the business needs to move your X, what other time suits you?". The booking stays as it is until the customer picks a time.
  - It has the same read-back and confirmation gate as the other owner writes. An optional `note` (≤160 characters, one line) carries the owner's guidance on times, for example "next week, mornings". The note is used to choose times and is never read out.
- **After a call is placed**, the owner hears: "I'm calling Jane now. You'll get an email when the call's done." (`customer_contact: { method: "call", status: "calling" }`). A call that can't be placed is reported with its reason, and the change itself still happens.
- **The outcome email**, one per call, to the owner. It is built from records, never from the AI's words:
  - the result: answered (with duration), voicemail left, no answer, busy or failed;
  - what changed in the diary on the call: bookings and moves carrying the call's `call_id`, and the booking's state now;
  - the assistant's own note and summary, labelled as AI-written;
  - a link to the call, with its recording and transcript.
- **The owner session's recap email** (PR 1) says "calling them, a separate email follows" for a change whose call was placed.

### When a call can be placed

The voice server checks every condition at the read-back (`/internal/customer-call/check`) and again at placement. Each check fails closed.

1. **The flag.** `OWNER_CUSTOMER_CALLS_ENABLED=true` on Fly. **Ruling:** this is the only flag. The voice server places the call, so its switch is the one that matters, and Next.js asks the voice server instead of keeping a second copy.
2. **The Gemini Live pipeline is available.** Calls never run on the classic fallback.
3. **The request comes from an owner session of the same org.** `requested_by_call_id` must be that org's `call_type = "owner"` call, and the demo org is never called from.
4. **The booking is the org's.**
   - The number to dial must be the booking's own: the E.164 that Next.js normalised has to match the stored `attendee_phone` on at least its last 9 digits.
   - The purpose has to match the booking's state:
     - `cancelled` needs a cancelled booking;
     - `moved`, `confirm` and `find_new_time` need a confirmed or pending booking in the future.
5. **Australia only (Ruling).** The org's country must be AU and the number +61. A US call needs a TCPA review first: since 2024 the FCC counts AI voices as "artificial voice".
6. **Calling hours.** 8:00 to 20:00 in the org's timezone.
7. **A number to call from.** The org needs an active Twilio Phondo number: not released, `telephony_provider = 'twilio'`. That number is the caller ID, so calling back reaches the receptionist.
8. **Caps, counted over the last 24 hours:**
   - at most 20 customer calls per org;
   - at most 2 per customer number per org;
   - one per booking and purpose ("already called them about this").
9. **Never a number that asked not to be called.** A prior call's `metadata.notify.outcome = "do_not_call"` blocks the number for that org.

### The call (voice server)

- **Placing it.** `POST /internal/customer-call` (X-Internal-Secret), the same pattern as `/cache/invalidate`. Twilio `calls.create` is called with:
  - from the org's number to the customer;
  - `MachineDetection=DetectMessageEnd`;
  - `Timeout=25` (seconds of ringing);
  - `TimeLimit=300`, a hard 5-minute ceiling on the call;
  - `Url` = `/twiml/customer-call/:token`;
  - `StatusCallback` = `/twiml/customer-call-status/:token` (terminal events).

  The token is HMAC-signed with `INTERNAL_API_SECRET`, expires in 15 minutes and carries ids only (no names or numbers in a URL).
- **The call row.** Inserted right after Twilio accepts the call, as `sh_<CallSid>`, with:
  - `direction` outbound;
  - `status` queued;
  - `caller_phone` = the customer;
  - `metadata.call_type = "customer_notify"`;
  - `metadata.notify = { purpose, appointment_id, requested_by_call_id }`.

  If the row can't be written, the Twilio call is cancelled and the owner told.
- **The TwiML** (Twilio signature plus the token) branches on `AnsweredBy`:
  - `human` or `unknown`: the conversation;
  - `machine_end_*`: the voicemail;
  - anything else: hang up.

  Both of the first two stream to `/ws/audio` with a server-side stream token carrying the notify context, the same token mechanism as the owner PIN line.
- **The conversation:**
  - **Context:** loaded by the org's number, as if the customer had called it. `callerPhone` is the customer, verified because we dialled it, so the receptionist's own tools find only that customer's bookings.
  - **Prompt:** the receptionist's own prompt, rules and knowledge, plus a final OUTBOUND CALL section (`lib/notify-call-prompt.js`) that says:
    - who it is calling and why;
    - make sure it's the customer before sharing any detail; with anyone else, ask them to pass on a call-back message and end the call;
    - the purpose's script;
    - only this customer's own bookings;
    - honour "don't call me again";
    - use the name already on the booking instead of collecting it again;
    - keep it short;
    - `record_call_outcome`, then `end_call`.
  - **The opener:** "Hi, this is the AI assistant at {business}, calling for {first name}. Is that you?", with the recording disclosure woven in when the existing consent rules require it.
  - **Tools:**
    - the receptionist's own tools (calendar, callback, `end_call`, and transfer under the org's own rules);
    - `record_call_outcome({ outcome, note })`, handled locally. Outcome is one of: `confirmed`, `rebooked`, `declined`, `will_call_back`, `wrong_person`, `do_not_call` or `other`.
- **The voicemail:**
  - Gemini speaks one deterministic message in the assistant's voice: who's calling, the news, and "please call us back on this number". It never names the service.
  - The call is hung up after that first turn.
  - There is no disclosure and no recording.
  - The message text is stored on the row.
- **The end of the call:**
  - **Answered:** the session's cleanup completes the row (`callType` and `notify` re-sent: `completeCallRecord` rewrites metadata) and calls call-completed.
  - **No session** (no answer, busy, failed, voicemail): the status callback finalises the row and calls call-completed.
  - **A row still in progress with no live session** (a restart mid-call): the status callback finalises it as cut off.

### The website

- **`customer-call.ts`** (new): the voice-server client for check and place, plus the spoken reasons.
  - With calls on, `getContactOptions` adds `"call"` and the note says why a call isn't possible when it isn't.
  - With calls off it stays silent; asked to call anyway, the assistant says "I can't call customers yet".
- **`contactCustomer` with `"call"`:** places the call about the cancelled booking or the new leg.
- **`handleOwnerCallCustomer`:** read-back, gate, then place.
- **call-completed**, for `call_type = "customer_notify"`:
  - no spam scoring, missed or unsuccessful alerts, caller text-back or integrations webhook;
  - **Ruling:** no plan-call billing, the default until the owner decides;
  - the outcome email, sent once (claimed on `metadata.notify_outcome_emailed_at`), after the response.

### Costs (US$, Twilio list)

| Call | Cost |
|---|---|
| Answered | ≈ 7.5¢/min to an AU mobile, plus ≈ 2.25¢/min of Gemini, plus 0.75¢ for machine detection |
| Typical 1-2 minutes | 11–20¢ |
| No answer | the 0.75¢ detection fee only |

## Testing

- **Website (vitest):**
  - who-can-be-texted (every AU prefix class, the pause, opt-out, mocked US lookup, fail-closed paths);
  - both handlers' new contract (options on the read-back, no write without a valid choice, text sent/not sent, call not available in PR 1);
  - the `sendCallerSMS` landline guard;
  - the recap builder (events, joins and contact outcomes);
  - call-completed step 4d (sent once, no events means no email, claim lost means no email, failure pages);
  - the recap template's escaping (hostile customer names);
  - source pins for the bubble wiring;
  - unit tests for its pure helpers.
- **Voice server (node:test):**
  - the owner tool schemas and prompt text;
  - the new transcript module, against a fake stream;
  - `server.js` slices run for real: the Gemini owner callbacks with Deepgram active, falling back, audio forwarded, closed at teardown.
- **Gate:** `/review-and-fix` (four lenses), then fix, re-review until clean, plus independent mutants authored by the test lens.
