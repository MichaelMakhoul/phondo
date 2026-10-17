# Fast classic pipeline (SCRUM-594): design

**Status:** the owner approved the direction on 2026-10-17 ("Alright. Let's try that").

**Evidence:**
- `docs/fast-haiku-pipeline-2026-10-17.md` (local), with measured stage latencies.
- `scratchpad/fast/flux-aura-api.md`, the wire-level Flux and Aura reference, verified with live probes.
- `scratchpad/fast/classic-map.md` facts below, from a full read of the classic handler.

## 1. Goal

The demo line should be answered by Deepgram hearing and Claude Haiku 5.5 thinking, about as quickly as Gemini Live answers it today.

- **Why:** Gemini 3.8 Live mishears real phone callers.
  - It garbles languages and spelled names.
  - It heard "Nine is good" as "No, it's good" in 16 of 16 clean tests.
  - Deepgram transcribed the same calls correctly.
- **The problem with today's classic pipeline:** it is accurate but takes about 4 s per reply.

**Target:** from the caller's last sound to the AI's first sound, a median of 1.8 s or less on real calls. Gemini measured 1.5 s with our settings. The fast design estimates 1.6–1.7 s, and the Sydney endpoint should save another ~0.2–0.3 s.

**Non-goals for this PR:**
- the browser `/ws/test` path
- owner-mode calls
- non-English callers (Flux is `-en`/`-multi` only, with no Arabic)
- ElevenLabs
- Deepgram Flux TTS (`/v2/speak`)
- moving the existing Nova/REST paths to the AU host (a follow-up)
- Tier-1/Tier-2 validators and the booking pre-check, which were Gemini-specific mitigations

## 2. Where today's time goes, and what replaces it

| Stage | Today (classic) | Fast path |
|---|---|---|
| End of turn | Nova-3 final (~0.94 s) + `general` debounce 600 ms (CallSession.bufferTranscript) | **Flux** `EndOfTurn` (eot 0.7, ~0.6–1.0 s), plus a speculative LLM start on `EagerEndOfTurn` (eager 0.4, ~0.3–0.4 s) |
| LLM | `streamChatResponse` (provider-global), whole first sentence before TTS | `streamClaudeResponse` (always Claude, abortable) with **clause chunking**: the first chunk may end at a clause boundary |
| TTS | REST `synthesizeSpeech` per sentence: the whole sentence's audio before any byte (~2.25 s for a typical sentence) | **Aura-2 WebSocket**: first audio 44–97 ms on the AU host, streamed to Twilio as it arrives |
| Host | `api.deepgram.com` (Virginia, ~335 ms RTT) | `api.au.deepgram.com` (AWS Sydney, ~25 ms RTT), same key |

## 3. Routing: the switch

- New env **`DEMO_LINE_PIPELINE`**: unset by default, meaning no change.
  - When it is `classic-fast` and the called number is a demo line (`isDemoLineNumber(calledNumber)`), and it's not an owner call, and `session.language` is `en`, the call uses the fast path.
  - The values `classic` and `gemini-live` are also accepted, so the demo line can be pinned to either.
  - Any other value warns once (`[PipelineRouting] DEMO_LINE_PIPELINE "<x>" not recognised — ignoring`) and is ignored.
  - With a non-`en` assistant language the override is ignored and logged.
- The resolver `resolveCallPipeline({ calledNumber, ownerMode, language, globalPipeline, demoLinePipeline, isDemoLine })` lives in `lib/pipeline-routing.js`.
- **`server.js` integration:** S:2302 calls the resolver for non-owner calls. Owner calls keep `resolveOwnerPipeline()` unchanged.
  - The Gemini `if` still tests `effectivePipeline === "gemini-live"`.
  - Every other value falls through to the classic block, which sets `session.fastPath = effectivePipeline === "classic-fast"`.
- `calls.metadata.pipeline` records the effective pipeline. It flows through a session field into `completeCallRecord`, the way `pipelineFailover` does. It lets us compare calls later.
- **Kill switch:** `fly secrets unset DEMO_LINE_PIPELINE -a phondo-voice`. This restarts the machine, and the demo line then follows `VOICE_PIPELINE` again.

