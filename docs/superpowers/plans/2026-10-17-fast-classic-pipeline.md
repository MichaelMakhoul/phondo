# Fast classic pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the demo line is answered by Deepgram Flux hearing, Claude Haiku 5.5 thinking and Aura-2 streaming voice, all on Deepgram's Sydney host. The target is about 1.6–1.8 s from the caller's last sound to the AI's first sound, behind `DEMO_LINE_PIPELINE=classic-fast`.

**Architecture:** the existing classic handler gains a `session.fastPath` mode.
- New clients: Flux STT, Aura WS TTS and a Twilio player.
- A pure Flux turn engine and a speculative-draft helper.
- Clause-level chunking in `streamClaudeResponse`.
- Routing at the single selection site.
- A classic `end_call` hang-up fix that both modes share.

**Tech stack:** Node 20 CommonJS, `ws`, node:test, and `tsc` checkJs.

**Spec:** `docs/superpowers/specs/2026-10-17-fast-classic-pipeline-design.md`. It is the authority; read it in full. The facts from the code map are in `scratchpad/fast/classic-map.md`, and the wire-level API reference is in `scratchpad/fast/flux-aura-api.md`. Both live under `/private/tmp/claude-501/-Users-michaelmakhoul-projects-phondo-voice-server/bcc0f861-4adf-418e-9125-635df7b7eb38/scratchpad/fast/`.

## Global Constraints
- Work only in the worktree `/private/tmp/claude-501/-Users-michaelmakhoul-projects-phondo-voice-server/bcc0f861-4adf-418e-9125-635df7b7eb38/scratchpad/wt-fast` on branch `feature/SCRUM-594-fast-classic-pipeline`. Run commands from `voice-server/`.
- `npm test` (all files) and `npm run typecheck` must pass at the end of every task. Test output stays pristine: tests capture or silence expected console lines.
- Every new Deepgram URL carries `mip_opt_out=true` and uses the host from `FAST_DEEPGRAM_HOST` (default `api.au.deepgram.com`).
- Never send `{"type":"KeepAlive"}` to Flux. Keep the connection alive with WebSocket pings only.
- Never log caller words, transcripts, model text or keys unless `DEBUG_TRANSCRIPTS` is set (SCRUM-339).
- **Ownership of Sentry captures:** new client modules (`flux-stt`, `aura-stream`, `fast-player`, `fast-turns`, `speculative-reply`) do not import Sentry; they report through callbacks. Only `server.js` and `lib/end-call-guard.js` capture. Register any new production file that captures in the Sentry census tests (`server-sentry-sites`, `sentry-reasons-coverage`).
- **server.js count pins** (classic-map.md "Tests"):
  - `resolveOwnerPipeline(` appears exactly once.
  - `organizationId === DEMO_ORG_ID || isDemoLineNumber(calledNumber)` appears exactly twice.
  - There are 3 reason-tagged Sentry sites.
  - Don't duplicate the tool loop.
- **JSDoc:** use ASCII hyphens after `@param` names. When fields are added to the `executeToolCall` context, update its typedef.
- **Commits:** `feat(SCRUM-594): …` / `fix(SCRUM-594): …` / `test(SCRUM-594): …` ending with
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WsMvFfmjCv3mhYEfJW5MQB
  ```
- **No subagents:** implementers never dispatch subagents.

---

### Task 1: Deepgram streaming clients and the Twilio player (new modules only)

**Files:**
- Create: `services/flux-stt.js`, `services/aura-stream.js`, `lib/fast-player.js`
- Modify: `services/deepgram-stt.js` (export `buildKeytermsParam` only)
- Tests: `tests/flux-stt.test.js`, `tests/aura-stream.test.js`, `tests/fast-player.test.js`. Use a local `ws` `WebSocketServer` on an ephemeral port as the fake Deepgram, and inject the host as `127.0.0.1:<port>` with a `ws://` scheme override option for tests.

**Interfaces it produces** (exact names; spec §4.1-4.3):

