# Owner Assistant on the Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The org's owner talks to the owner assistant by voice in the dashboard. Their login replaces the phone line's PIN.

**Architecture:**
- **The token.** Next.js mints a signed owner token, only for the owner role and only with the UI flag on.
- **The voice server.** The existing `/ws/test` browser-audio path turns an owner token into an owner session. A `calls` row is created up front. The session uses the phone line's owner prompt, tools, tool runner and turn stamps, and the phone line's owner post-call, on Gemini or classic according to `OWNER_PIPELINE`.
- **The dashboard.** A new `/assistant-line` page uses the existing `useVoiceTest` hook with the new token URL. It is linked from Settings → "Your assistant line".

**Tech Stack:** Next.js 15 App Router (TypeScript, vitest); the voice server in Node (node:test, `tsc` checkJs); Supabase; HMAC-SHA256 tokens signed with `TEST_CALL_SECRET`.

**Spec:** `docs/superpowers/specs/2026-10-26-owner-assistant-web-design.md`

## Global Constraints

- **Access:** the owner role only (`org_members.role === "owner"`). An admin or member gets 403.
- **Mode:** voice only; no text chat.
- **Flags:**
  - `OWNER_ASSISTANT_UI_ENABLED` gates the token route (404 when off) and the page (`notFound()` when off).
  - `OWNER_ASSISTANT_ENABLED` gates the voice server's owner branch. When off, the browser gets an error message.
