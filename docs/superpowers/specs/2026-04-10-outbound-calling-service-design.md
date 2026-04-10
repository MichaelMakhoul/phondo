# Outbound Calling Service — Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Author:** Claude + Michael

---

## Overview

An outbound calling service built into the existing voice server that uses Gemini 3.1 Flash Live to place real Twilio calls to the inbound system. Purpose: automated end-to-end testing of the AI receptionist across multiple industries, scenarios, and edge cases.

**Phase 1 (this spec):** Automated test calling — API-driven, triggered by Claude Code, evaluates transcripts locally.
**Phase 2 (future):** Business-facing outbound (appointment reminders, follow-ups, etc.).

---

## Architecture

### Approach

Voice server module with process isolation (Approach C). The outbound logic lives as a self-contained module within `voice-server/` — no new deployment target. Each outbound Gemini session is independent from inbound sessions.

### Layers

1. **API Layer** — Express endpoints on the voice server (`POST /outbound/call`, `/outbound/suite`, `/outbound/setup-fixtures`), secured with `INTERNAL_API_SECRET`.
2. **Call Orchestration** — `voice-server/services/outbound-caller.js` initiates Twilio outbound calls, manages Gemini Live sessions with scenario personas, collects transcripts.
3. **Results** — Raw transcript, call metadata, and scenario info returned to caller. No automated evaluation — Claude Code analyzes transcripts locally.

### Call Flow

```
API Request → Twilio REST API (create call) → Twilio dials target number
    |
Target answers → Twilio sends TwiML callback to voice server
    |
Voice server returns <Connect><Stream> TwiML → bidirectional audio stream
    |
Outbound Gemini session receives inbound AI audio, responds as scenario persona
    |
Call ends → Transcript collected → Results returned to API caller
```

### Audio Flow

```
Inbound AI speaks → Twilio captures audio → Media Stream → /ws/outbound
    → Outbound Gemini hears it, generates response
    → Gemini audio → Media Stream → Twilio plays to inbound AI
    → Inbound AI hears it as normal caller audio
```

---

## API Design

### `POST /outbound/call` — Single Call

**Request:**
```json
{
  "targetNumber": "+61299999999",
  "industry": "dental",
  "scenario": {
    "name": "Book dental cleaning",
    "persona": "Sarah, a 32-year-old new patient",
    "prompt": "You are calling to book a dental cleaning for next Wednesday afternoon...",
    "expectedOutcomes": ["appointment_booked", "name_collected"]
  },
  "maxDurationSeconds": 120,
  "voiceName": "Kore"
}
```

Or with a built-in scenario:
```json
{
  "targetNumber": "+61299999999",
  "industry": "dental",
  "scenarioId": "book-happy-path",
  "maxDurationSeconds": 120
}
```

**Fields:**
- `targetNumber` — The Twilio phone number to dial (the inbound number).
- `industry` — (optional) Which test assistant should answer. Triggers assistant swap on the target number.
- `scenario` — Custom scenario with name, persona, prompt, and optional expectedOutcomes.
- `scenarioId` — Use a built-in scenario instead of custom.
- `maxDurationSeconds` — Auto-hangup safety net (default: 180).
- `voiceName` — Gemini voice for the outbound caller (default: "Kore").

**Response (synchronous — holds connection until call completes):**
```json
{
  "status": "completed",
  "scenario": {
    "id": "book-happy-path",
    "name": "Happy path booking",
    "industry": "dental"
  },
  "call": {
    "sid": "CA...",
    "from": "+61400000000",
    "to": "+61299999999",
    "duration": 87,
    "startedAt": "2026-04-10T14:30:00Z",
    "endedAt": "2026-04-10T14:31:27Z"
  },
  "transcript": [
    { "role": "inbound", "text": "Thanks for calling Smile Hub Dental, how can I help?" },
    { "role": "outbound", "text": "Hi, I'd like to book a dental cleaning..." }
  ],
  "expectedOutcomes": ["name_collected", "appointment_booked", "details_confirmed"]
}
```

### `POST /outbound/suite` — Batch Run

**Request:**
```json
{
  "targetNumber": "+61299999999",
  "scenarios": [
    { "scenarioId": "book-happy-path", "industry": "dental" },
    { "scenarioId": "book-happy-path", "industry": "legal" },
    { "scenarioId": "emergency-call", "industry": "home_services" },
    { "name": "Custom test", "persona": "...", "prompt": "...", "industry": "medical" }
  ],
  "delayBetweenCallsMs": 20000,
  "rateLimitMode": "free",
  "maxDurationSeconds": 120
}
```