```js
openFluxStream(apiKey, { onOpen, onTurnInfo, onError, onClose }, { host, industry, eotThreshold, eagerEotThreshold, eotTimeoutMs, scheme })
```
- **Returns** `{ readyState, send(buf), close(), configure(obj), forceEndTurn() }`. `readyState` is a getter that mirrors the socket.
- **`onTurnInfo`** receives `{ event, turnIndex, transcript, eotConfidence, trigger }`. Updates with an empty transcript are dropped.
- **`fluxConfigFromEnv(env)`** returns `{ eotThreshold, eagerEotThreshold|null, eotTimeoutMs }`.
  - It validates the ranges (eot 0.5–1, eager 0.3–0.9 and ≤ eot, timeout 500–60000).
  - Eager `off` gives null.
  - An invalid value warns once and falls back to the default (0.7 / 0.4 / 5000).
- **URL params**, exactly: model, encoding, sample_rate, eot_threshold, eager_eot_threshold (omitted when null), eot_timeout_ms, mip_opt_out=true, then the keyterms.
- **Pings** every 30 s; the timer is cleared on close. `close()` sends `{"type":"CloseStream"}` and then closes.
- **`onClose(code, reason, { initiatedByUs })`:** `initiatedByUs` is true only after our own `close()`.
- **Error frames** read `description` (falling back to `code`).

```js
openAuraStream(apiKey, { voice, host, scheme, onAudio, onFlushed, onCleared, onWarning, onError, onClose })
```
- **Returns** `{ ready: Promise<void>, isOpen(), speak(text), flush() → seq|null, clear(), close(), flushesInLastMinute() }`.
- **`speak`:**
  - trims; empty text is a no-op
  - splits text over 2000 chars at sentence ends, then at the last space
  - sends `{"type":"Speak","text": <text>+" "}`
- **`flush`** keeps a 60 s sliding window and refuses, returning null, once 18 are in the window. It returns the expected sequence id, counted from 0 per connection.
- **`clear`** sends Clear and suppresses `onAudio` until `Cleared`.
- **Pings** every 30 s.
- **Messages:** only Speak, Flush, Clear and Close are ever sent. Warnings parse `warn_code`/`warn_msg`.

```js
createFastPlayer({ sendJson, streamSid, now })
```
- **Returns** `{ push(buf), endUtterance() → markName, onMark(name) → boolean, isPlaying(), whenIdle(capMs) → Promise, stop(), stats() }`.
- **`push`** re-chunks into 160-byte frames. Each frame is sent as `{"event":"media","streamSid":…,"media":{"payload":<base64>}}`.
- **`endUtterance`** flushes any partial frame, then sends `{"event":"mark","streamSid":…,"mark":{"name":"fast-<n>"}}`.
- **`whenIdle`** resolves when no marks are outstanding, or at `max(estimated remaining playback from bytes, 0) + capMs`.
- **`stop`** sends `{"event":"clear","streamSid":…}` and resets.
- **`stats`** returns `{ firstAudioAt, bytesSent }` for the current utterance.

**Steps:**
- [ ] Write the failing tests for each module against the fake WS server:
  - URL and params (including `mip_opt_out=true`, and no unknown params on Flux)
  - turn event mapping, and empty Updates dropped
  - CloseStream on close
  - no JSON KeepAlive ever
  - ping timer cleared on close
  - Aura: trailing space on Speak, the 2000-char split, flush budget (the 19th returns null), Clear suppression until Cleared, invalid messages never sent
  - player: re-chunking, marks, `isPlaying`, `whenIdle`, `stop`
- [ ] Implement until green.
- [ ] Run `npm test` and `npm run typecheck`.
- [ ] Spot-check mutations: drop `mip_opt_out`, send a KeepAlive, remove the trailing space, remove the flush budget. Each must fail a test.
- [ ] Commit.

### Task 2: Clause chunking and the speculative draft

**Files:**
- Modify: `services/claude-chat.js`
- Create: `lib/speculative-reply.js`
- Tests: `tests/claude-chat-clause.test.js`, `tests/speculative-reply.test.js`. Mock `globalThis.fetch` with an SSE body built from Anthropic events.

**Interfaces it produces** (spec §4.4, §4.5):
- **`streamClaudeResponse(messages, { …existing, chunking })`.**
  - With `chunking:"clause"`, the first chunk may end at `[,;:—–]` followed by whitespace once it has 3 or more words; later chunks use the existing SENTENCE_BREAK.
  - Without the option, behaviour is byte-identical (pin it).
  - In every mode, any buffered text without terminal punctuation is emitted through `onSentence` before a `tool_calls` result is returned, and at the end of content. Verify the current behaviour first and pin it.