- **Token:** signed with HMAC-SHA256 and `TEST_CALL_SECRET`. Its payload is `{ mode: "owner", assistantId, organizationId, userId, exp: now + 120 s, jti }`. The `jti` is used once (`testSessionCaps` already enforces that).
- **Owner mode:** the browser can never set it; only a verified owner token does. The owner tools' authority is unchanged: `ownerVerified` plus the session's own `callRecordId`.
- **Org limit:** one web owner session per org at a time. A second one closes with 4029 and the reason "Your assistant is already open in another tab."
- **Owner web sessions get:**
  - no recording, no OpenAI analysis and no re-transcription;
  - a call row with `call_type: "owner"` and `metadata.channel: "web"`;
  - `callerName` set to the owner's first name, or "Owner".
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01WsMvFfmjCv3mhYEfJW5MQB`.
- **Checks to keep green:** voice-server `npm test` and `npm run typecheck`; root `npm run lint`, `npx tsc --noEmit` and `npx vitest run`.

## File Structure

| File | Responsibility |
|---|---|
| `voice-server/lib/owner-web-session.js` (new) | The owner-token check, the session's call id, the prompt and greeting, the per-org single-session gate, and the post-call |
| `voice-server/tests/owner-web-session.test.js` (new) | Unit tests for the above |
| `voice-server/lib/call-logger.js` | `completeCallRecord` gains `channel`, written to `metadata.channel` |
| `voice-server/server.js` | The `/ws/test` owner branch: the token gate, setup, the Gemini and classic owner hooks, and cleanup |
| `voice-server/tests/server-owner-web-wiring.test.js` (new) | Source pins for the `/ws/test` owner branch |
| `src/app/api/v1/owner-assistant/token/route.ts` (new) | The owner token |
| `src/app/api/v1/owner-assistant/token/__tests__/route.test.ts` (new) | The route's contract |
| `src/app/(dashboard)/assistant-line/page.tsx` (new) | A server gate (owner and flag) that loads the org's assistant |
| `src/app/(dashboard)/assistant-line/owner-talk-panel.tsx` (new) | The voice panel (via `useVoiceTest`) |
| `src/app/(dashboard)/settings/owner-line-card.tsx` | A "Talk to it in your browser" link |

---

### Task 1: `lib/owner-web-session.js`

**Files:**
- Create: `voice-server/lib/owner-web-session.js`
- Modify: `voice-server/lib/call-logger.js` (`completeCallRecord` → `channel`)
- Test: `voice-server/tests/owner-web-session.test.js`, `voice-server/tests/call-logger-metadata.test.js`

**Interfaces (produced):**
- `isOwnerWebToken(tokenData: any): boolean`
- `ownerWebCallSid(jti: unknown): string`. The value is `web_owner_<up to 36 safe characters>`.
- `buildOwnerWebPrompt({ organization, serviceTypes, ownerFirstName, now? }): { systemPrompt: string, greeting: string }`
- `createOwnerWebSessions(): { tryOpen(orgId: string): boolean, close(orgId: string): void }`
- `finishOwnerWebSession(session, { transcript, durationSeconds }, deps): Promise<{ recordWritten: boolean }>`. The `deps` are `{ settleOwnerToolRuns, buildOwnerCallSummary, detectAndRedact, completeCallRecord, notifyCallCompleted, internalApiUrl, internalApiSecret, sleep? }`.

- [ ] **Step 1: Write the failing tests.** In `tests/owner-web-session.test.js`, cover:
  - `isOwnerWebToken` is true only for `mode === "owner"`.
  - The `ownerWebCallSid` sanitising.
  - `buildOwnerWebPrompt`:
    - uses the org-local date;
    - falls back to Australia/Sydney for a malformed zone;
    - includes the org name and the greeting with the first name.
  - The gate:
    - the first `tryOpen` is true and a second for the same org is false;
    - another org is true;
    - after `close`, `tryOpen` is true again.
  - `finishOwnerWebSession`:
    - It awaits settle, then builds the summary, then redacts when the session's `piiRedactionEnabled` is set.
    - It writes `{status:"completed", durationSeconds, transcript, summary, callerName, actionTaken:"owner_call", callType:"owner", ownerAuth:"verified", channel:"web", piiRedacted}`.
    - On a failed write it retries once (`sleep` injected).
    - It notifies with `callType:"owner"`.
    - If the row was never written, it skips the notify and logs `[ALERT:error] [OwnerWeb]`.
    - With no `callRecordId`, it warns and writes nothing.
- [ ] **Step 2:** Run `node --test tests/owner-web-session.test.js`. Expected: FAIL (the module doesn't exist).
- [ ] **Step 3: Implement the module.**
  - It mirrors server.js cleanupSession's owner branch (settle → summary → PII → write with one retry → notify, or page).
  - The prompt uses the phone's org-timezone fallback.
- [ ] **Step 4: Add the `channel` field to `completeCallRecord`.**
  - Add `@param {"web"|null} [fields.channel]` and `...(channel && { channel })` to `metadataExtras`.
  - Add a test in `tests/call-logger-metadata.test.js`.
- [ ] **Step 5:** Run the tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(SCRUM-596): owner web session helpers — token check, prompt, one-per-org gate, owner post-call`

### Task 2: the `/ws/test` owner branch (server.js)

**Files:**
- Modify: `voice-server/server.js` (the `/ws/test` connection handler, the test Gemini callbacks, the classic test block, `handleTestUserSpeech`, `cleanupTestSession`)
- Test: `voice-server/tests/server-owner-web-wiring.test.js`

**Interfaces:**
- Consumes everything from Task 1.
- Also consumes these existing functions:
  - `ownerAssistantEnabled()` (lib/owner-auth)
  - `loadOwnerFirstName(orgId)` (lib/owner-context)
  - `resolveOwnerPipeline()` (lib/pipeline-routing)
  - `buildOwnerTools()`, `buildOwnerGeminiSuffix()`
  - `runOwnerToolCall`, `ownerToolLoopReply`, `noteCancelledOwnerToolCalls`, `settleOwnerToolRuns`, `buildOwnerCallSummary`
  - `noteAssistantSpeech`, `noteAssistantTurnEnd`, `noteOwnerSpeech`
  - `createCallRecord`, `completeCallRecord`, `notifyCallCompleted`, `detectAndRedact`