**Response:**
```json
{
  "results": [
    { "status": "completed", "scenario": { ... }, "call": { ... }, "transcript": [...] },
    { "status": "failed", "scenario": { ... }, "error": "Gemini rate limited" }
  ],
  "summary": {
    "total": 4,
    "completed": 3,
    "failed": 1,
    "totalDuration": 261,
    "wallClockSeconds": 341
  }
}
```

Scenarios run sequentially with configurable delay between calls (default 15s for free tier).

### `POST /outbound/setup-fixtures` — Create Test Orgs/Assistants

**Request:**
```json
{
  "industries": ["dental", "legal", "home_services", "medical", "real_estate", "salon"]
}
```

Or no body to create all fixtures.

**Response:**
```json
{
  "fixtures": [
    { "industry": "dental", "orgId": "...", "assistantId": "...", "status": "created" },
    { "industry": "legal", "orgId": "...", "assistantId": "...", "status": "already_exists" }
  ]
}
```

Idempotent — running twice doesn't duplicate.

---

## Outbound Call Mechanics

### How Twilio outbound calls work with Media Streams

1. **Initiate call** via Twilio REST API:
   ```js
   twilioClient.calls.create({
     to: targetNumber,
     from: outboundNumber,
     url: `${PUBLIC_URL}/outbound/twiml/${callToken}`,
     statusCallback: `${PUBLIC_URL}/outbound/status/${callToken}`,
     statusCallbackEvent: ['completed'],
   })
   ```

2. **Twilio dials target** — when it connects, requests TwiML from the callback URL.

3. **Voice server returns TwiML**:
   ```xml
   <Response>
     <Connect>
       <Stream url="wss://voice-server/ws/outbound?token=callToken" />
     </Connect>
   </Response>
   ```

4. **WebSocket connects** (`/ws/outbound`) — bidirectional audio stream established. Outbound Gemini session created with scenario prompt.

### Call token pattern

Same HMAC token pattern as test calls:
- `/outbound/call` generates a short-lived token containing scenario config
- `/outbound/twiml/:token` verifies and returns TwiML
- `/ws/outbound?token=...` consumes the token and creates the Gemini session

### Outbound AI system prompt template

```
You are role-playing as a caller in a phone conversation.

PERSONA: {scenario.persona}

YOUR GOAL: {scenario.prompt}

RULES:
- You are the CALLER, not the receptionist. Wait for the receptionist to greet you, then respond.
- Stay in character throughout the call.
- Be natural — use filler words, pauses, and conversational language like a real person.
- When your goal is accomplished (or clearly cannot be accomplished), end the call naturally by saying goodbye.
- Do NOT mention that you are an AI or that this is a test.
```

### Call lifecycle

- API request is **synchronous** — holds HTTP connection until the call completes or times out.
- `maxDurationSeconds` timer auto-hangs up via `twilioClient.calls(callSid).update({ status: 'completed' })`.
- Outbound Gemini session's `onClose` triggers transcript collection and response.

---

## Multi-Industry Test Fixtures

### Test organizations and assistants

| Industry | Org Name | Key Config |
|---|---|---|
| `dental` | Smile Hub Dental | Check-up, filling, cleaning services. Dr. Sarah Chen, Dr. James Park. Mon-Fri 8am-5pm, Sat 8am-12pm. |
| `legal` | Parker & Associates Law | Consultation, case review services. Professional tone. No legal advice. |
| `home_services` | QuickFix Plumbing | Emergency repair, routine maintenance. Casual tone. Captures address + job details. |
| `medical` | Northside Medical Clinic | GP consultation, blood test, vaccination. Dr. Emily White, Dr. Raj Patel. |
| `real_estate` | Harbour Realty | Property inspection, valuation. Captures property address + buyer/seller intent. |
| `salon` | Luxe Hair Studio | Cut, colour, styling. Captures hair type/length. Casual friendly tone. |

Each fixture gets:
- Prompt config via prompt builder (industry template)
- Knowledge base with realistic FAQ/pricing
- Business hours, timezone (Australia/Sydney), recording consent
- Service types and practitioners
- Deterministic UUID per industry for idempotency

### Assistant swapping

Since one inbound number is used, the service swaps assistants per call:

1. Before call: Save current `assistant_id` on the phone number
2. Update `assistant_id` to the target industry's test assistant
3. Run the call
4. After call completes: Restore original `assistant_id`

For suites, the swap happens per-call so industries can be mixed.

---

## Gemini Free Tier Rate Limiting

Each test call uses **two** simultaneous Gemini sessions (outbound caller + inbound receptionist).

### Pacing strategy

- `delayBetweenCallsMs` defaults to `15000` (15s) for suites
- `rateLimitMode`:
  - `"free"` (default) — Conservative pacing: 15s minimum between calls, retry on 429
  - `"paid"` — No artificial delay, just configured `delayBetweenCallsMs`
- **Retry on 429** — If Gemini returns rate limit error during session setup, wait 60s and retry once
- **Suite pacing log**: `[Outbound] 47 scenarios remaining, pacing at 20s between calls (~31 min total)`

---

## Scenario Library

47 built-in scenarios in `voice-server/lib/outbound-scenarios.js`.

### Core Booking Flow
| ID | Name | Summary |
|---|---|---|
| `book-happy-path` | Happy path booking | New patient books, spells name, confirms details |
| `book-specific-time` | Specific time request | "I want a filling next Thursday at 2pm" |
| `book-no-slots` | No available slots | Request a blocked date, expect alternatives |
| `book-past-time` | Booking in the past | "Can I book for this morning at 8am?" |

### Name Collection Edge Cases
| ID | Name | Summary |
|---|---|---|
| `name-refuse` | Refuse to give name | "I'd rather not say" |
| `name-first-only` | Only first name | "Just Sarah is fine" |
| `name-non-english` | Non-English name | Arabic name, spell in English when asked |
| `name-correction` | Name correction mid-flow | "Actually that's wrong" |
| `name-very-long` | Extremely long name | Multi-word Middle Eastern name |

### Appointment Lookup & Verification
| ID | Name | Summary |
|---|---|---|
| `lookup-by-code` | Lookup with confirmation code | Give real 6-digit code + name verification |
| `lookup-no-code` | Lookup without code | Fall back to name + phone |
| `lookup-wrong-code` | Wrong confirmation code | "123456" — should not reveal details |
| `lookup-wrong-name` | Security test — wrong name | Correct code but wrong name |

### Rescheduling
| ID | Name | Summary |
|---|---|---|
| `reschedule-different-day` | Reschedule to next week | Lookup, cancel old, book new |
| `reschedule-blocked-date` | Reschedule to blocked time | Should offer alternatives |

### Cancellation
| ID | Name | Summary |
|---|---|---|
| `cancel-by-code` | Cancel by confirmation code | Verify identity, confirm cancellation |
| `cancel-by-phone` | Cancel without code | Use caller ID |

### Phone Number Validation
| ID | Name | Summary |
|---|---|---|
| `phone-invalid` | Invalid phone number | "1-2-3-4" — should reject |
| `phone-caller-id` | Use caller ID | No digit-by-digit read-back |

### Multilingual
| ID | Name | Summary |
|---|---|---|
| `lang-arabic` | Arabic conversation | Full booking in Arabic |
| `lang-switch-midcall` | Language switch mid-call | English to Arabic |
| `lang-unsupported` | Unsupported language | French with multilingual OFF |
| `lang-spanish` | Spanish caller | Full booking in Spanish |

### Accent & Speech Patterns
| ID | Name | Summary |
|---|---|---|
| `accent-heavy-indian` | Heavy Indian accent | Indian English patterns, test STT accuracy |
| `accent-australian` | Broad Australian accent | Aussie slang, fast speech |
| `accent-chinese-english` | Chinese-accented English | Tonal patterns, shorter sentences |
| `accent-middle-eastern` | Middle Eastern accent | Arabic-influenced English |
| `accent-elderly-slow` | Elderly slow speaker | Long pauses, repetition, "um"/"ah" |
| `accent-fast-talker` | Rapid-fire speaker | Extremely fast, interrupts AI |
| `accent-soft-spoken` | Very quiet speaker | Barely above a whisper |
| `accent-background-noise` | Noisy environment | Interruptions, "can you hear me?" |

### Business Hours & After Hours
| ID | Name | Summary |
|---|---|---|
| `after-hours-call` | After hours call | Expect acknowledgment + next-day offer |
| `weekend-availability` | Weekend availability | "Do you have anything Saturday?" |