## 4. Components (new files unless noted)

### 4.1 `services/flux-stt.js`: Flux STT client
- **Signature:** `openFluxStream(apiKey, callbacks, options)` returns a handle with `readyState`, `send(Buffer)`, `close()`, `configure(obj)` and `forceEndTurn()`.
  - The handle is interface-compatible with today's `session.deepgramWs` consumers, which use only `readyState`, `send` and `close`.
- **URL:** `wss://${host}/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000&eot_threshold=…&eager_eot_threshold=…&eot_timeout_ms=…&mip_opt_out=true` + keyterms.
  - The keyterms reuse `buildKeytermsParam(industry)` from `services/deepgram-stt.js`, which must be exported.
  - **No other params:** unknown params give HTTP 400.
- **Callbacks:**
  - `onOpen()`
  - `onTurnInfo({ event, turnIndex, transcript, eotConfidence, trigger })` for StartOfTurn, Update, EagerEndOfTurn, TurnResumed and EndOfTurn. Updates with an empty transcript are dropped inside the client.
  - `onError(err)`, which reads `description`, not `message`.
  - `onClose(code, reason)`
- **Keepalive** is a WebSocket ping every 30 s. **Never send `{"type":"KeepAlive"}`**: Flux treats it as a fatal error.
- **On close:** send `{"type":"CloseStream"}`, then close the socket.
- **Close code 1005** is ambiguous on Flux. Treat any close we didn't initiate as abnormal.
- **Env:**
  - `FLUX_EOT_THRESHOLD` (0.5–1.0, default 0.7)
  - `FLUX_EAGER_EOT_THRESHOLD` (0.3–0.9 and ≤ eot, default 0.4; `off` disables speculation)
  - `FLUX_EOT_TIMEOUT_MS` (500–60000, default 5000)
  - An invalid value warns and uses the default.

### 4.2 `services/aura-stream.js`: Aura-2 WebSocket TTS client
- **Signature:** `openAuraStream(apiKey, { voice, host, onAudio(buf), onFlushed(seq), onCleared(), onError(err), onClose(code, reason) })` returns a handle with `speak(text)`, `flush()` (returning a seq or null), `clear()`, `close()`, `isOpen()` and `ready` (a promise).
- **URL:** `wss://${host}/v1/speak?model=${voice}&encoding=mulaw&sample_rate=8000&mip_opt_out=true`.
- **Strictness:** send only well-formed `Speak`, `Flush`, `Clear` and `Close` messages. Anything else, or a `Speak` without text, makes the server close with 1008 and send no error frame.
- **`speak(text)`:**
  - Trim, and drop empty text.
  - Split text over 2000 characters at sentence boundaries.
  - Send it with a **trailing space**: Aura releases audio for complete sentences and clauses as soon as the following whitespace arrives. Measured: `"Sure, Michael. "` was fully spoken before any `Flush`.
- **Flush budget:** at most 20 flushes per 60 s; the 21st returns `Warning EXCESSIVE_FLUSH` and no `Flushed`.
  - The client keeps a sliding window. `flush()` returns null and sends nothing once 18 have been sent in the last 60 s.
  - Callers then rely on the trailing-space release and on duration estimates.
- **`clear()`:** send `Clear`, and drop every audio frame that arrives before `Cleared`.
- **Keepalive:** a WebSocket ping every 30 s (the idle timeout is about 300 s).
- **Audio** is raw mulaw with no header, in variable frame sizes.