Edits, in order:

1. **The token gate**, after the caps reservation:
   - If `isOwnerWebToken(tokenData)` and `!ownerAssistantEnabled()`: send `{type:"error", message:"The owner assistant is switched off."}`, then `ws.close(4004, ...)` and release the slot.
   - If `!ownerWebSessions.tryOpen(organizationId)`: `ws.close(4029, "Your assistant is already open in another tab.")` and release the slot.
   - `cleanupTestSession` closes the org slot exactly once.
2. **Setup** (inside the init IIFE, after the session is constructed):
   - Set the owner session's fields: `ownerMode = true`, `ownerAuth = "verified"`, `callSid = ownerWebCallSid(jti)`, `ownerFirstName = await loadOwnerFirstName(organizationId)` and `piiRedactionEnabled = !!context.assistant.settings?.piiRedactionEnabled`.
   - Set `callRecordId = await createCallRecord({ orgId: organizationId, assistantId, phoneNumberId: null, callerPhone: null, callSid })`.
   - If no id comes back, send an error ("Couldn't start your assistant — please try again."), then `ws.close(4500)`.
   - The system prompt is `buildOwnerWebPrompt(...)`. There is no schedule snapshot, no after-hours handling and no disclosure.
3. **Pipeline:** use `useGeminiLive = (owner ? resolveOwnerPipeline() === "gemini-live" : VOICE_PIPELINE === "gemini-live") && GEMINI_API_KEY`.
4. **Gemini, owner:**
   - `tools = buildOwnerTools()`.
   - The prompt is the owner prompt, plus `buildOwnerGeminiSuffix()`, plus the first-message instruction speaking `buildOwnerGreeting(...)`. It skips the customer rules and the language rewrites.
   - The callbacks are guarded with `session?.ownerMode`:
     - `onAudio` → `noteAssistantSpeech`.
     - `onToolCall` → `runOwnerToolCall(session, toolCall, { executeToolCall, scheduleCache, sendText })`, with `_toolCallInFlight` set.
     - `onTranscriptIn` → `noteOwnerSpeech`.
     - `onInterrupted` → `noteAssistantTurnEnd`.
     - `onTurnComplete(turnInfo)` → `noteAssistantTurnEnd` unless `turnInfo?.endedWithToolCalls`.
     - A new `onToolCallCancellation` → `noteCancelledOwnerToolCalls`.