### Recording & Disclosure
| ID | Name | Summary |
|---|---|---|
| `disclosure-plays` | Recording disclosure check | Listen silently at start |
| `recording-opt-out` | Opt out of recording | "I don't want to be recorded" |

### Transfer & Callback
| ID | Name | Summary |
|---|---|---|
| `transfer-human` | Request human transfer | "Can I speak to a real person?" |
| `request-callback` | Request callback | "Can someone call me back?" |

### Edge Cases & Stress Tests
| ID | Name | Summary |
|---|---|---|
| `silence-test` | Silence for 15 seconds | AI should prompt "Are you there?" |
| `rapid-topic-change` | Rapid topic changes | Book → hours → cancel → book |
| `pricing-inquiry` | Ask about pricing | "How much does a check-up cost?" |
| `emergency-call` | Emergency/urgent | "I'm in severe pain!" |
| `spam-nonsense` | Spam/jailbreak attempt | Try to get AI off-topic |
| `angry-caller` | Frustrated caller | Upset, demanding resolution |
| `vague-caller` | Vague and unclear | "I don't know... maybe..." |
| `opt-out-ai` | Wants to opt out of AI | "I don't want to talk to a robot" |

### Different Business Types
| ID | Name | Summary |
|---|---|---|
| `industry-legal` | Legal firm caller | Professional tone, no legal advice |
| `industry-trades` | Plumber/trades caller | "My pipe burst!" — urgency, address |

### Confirmation & Correction
| ID | Name | Summary |
|---|---|---|
| `correct-booking` | Correct wrong details | "Actually the name is wrong" |
| `confirm-readback` | Verify full read-back | AI must read back all details |

### Industry adaptation

Scenarios get industry-appropriate prompt variants via `getScenarioForIndustry(scenarioId, industry)`. For example, `book-happy-path` with `industry: "legal"` becomes a consultation booking instead of a dental cleaning.

---

## Error Handling

| Situation | Status | Behavior |
|---|---|---|
| Call completes normally | `"completed"` | Full transcript + metadata |
| Outbound AI says goodbye | `"completed"` | Normal completion |
| Max duration reached | `"timeout"` | Partial transcript, Twilio force-hangs up |
| Target doesn't answer | `"no_answer"` | No transcript |
| Twilio error | `"failed"` | Error message from Twilio |
| Gemini 429 rate limit | Retry once after 60s | If retry fails: `"failed"` |
| Gemini session crash | `"failed"` | Partial transcript if available |
| Assistant swap DB error | `"failed"` | Call not attempted, original assistant unchanged |

### Suite timeout

Total HTTP timeout = `(scenarios * maxDurationSeconds) + (scenarios * delayBetweenCallsMs) + 30s buffer`

Logged at start: `[Outbound] Suite started: 5 scenarios, estimated max 18m 30s`

---

## File Structure

### New files
```
voice-server/
  services/
    outbound-caller.js      # Core: makeOutboundCall(), runOutboundSuite()
  lib/
    outbound-scenarios.js   # 47 built-in scenarios + getScenarioForIndustry()
    outbound-fixtures.js    # Test org/assistant creation + assistant swapping
```

### Changes to existing files

**`voice-server/server.js`:**
1. Import outbound module
2. Add endpoints: `POST /outbound/call`, `/outbound/suite`, `/outbound/setup-fixtures`, `/outbound/twiml/:token`
3. Add `/ws/outbound` to WebSocket upgrade routing
4. New `WebSocketServer` instance for outbound

**No changes to:**
- `services/gemini-live.js` — used as-is
- `lib/audio-converter.js` — used as-is
- `lib/call-context.js` — not needed for outbound
- `call-session.js` — not used for outbound (simpler lifecycle)

### Dependencies

No new npm packages. Uses existing: `twilio`, `ws`, `crypto` (built-in).

### Environment variables

No new required vars. One optional:
- `OUTBOUND_CALLER_NUMBER` — Dedicated Twilio number for outbound. If not set, `setup-fixtures` buys one and logs it.

---

## Future Expansion (Phase 2)

When expanding for business use, this foundation supports:
- Appointment reminder calls (outbound Gemini reads appointment details, confirms attendance)
- Follow-up calls (post-visit satisfaction, rescheduling)
- Custom outbound campaigns (businesses define their own prompts)
- Outbound call records in the dashboard (new `direction: "outbound"` field on calls table)

Phase 2 will need its own spec. This spec covers Phase 1 (testing) only.