### 4.3 `lib/fast-player.js`: audio out to Twilio
- **Signature:** `createFastPlayer({ sendJson, streamSid })`.
- **`push(buf)`:** buffer the bytes, re-chunk them into 160-byte (20 ms) frames, and send each as a Twilio `media` event immediately (Twilio buffers playback).
- **`endUtterance()`** is called on Aura `Flushed`. It sends a Twilio mark named `fast-<n>` and records it as outstanding.
- **`onMark(name)`** removes the mark. **`isPlaying()`** is true while any audio sent hasn't had its mark returned. `whenIdle()` resolves when the outstanding set empties, or after a byte-based duration estimate plus a 2 s cap.
- **`stop()`:** send Twilio `clear`, drop the partial frame, and empty the outstanding marks.
- **Stamps:** it records `firstAudioAt` per utterance for latency metrics.
- **The classic "tts-done" boolean bug** (the first mark clears `isSpeaking` while audio is still queued) does not apply here. The fast path derives `session.isSpeaking` from `player.isPlaying()`.

### 4.4 Clause chunking in `services/claude-chat.js` (modified)
- **Option `chunking: "clause"`:** the **first** emitted chunk of a response may end at a clause boundary. That is `,` `;` `:` `—` `–` **followed by whitespace**, once the chunk has 3 or more words. Later chunks use the existing sentence break.
- **The whitespace rule** keeps "9:30" and "1,500" whole.
- **In clause mode only,** the buffered tail is also flushed before a `tool_calls` result is returned. Today claude-chat drops it in every mode: even a punctuated final sentence is lost, because SENTENCE_BREAK needs trailing whitespace. That makes every "let me check…" preamble vanish. Default mode keeps today's behaviour (ruling R7: ConversationRelay is eval-only; fixing it there is a follow-up).
- **Without the option,** behaviour is unchanged (ConversationRelay uses it).

### 4.5 `lib/speculative-reply.js`: draft on `EagerEndOfTurn`, commit on `EndOfTurn`
- **Signature:** `startSpeculativeReply({ llm, messages, transcript, llmOptions, turnKey })`.
  - It calls `llm([...messages, {role:"user", content: transcript}], {...llmOptions, chunking:"clause", signal, onSentence: buffer})` without touching `session.messages`.
  - It never executes tools. A `tool_calls` result is only stored.
- **It returns** `{ turnKey, transcript, status(), isAdoptable(currentMessages, transcript), adopt(onSentence) → Promise<result>, abort(reason) }`.
  - Decide adoption by `isAdoptable(...)`, never by `status()`: a failed draft also reports `"done"`.
  - The draft owns a deadline (`timeoutMs`, default 15000) through `AbortSignal.any([own, AbortSignal.timeout])`. On the deadline, `adopt()` rejects with a `TimeoutError`, which the consumer treats as an LLM failure. `{type:"aborted"}` is reserved for `abort()`.
- **`isAdoptable`** requires all of:
  - not aborted
  - the same `messages` array object, and the same length as at start
  - the committed transcript is `===` the draft's transcript. Flux guarantees `EndOfTurn` equals the preceding eager transcript, or emits `TurnResumed` first.
- **`adopt`** replays the buffered chunks through `onSentence` synchronously, in order, then forwards live chunks, and resolves with the stream's final result.
- **Abort** happens on `TurnResumed`, a new `StartOfTurn` for a different turn, a non-adoptable commit, barge-in or call cleanup.

### 4.6 `lib/fast-turns.js`: the Flux turn engine (pure)
- **Signature:** `createFastTurnEngine({ getState, actions, speculationEnabled })` returns `{ onTurnInfo(evt), reset() }`.
  - `getState()` returns `{ aiSpeaking, processing, expectedInputType, aiSpeakingText }`.
  - `actions` are `speculate`, `cancelSpeculation`, `commit`, `bargeIn`, `dropEcho` and `bufferStructured`.
  - The engine is pure: no timers, I/O or console.