5. **Classic, owner:**
   - There is no disclosure. The greeting is `buildOwnerGreeting`. The STT final calls `noteOwnerSpeech`.
   - In `handleTestUserSpeech`:
     - The tools are owner tools.
     - Each tool call goes through `runOwnerToolCall`, with the message plus data as the tool content (as in the phone's classic loop).
     - Loop exhaustion → `ownerToolLoopReply`.
     - After each sentence's audio → `noteAssistantSpeech`. After a reply → `noteAssistantTurnEnd`.
     - On `__endCall`, after the reply's audio, send `{type:"ended", reason:"owner-ended"}` and close after a 1.5 s grace.
6. **Cleanup:** if `session.ownerMode`, `await finishOwnerWebSession(session, { transcript: session.getTranscript(), durationSeconds: session.getDurationSeconds() }, deps)` before `session.destroy()`, then close the org slot.

- [ ] **Step 1: Write the wiring tests**, as source pins on the `/ws/test` handler slice:
  - the owner-token gate and the flag check;
  - `ownerWebSessions.tryOpen` and `close`;
  - `createCallRecord` before any tool can run;
  - every owner hook listed above;
  - `testMode` never set on an owner tool call;
  - `finishOwnerWebSession` in cleanup;
  - an unchanged customer test path (`testMode: true` is still present for non-owner sessions).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Make edits 1–6.
- [ ] **Step 4:** Run the full voice-server `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(SCRUM-596): /ws/test serves the owner assistant to a verified owner token (Gemini and classic)`

### Task 3: the token route (Next.js)

**Files:**
- Create: `src/app/api/v1/owner-assistant/token/route.ts`
- Test: `src/app/api/v1/owner-assistant/token/__tests__/route.test.ts` (the mocking pattern of `owner-access/__tests__/route.test.ts`)

Behaviour, in order:
1. The flag is off → 404.
2. No user → 401.
3. No membership → 404.
4. The role isn't owner → 403, "Only the business owner can talk to the assistant here."
5. The body's `assistantId` is missing or not a string → 400.
6. The assistant isn't in the org → 404.
7. `rateLimitDistributed(createAdminClient(), user.id, "owner-assistant-token", "auth")` isn't allowed → 429 with headers.
8. `TEST_CALL_SECRET` or `VOICE_SERVER_PUBLIC_URL` is missing → 503.
9. Otherwise, sign `{ mode: "owner", assistantId, organizationId, userId, exp: Date.now() + 120_000, jti: randomUUID() }` exactly as the test-call route does, and return `{ token, wsUrl: <ws(s)>/ws/test }`.

- [ ] **Step 1:** Write the tests:
  - one per branch;
  - the signature verifies with the secret;
  - the payload has exactly those keys;
  - the token never appears in logs.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the route.
- [ ] **Step 4:** Run `npx vitest run src/app/api/v1/owner-assistant` and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(SCRUM-596): owner-only token for the assistant in the browser`

### Task 4: the page, the panel and the Settings link (Next.js)

**Files:**
- Create: `src/app/(dashboard)/assistant-line/page.tsx`, `src/app/(dashboard)/assistant-line/owner-talk-panel.tsx`
- Modify: `src/app/(dashboard)/settings/owner-line-card.tsx`
- Test: `src/app/(dashboard)/assistant-line/__tests__/owner-talk-panel.test.tsx` (or a source test, as `use-voice-test-playback.source.test.ts` does)

- **The page** is a server component. It calls `notFound()` unless the user is the owner and `isOwnerAssistantUiEnabled()`. It loads the org's first active assistant (or shows a "create an assistant first" empty state) and renders `<OwnerTalkPanel assistantId=... />`.
- **The panel** uses `useVoiceTest({ assistantId, tokenUrl: "/api/v1/owner-assistant/token" })`. It shows:
  - a short explainer ("Ask about today's jobs, your messages, or move or cancel a booking. It reads every change back and waits for your yes.");
  - Start, Mute and End buttons;
  - the status;
  - the live transcript;
  - an error alert that shows the server's message;
  - the loading, ended and error states.
- **The card** gets a "Talk to it in your browser" link button to `/assistant-line`.

- [ ] **Step 1:** Write the tests:
  - the panel calls the hook with the owner token URL;
  - the Settings card links to `/assistant-line`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the root lint, `tsc` and vitest. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(SCRUM-596): dashboard page to talk to your assistant (owner only)`

### Task 5: the gate and the PR

- [ ] All the checks (the voice-server tests and typecheck; the root lint, tsc and vitest).
- [ ] The 4-lens review: security, code, silent failures, tests. Fix the findings and re-review until clean.
- [ ] The client simulator (the client-personas skill), for the tradie and first-time-user personas.
- [ ] Mutation testing on:
  - the token route's gates (the flag, auth, membership, role, assistant, rate limit, config, payload keys);
  - the voice server's owner gate (the token mode, the flag, the org slot, the call record before tools, `testMode` absent).
- [ ] A PR into `develop` whose body has the deploy steps:
  1. Voice server: `deploy.sh`, run by the owner.
  2. A release PR from `develop` to `main`, merged by the owner with a merge commit.
  3. `OWNER_ASSISTANT_ENABLED=true` on Fly.
  4. `OWNER_ASSISTANT_UI_ENABLED=true` on Vercel.