- **`startSpeculativeReply({ llm, messages, transcript, llmOptions, turnKey })`** returns `{ turnKey, transcript, status() → "running"|"done"|"aborted"|"adopted", isAdoptable(currentMessages, transcript), adopt(onSentence) → Promise<result>, abort(reason) }`.
  - It never mutates `messages`.
  - It never runs tools.
  - Its own `AbortController` is wired to `llm`'s `signal`.
  - It swallows `AbortError` and resolves the result as `{ type:"aborted" }`.
  - `adopt` replays the buffered chunks in order and synchronously, then forwards the live ones. It can be called once.
  - `isAdoptable` requires: not aborted, the same array object and length as at start, and a transcript that is `===`.

**Steps:**
- [ ] Write the failing tests:
  - clause break after 3+ words, and not before
  - "9:30" and "1,500" not split
  - later chunks are sentence-sized
  - default mode is unchanged
  - a preamble with no final punctuation is emitted before tool_calls
  - drafts: adopt replays then streams; abort stops fetch through the signal; `isAdoptable` false on each failed precondition; a tool_calls result is stored, not executed; adopt after abort rejects or returns aborted (choose one and pin it)
- [ ] Implement, run tests and typecheck, run mutation spot-checks, then commit.

### Task 3: The Flux turn engine (pure)

**Files:**
- Create: `lib/fast-turns.js`
- Test: `tests/fast-turns.test.js`

**Interface it produces** (spec §4.6):
- `createFastTurnEngine({ getState, actions, speculationEnabled })` returns `{ onTurnInfo(evt), reset() }`.
  - `getState()` returns `{ aiSpeaking, processing, expectedInputType }`.
  - `actions` are `{ speculate, cancelSpeculation, commit, bargeIn, dropEcho, bufferStructured }`.
- It exports `INTERRUPT_RE` and `wordCount`, which must equal the classic echo regex text.

**Steps:**
- [ ] Write a failing table-driven test that covers every rule in spec §4.6. It must include:
  - one barge-in per turn
  - no speculation while speaking or processing, or for a non-general input type
  - `TurnResumed` cancels
  - an echo drop for a ≤2-word EndOfTurn while speaking, unless the interrupt word matches
  - a structured type routes to `bufferStructured` and cancels the draft
  - commit carries `trigger`
  - a StartOfTurn for a new turnIndex cancels the old draft
- [ ] Implement, run tests and typecheck, run mutations (delete each rule), then commit.

### Task 4: Routing and the classic end_call hang-up

**Files:**
- Modify: `lib/pipeline-routing.js`, `server.js` (selection at about S:2302, the `completeCallRecord` metadata, and the `handleUserSpeech` end_call path), `lib/call-logger.js` if needed for `metadata.pipeline`
- Create: `lib/end-call-guard.js`
- Tests: `tests/pipeline-routing.test.js` (extend), `tests/end-call-guard.test.js`, `tests/server-fast-routing-wiring.test.js`, `tests/server-classic-end-call-wiring.test.js`. Update `tests/server-owner-mode-wiring.test.js` pins and slice scopes as needed. Never weaken a pin; re-express it for the new text.

**Interfaces it produces** (spec §3, §4.7):
- **`resolveCallPipeline({ calledNumber, ownerMode, language, globalPipeline, demoLinePipeline, isDemoLine })`** returns `"gemini-live" | "classic" | "classic-fast"`.
  - Owner calls are never routed by it. The call site keeps the `resolveOwnerPipeline()` ternary branch, so that pin holds.
  - An unknown value warns once and is ignored.
  - A non-`en` language ignores the override and logs.
- **At the selection site:**
  - `session.effectivePipeline` is set.
  - `session.fastPath = effectivePipeline === "classic-fast"` is set at the top of the classic block. Task 5 uses it.
  - The `pipeline` value reaches `calls.metadata.pipeline` through `completeCallRecord`.