- **Rules:**
  1. Ignore empty transcripts. The exception is TurnResumed, which always cancels.
  2. An event for a different `turnIndex` cancels any other turn's draft. An EndOfTurn for a turn that already ended is dropped (dedupe). `reset()` clears this state; use it on each new Flux connection.
  3. **Barge-in.** While `aiSpeaking || processing`, a transcript of 3 or more words, or one matching `INTERRUPT_RE`, triggers `bargeIn()` at most once per turn. It is evaluated on `Update`/`StartOfTurn` and again at `EndOfTurn`.
     - **Speakerphone echo filter:** when `aiSpeaking`, a candidate is NOT a barge-in if all of these hold:
       - it has 3 or more normalised words
       - 80% or more of its tokens appear in `aiSpeakingText` (everything sent to TTS since the player last went idle)
       - a contiguous run of 3 or more tokens matches
       - it contains no number the AI didn't say
     - Normalisation folds case, punctuation, a.m./p.m. and numerals.
     - The filter fails open when the text is missing, and never applies when the state is processing-only.
  4. On `EagerEndOfTurn`, call `speculate` only if speculation is enabled, `!aiSpeaking && !processing`, and `expectedInputType === "general"`.
  5. On `TurnResumed`, call `cancelSpeculation("resumed")`.
  6. On `EndOfTurn`, in this order:
     - echo drop (`aiSpeaking`, 2 words or fewer, no interrupt word)
     - the rule-3 barge-in check
     - then either `bufferStructured` (non-general type) or `commit(transcript, turnIndex, trigger)`
     - The answer runs in a `finally`, so a throwing `bargeIn` can't lose the caller's turn.

### 4.7 `lib/end-call-guard.js` and hang-up for all classic calls (bug fix)
- **The bug:** classic never honours `end_call`. `__endCall` is ignored, so the model keeps talking and the line stays open (map §7).
- **The guard:** `checkEndCallGuard(session, reason)` returns `{ allow, message? }`. It is a port of the Gemini funnel guard (S:2599-2623):
  - If `session.hasUnfinishedBooking(reason)` and there has been no prior nudge, it audits `end_call_blocked` and returns the "CANNOT END CALL YET…" text verbatim as the tool result.
  - After one nudge it allows and captures at error level.
  - It uses `Sentry.withScope` with `setTag("service","hallucination_guard")`. Don't add `setReasonTag` in server.js: the census pins 3 reason-tagged sites.
- **Gemini's inline guard stays untouched**, to avoid a conflict with PR #442. Switching Gemini to the helper is a follow-up.
- **In `handleUserSpeech`:** when an allowed `end_call` returns `__endCall`:
  1. Push the tool result and stop the tool loop. Do not ask the model again.
  2. If nothing was spoken this turn, speak a short goodbye ("Thanks for calling — goodbye."; localise if a map exists).
  3. Wait for playback. Fast path: `player.whenIdle()`. Classic: the sum of `sendTTS` durations. Then wait 500 ms, capped at 8 s in total.
  4. Set `endedReason = "end_call_tool"` and close `twilioWs` with (1000, "end_call").

### 4.8 `server.js` wiring (modified)
1. **Classic start (S:3253).** If `session.fastPath`:
   - Open Aura stream and player in parallel with Flux.
   - Open Flux with the turn-engine callbacks.
   - **If Flux fails to open within 3 s, or errors before open:** log `[FastPath] Flux unavailable — falling back to Nova`, capture with service `flux-stt`, open Nova with today's callbacks, and set `session.fastPath = "degraded-stt"`. The rest of the fast path still applies, and turns go through the Nova buffer.
   - **If Flux closes abnormally mid-call:** open Nova with today's callbacks the same way.
   - Greeting and disclosure keep REST pre-synthesis (latency already hidden), but on the AU host.
2. **media.** Frames go to `session.deepgramWs.send(buf)` unchanged; the Flux handle has the same interface.
3. **`sendTTS(session, twilioWs, text)`.** When `session.fastTts?.isOpen()`:
   - `stripMarkdown`, then `speak(text)`.
   - Return an estimate of `chars × 70 ms` for callers that wait on the duration.
   - Otherwise REST as today. Aura errors make the call fall back to REST for its remaining duration, with one log and one capture.
4. **Flush points.** `flush()` is called after each LLM iteration's chunks are queued: at the end of a content reply, before running tools, and after fillers. A null result (budget reached) is tolerated.
5. **`sendClear`.** On the fast path it also does `fastTts.clear()` and `player.stop()`.
6. **`mark` handler.** `fast-*` marks go to `player.onMark`, and `session.isSpeaking = player.isPlaying()`. `tts-done` handling stays as it is.
7. **`handleUserSpeech`, fast path only:**
   - The LLM call becomes `streamClaudeResponse(session.messages, {...llmOptions, onSentence, chunking:"clause", signal: turnCtl.signal, model: FAST_LLM_MODEL})`, where `FAST_LLM_MODEL` defaults to `claude-haiku-5-5`.
   - In iteration 0, an adoptable draft for this transcript is adopted instead.
   - `session.currentTurn = { abort }` is exposed so that `bargeIn()` can abort it.
   - **On `AbortError`:**
     - no apology, and the user message is kept
     - the assistant text recorded is the chunks already sent to TTS, plus "…"
     - `finally` runs the usual `drainPending`
   - Tool execution is never aborted mid-call. The loop checks `signal.aborted` before the next LLM iteration.
8. **Barge-in action.** `player.stop()`, `fastTts.clear()`, `session.currentTurn?.abort()`, abort any draft, and log `[Barge-in] (fast)`.
9. **Latency stamps.** Per committed turn, log `[FastTurn] callSid=… trigger=<model|timeout|buffered> spec=<adopted|discarded|none> eot_to_llm=<ms> eot_to_audio=<ms> eager_lead=<ms>`.
   - At cleanup, log `[FastCall] callSid=… turns=N eot_to_audio_p50=… p90=… spec_adopted=… spec_discarded=… stt=<flux|nova-fallback> tts=<stream|rest-fallback>`.
   - Persist the same summary to `calls.metadata.fastPath`.
10. **Cleanup.** Close Flux (CloseStream), Aura (Close), player timers and any draft.

### 4.9 Turn-taking policy and watchdogs (added during review)
These rules apply on the fast path only; classic and Gemini are unchanged. The ledger records each one with its reasoning.

- **Short interrupts are decided late (R12a′).** A final of 2 words or fewer matching INTERRUPT_RE doesn't barge in at StartOfTurn or Update. It is decided at EndOfTurn, because the bare "No" of "No worries" would otherwise cut the AI off.
- **Backchannels are dropped (R12a′).** While the AI is speaking or processing, a final made only of backchannel words is dropped, on both the commit and structured paths. The words are: okay, ok, yeah, yep, yes, sure, right, alright, cool, great, perfect, thanks, thank you, mm-hmm, uh-huh, no worries, no problem.
- **Echoed finals are dropped (R13).** While the AI is speaking, a final that `isLikelyEcho` matches against `aiSpeakingText` is dropped, not committed. Otherwise the LLM would answer its own words.
- **Answers at the end of a question are kept (R14″).** While the AI is speaking, a final of 2 words or fewer counts as an ANSWER, and is committed, only when all three hold:
  - the reply text ends with "?"
  - the player's gap-aware remaining playback is 2000 ms or less
  - the caller's turn began after the question's audio did: its start as server.js received it (StartOfTurn's `receivedAt`, else its first event with words) is at least 500 ms (Flux's StartOfTurn lag) after `questionAudioStartAt`. That is set when the chunk ending in "?" goes to TTS: `now + player.remainingMs(now)`, plus the audio Aura still owes for the text before the question, estimated at 95 ms a character (late rather than early), and it clears with `aiSpeakingText`.

  If any of them is unknown (REST-only playback, unstamped events), the final is dropped.