- **`checkEndCallGuard(session, reason)`** returns `{ allow:boolean, message?:string }`. It ports the Gemini guard verbatim (text, audit entry, Sentry levels). The Gemini inline guard stays untouched.
- **`handleUserSpeech`**, for every classic phone call:
  - An `end_call` blocked by the guard returns the guard message as the tool result, and the loop continues.
  - An allowed one pushes the result and stops the loop.
  - If nothing was spoken this turn, speak "Thanks for calling — goodbye." (localise if a map exists).
  - Wait for playback: the sum of `sendTTS` durations, or `session.fastPlayer?.whenIdle()` when present. Then wait 500 ms, capped at 8 s.
  - Set `session.endedReason = "end_call_tool"` and close `twilioWs` with (1000, "end_call").
  - Owner runner results that carry `__endCall` follow the same path.

**Steps:**
- [ ] Write the failing tests:
  - the resolver truth table
  - guard nudge then allow
  - a runtime-slice test (idiom B) of handleUserSpeech: an allowed end_call closes the socket after playback and makes no second LLM call; a blocked one returns the message and the loop continues
  - a source pin that the selection site uses the resolver for non-owner calls
- [ ] Implement.
- [ ] Update the existing pins and scopes.
- [ ] Run the full `npm test` and typecheck, run mutations, then commit.

### Task 5: Wire the fast path into server.js

**Files:**
- Modify: `server.js`, `call-session.js` (new fields: `fastPath`, `fastTts`, `fastPlayer`, `fastTurns`, `currentTurn`, `speculation`, `fastStats`)
- Tests: `tests/server-fast-path-wiring.test.js`. Use source pins plus runtime slices, and extend existing slice scopes where the edited ranges add free identifiers.

**Interfaces it consumes:** Tasks 1–4.

**Requirements:** spec §4.8, items 1–10, exactly. That covers:
- the Flux, Aura and player setup with the Nova fallbacks (before open within 3 s, and on an abnormal mid-call close)
- greeting and disclosure REST on the AU host. Add an optional `{ host }` to `synthesizeSpeech` and keep `mip_opt_out=true`. #443 adds that param on develop; merge develop into the branch before this task if #443 has landed.
- `sendTTS` routing with REST fallback
- flush points
- `sendClear` plus player stop
- the `fast-*` mark handling, with `isSpeaking` derived from the player
- handleUserSpeech's fast LLM call with clause chunking and signal, adoption of the iteration-0 draft, `AbortError` semantics, and no abort during tools
- the barge-in action
- `[FastTurn]` and `[FastCall]` logs, and `metadata.fastPath`
- cleanup

**Steps:**
- [ ] Write the failing wiring tests:
  - fast-branch STT selection (Flux when fast, Nova otherwise)
  - Nova fallback when Flux open fails
  - `sendTTS` uses the stream when open and REST when not
  - barge-in clears the player, Clears Aura and aborts the turn
  - an adopted draft makes no second LLM call
  - an abort keeps the user message and records the partial assistant text
  - marks drive `isSpeaking`
  - cleanup closes both sockets
  - `[FastTurn]` fields present, with no transcript text in logs
- [ ] Implement.
- [ ] Run the full `npm test` and typecheck, run mutations on each spec §4.8 item, then commit.

### Task 6: Docs, env and bench

**Files:**
- Modify: `.env.example` (`DEMO_LINE_PIPELINE`, `FAST_DEEPGRAM_HOST`, `FLUX_EOT_THRESHOLD`, `FLUX_EAGER_EOT_THRESHOLD`, `FLUX_EOT_TIMEOUT_MS`, `FAST_LLM_MODEL`), `docs/runbooks/voice-server.md` (a "Fast classic pipeline (SCRUM-594)" section covering enable/disable, log lines, fallbacks and what to compare), and a new spec §7 "Files" listing every file the PR adds or changes
- Bench: `scratchpad/fast/bench.cjs` (not committed). It runs the real Flux client, turn engine, speculative draft, `streamClaudeResponse` and Aura stream against the live APIs, using `scratchpad/hearing-ab/aura-2-hyperion-en/u*.ulaw` streamed in real time. It reports the median and p90 from the last speech frame to the first audio byte, with the draft adopted/discarded counts.

**Steps:**
- [ ] Write the docs and env entries.
- [ ] Run the bench and record the numbers in the report.
- [ ] Run `npm test` and typecheck, then commit (docs/env only).