- **A dropped answer to a long question is answered later (gate M5).** A short final dropped while the AI asked a question too long for its tail rule, but begun after the question started (+500 ms), is committed (`trigger=deferred`) once the AI finishes speaking, unless a newer turn has started.
- **A silence after a question gets one re-prompt (gate M5).** When the AI finishes on a question and no caller turn starts within 6 s, it says "Sorry, I didn't catch that." and the question sentence again, once per question. Any StartOfTurn, commit, barge-in, new speech or hang-up cancels it.
- **Queued turns wait (R12b″).** A turn that starts while the AI's audio plays (the player, REST audio, what Aura still owes, or the disclosure) waits up to about 10 s for idle before hold audio starts, and skips the turn-start clear. The wait is part of the turn: the user message is recorded first, and a barge-in during it aborts the turn (no reply to those words alone; they stay for the next turn). Degraded-stt (Nova) keeps the clear.
- **The recording disclosure is protected (R12d′).** A `disclosureActive` flag makes the disclosure non-interruptible on both of its paths. The fallback disclosure goes over REST and is marked played only once its frames are sent. REST-spoken text enters `aiSpeakingText`.
- **Missing keys (R12c).** Classic-fast without ANTHROPIC_API_KEY or DEEPGRAM_API_KEY routes to the global pipeline, with one warning per process.
- **Echo text while a reply is in flight.** Text stays "owed", so the echo filter remains active, while any audio is unflushed or a flush is pending, not just while the player is playing.
- **Watchdogs.**
  - A Flushed overdue by 3 s with no audio switches the call to REST TTS.
  - An Aura stream that has not opened within 3 s switches the call to REST TTS (gate M3); one that opens logs `[FastPath] Aura connected`.
  - No Flux frames for more than 5 s while audio is being sent switches the call to Nova.
  - 3 s of caller speech energy within 8 s (frames of RMS 300 or more, counted only while the AI is silent) with no Flux turn event switches the call to Nova (gate M4b: speech Flux cannot transcribe, e.g. another language), and the caller is asked to say it again.
  - A lost `fast-*` mark is treated as idle after the estimated playback plus 5 s.
- **Nothing the caller said or should have heard is lost in a fallback (gate H2, M4a).** An Aura failure says again over REST the text Aura was given and, as far as its audio shows, never voiced (estimated at 95 ms a character); when that cannot be done, a system note tells the next turn the caller did not hear it. A Flux failure answers the turn it had open (`trigger=stt-fallback`), or asks the caller to say it again if the turn had started with no words yet.
- **A failing Claude pages (gate H1).** A fast turn that fails (an apology instead of a reply) is captured with service `claude-chat`: warning level, then error level from the second in a row. `[FastCall]` and `metadata.fastPath` count them (`llm_errors`), and apologies and fillers are never a turn's latency.
- **Latency samples (gate C5).** `[FastTurn]` logs `waited=<ms>`: time queued behind another turn plus R12b″'s wait. A turn that waited is logged but not counted in the p50/p90.
- **Drafts are capped (gate B).** At most 2 drafts per Flux turn and 60 per call; past either, turns are answered live. Logged once per call.
- **Abortable back-off.** The claude-chat retry back-off is abortable in every mode.

## 5. Constraints

- **Fail safe:** a fast-path failure degrades to today's components (Nova, REST TTS) and never leaves silence or ends the call.
- **No change to non-demo calls:** Gemini and classic stay as they are, apart from the end_call hang-up fix in classic.
- **Logs:** no caller words in logs unless `DEBUG_TRANSCRIPTS` (SCRUM-339). Keys are never logged.
- **Privacy:** every new Deepgram connection sends `mip_opt_out=true`.
- **Tests:** follow the existing idioms (source pins plus runtime slices, see map §10). Respect the count pins:
  - don't duplicate the tool loop
  - keep `resolveOwnerPipeline(` appearing exactly once
  - keep `organizationId === DEMO_ORG_ID || isDemoLineNumber(calledNumber)` appearing exactly twice
  - keep 3 reason-tagged Sentry sites in server.js
- **Process:** `npm test` and `npm run typecheck` must pass; the JSDoc `@param` lines use ASCII hyphens.
- **Commits:** `feat(SCRUM-594): …` / `fix(SCRUM-594): …` with the session trailers.

## 6. Verification before the owner's phone test

1. Unit and wiring tests, with a mutation spot-check on each rule in §4.6 and §4.7.
2. **Bench** (scratchpad, not committed): run the real Flux client, turn engine, speculation, `streamClaudeResponse` and Aura stream against the live APIs, using synthetic phone clips (`scratchpad/hearing-ab/aura-2-hyperion-en/u*.ulaw`). Report the median and p90 from the last speech frame to the first audio byte handed to the player.
3. The 4-lens `/review-and-fix` gate.
4. **Owner phone test** with `DEMO_LINE_PIPELINE=classic-fast`: spell the surname, ask for "ten AM", a quick "yes", a barge-in, and a goodbye that hangs up. Then compare `[FastTurn]` lines with Gemini calls.

## 7. Files

Every file this branch adds or changes against `origin/develop` (`git diff --name-only origin/develop...HEAD`; 38 files at the docs commit). The operator's guide is the "Fast classic pipeline (SCRUM-594)" section of `docs/runbooks/voice-server.md`. Paths are repo-relative; the bracketed numbers point at the section of this spec that describes the file.

### New modules
- `voice-server/services/flux-stt.js`: the Deepgram Flux STT client (`openFluxStream`) and the `FLUX_*` env parsing (`fluxConfigFromEnv`) [4.1].
- `voice-server/services/aura-stream.js`: the Aura-2 WebSocket TTS client (`openAuraStream`): `speak`, `flush`, `clear` and `close`, the flush budget and the `Clear` backstop [4.2].
- `voice-server/services/deepgram-ws-common.js`: what the two clients share: the AU default host, the ping keepalive, the loopback-only plaintext rule, the callback guard and the dead-handle helper.
- `voice-server/lib/fast-player.js`: re-frames Aura audio into 20 ms Twilio frames and sends it at once; tracks playback through Twilio marks (`isPlaying`, `whenIdle`, `stop`, `remainingMs`) [4.3].
- `voice-server/lib/fast-turns.js`: the pure Flux turn engine: drafts, barge-in, backchannel and echo drops, structured input, the answer at the tail of a question, the open turn and the deferred answer [4.6, 4.9].
- `voice-server/lib/no-turn-watchdog.js`: speech energy in the caller's audio with no Flux turn events (gate M4b) [4.9].
- `voice-server/lib/speculative-reply.js`: the silent draft reply started on `EagerEndOfTurn`, then adopted on the matching `EndOfTurn` or aborted [4.5].
- `voice-server/lib/end-call-guard.js`: the SCRUM-373 `end_call` booking guard in shared form, for the classic hang-up [4.7].

### Modified modules
- `voice-server/server.js`: the `DEMO_LINE_PIPELINE` routing at pipeline selection [3]; the "Fast classic pipeline" section (start-up, the Flux and Aura fallbacks and their watchdogs, turn actions, barge-in, the `[FastTurn]` and `[FastCall]` lines, cleanup); fast routing in `sendTTS`, `sendClear` and the mark handler; the fast turn in `handleUserSpeech`; the classic `end_call` hang-up; `metadata.pipeline` and `metadata.fastPath` [4.7, 4.8].
- `voice-server/call-session.js`: the fast-path session fields and typedefs (`fastPath`, `fastPlayer`, `fastTts`, `fastTurns`, `fastState`, `currentTurn`, `speculation`, `fastStats`, `effectivePipeline`, `awaitPlaybackEnd`, `carriedFastPath`).
- `voice-server/lib/pipeline-routing.js`: `resolveCallPipeline`, `readDemoLinePipeline` and `fastPathKeysPresent`: the `DEMO_LINE_PIPELINE` switch, including the fall back to the global pipeline when `classic-fast` lacks its keys [3].
- `voice-server/lib/call-logger.js`: `completeCallRecord` merges `pipeline` and `fastPath` into `calls.metadata`.
- `voice-server/lib/pending-transfers.js`: a transferred call keeps its first leg's fast-path summary (`finishTransferredCall`).
- `voice-server/lib/session-limits.js`: `DEMO_MAX_CALL_MINUTES` (cherry-picked from SCRUM-593, d2b58d5): the demo call limit is adjustable, default 3 minutes. Not part of the feature; it rides along so phone tests are not cut off mid-booking.
- `voice-server/services/claude-chat.js`: `chunking: "clause"` for `streamClaudeResponse` (first chunk at a clause boundary, an abbreviation guard, the buffered tail spoken before `tool_calls`) and a retry back-off that ends when the caller's signal aborts [4.4].
- `voice-server/services/deepgram-stt.js`: exports `buildKeytermsParam`, and gives it `{ weights: false }` for the plain keyterms Flux wants.
- `voice-server/services/deepgram-tts.js`: `synthesizeSpeech` takes a `host` (the fast path passes the AU host for the greeting and disclosure).

### Tests
New:
- `voice-server/tests/flux-stt.test.js`: the Flux client against a fake Deepgram socket: URL, events, errors, close semantics, keepalive, env parsing.
- `voice-server/tests/aura-stream.test.js`: the Aura client against a fake socket: only well-formed messages, the flush budget, `Clear` and its backstop, text splitting.
- `voice-server/tests/deepgram-ws-common.test.js`: the shared plumbing's contract.
- `voice-server/tests/deepgram-stt.keyterms.test.js`: Nova keyterms byte-identical to before; Flux keyterms plain and de-duplicated.
- `voice-server/tests/fast-player.test.js`: framing, marks, `whenIdle`, `stop` and `remainingMs`.
- `voice-server/tests/fast-turns.test.js`: the turn rules as a table, the echo filter, recorded Flux streams replayed, purity.
- `voice-server/tests/no-turn-watchdog.test.js`: the no-turn watchdog on an injected clock: silence, speech, the window, the AI's own audio, turn events.
- `voice-server/tests/speculative-reply.test.js`: drafts over a mocked Anthropic stream: adopt, abort, the deadline, replay.
- `voice-server/tests/claude-chat-clause.test.js`: clause chunking, plus a differential test that the default mode is unchanged.
- `voice-server/tests/anthropic-sse-helpers.js`: a shared helper, not a `*.test.js` file: Anthropic SSE builders and fake `fetch`.
- `voice-server/tests/end-call-guard.test.js`: the guard's verdicts, the one-nudge rule, the audit entry, and parity with the Gemini inline guard.
- `voice-server/tests/server-classic-end-call-wiring.test.js`: the real `handleUserSpeech` text against stubs: an allowed `end_call` closes the line after playback, a blocked one nudges.
- `voice-server/tests/server-fast-path-wiring.test.js`: the fast path's wiring in `server.js`, as source pins and the real text run against fakes (start-up, fallbacks, barge-in, drafts, watchdogs, the disclosure, latency logs, cleanup).
- `voice-server/tests/server-fast-routing-wiring.test.js`: the pipeline-selection site and the classic block run for real: the switch, owner calls untouched, `metadata.pipeline`.

Changed:
- `voice-server/tests/call-logger-metadata.test.js`: `pipeline` and `fastPath` merge into `calls.metadata`, and null writes nothing.
- `voice-server/tests/pending-transfers-owner-auth.test.js`: the first leg's fast-path summary survives a transfer.
- `voice-server/tests/pipeline-routing.test.js`: `resolveCallPipeline` and `readDemoLinePipeline`: the switch, owner calls, language, missing keys.
- `voice-server/tests/server-owner-mode-wiring.test.js`: the harness follows the new pipeline-selection and classic-start code, with guards that a classic call never reaches the fast path.
- `voice-server/tests/session-limits.test.js`: `DEMO_MAX_CALL_MINUTES` parsing.

### Docs and config
- `docs/superpowers/specs/2026-10-17-fast-classic-pipeline-design.md`: this spec.
- `docs/superpowers/plans/2026-10-17-fast-classic-pipeline.md`: the implementation plan.
- `docs/runbooks/voice-server.md`: the "Fast classic pipeline (SCRUM-594)" section (enable and kill switch, requirements, turn-taking, fallbacks, log lines, phone-test comparison, privacy), and pointers from the pipelines list, the error-logged alert and the kill-switch table.
- `voice-server/.env.example`: `DEMO_LINE_PIPELINE`, `FAST_DEEPGRAM_HOST`, `FLUX_EOT_THRESHOLD`, `FLUX_EAGER_EOT_THRESHOLD`, `FLUX_EOT_TIMEOUT_MS` and `FAST_LLM_MODEL` (and `DEMO_MAX_CALL_MINUTES`, with the cherry-pick).
