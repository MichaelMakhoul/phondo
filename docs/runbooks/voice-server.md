# Voice Server Production Runbook (SCRUM-191)

Operator guide for the self-hosted voice server (`voice-server/`, Fly.io app
`phondo-voice`, region `syd`). Written 2026-07-03, using the 2026-07-02 Grok-403
incident as the worked example throughout.

**You got an alert email (`[Phondo] FIRING: …`)? Jump to
[Alert → action](#alert--action).**

---

## System map

| Piece | Where | Notes |
|---|---|---|
| Voice server | Fly.io app `phondo-voice` (syd), `performance-1x`/2GB, always-on (`min_machines_running = 1`, SCRUM-580; autostops only if set back to 0) | deploy from `voice-server/` ONLY |
| Web app + internal API | Vercel (Next.js), auto-deploys on merge to `main` | receives `/api/internal/call-completed` |
| DB | Supabase (AU) | `calls`, `appointments`, `org_members`, … |
| Logs | Fly → `fly-log-shipper` app → Grafana Cloud Loki (AU, `grafanacloud-logs`) | shipper must stay scaled to 1 or logs are lost |
| Alerts | Grafana folder `Phondo`, contact point `phondo-email` → michaelmakhoul0@gmail.com | policy: warning 30s wait/4h repeat, critical 10s/30m |
| Telephony | Twilio (AU + US numbers) | webhook → `https://phondo-voice.fly.dev/twiml` |

### Pipelines (per call)

- **Production**: Gemini Live (`VOICE_PIPELINE=gemini-live`), model
  `models/gemini-3.8-live` since SCRUM-588 — the startup log line
  `Voice pipeline: gemini-live (Gemini Live: …)` names the model in use.
- **Fallback**: classic Deepgram STT → OpenAI → Deepgram TTS (automatic when
  `GEMINI_API_KEY` missing; or `VOICE_PIPELINE=classic`).
- **Eval overrides (SCRUM-378)**: `TEST_PIPELINE_OVERRIDES="<number>:<pipeline>"`
  routes ONE dialed number to `openai-realtime` (needs `OPENAI_API_KEY`),
  `grok-realtime` (needs `XAI_API_KEY`), or `conversationrelay` (needs
  `ANTHROPIC_API_KEY`). Unknown names and missing keys warn loudly and fall
  back to Gemini — grep `[Pipeline]` to see what a call actually ran.
- **Demo line, fast classic (SCRUM-594)**: `DEMO_LINE_PIPELINE=classic-fast` moves
  the published demo line onto Flux STT + Claude + streaming Aura TTS. Unset by
  default, English-only, customer calls only — see
  [Fast classic pipeline](#fast-classic-pipeline-scrum-594).

---

## Alert → action

All rules live in Grafana folder `Phondo`. Every alert email links back to the
rule; the queries match markers in log line CONTENT (not the `level` label —
Fly ships all app lines as `level="info"`, which kept the old error-rate rule
permanently NoData until 2026-07-02, SCRUM-501).

### `Voice server — FATAL crash` (critical)
The process crashed (uncaughtException/unhandledRejection) and Fly restarted it.
1. `fly logs -a phondo-voice | grep -B5 "\[FATAL\]"` — the stack is in the line.
2. In-flight calls at crash time died; check `calls` rows with
   `status='failed'` around the timestamp and consider callback texts.
3. If it crash-loops: roll back (see [Deploy & rollback](#deploy--rollback)).

### `Voice server — error logged (any call/pipeline failure)` (warning)
At least one `[ALERT:error]` in 5m — at current volume this usually means **one
call failed**. This is the rule that would have caught the 2026-07-02 incident.
1. Find the line: `fly logs -a phondo-voice | grep "ALERT:error"` (or Loki:
   `{fly_app_name="phondo-voice"} |= "[ALERT:error]"`).
2. Identify the call: nearby `callSid=`, then the `calls` row
   (`metadata->>'ended_reason'` tells you which pipeline failed — see the
   [ended_reason table](#ended_reason-codes)).
3. Provider handshake failures (like the Grok 403) print the WS error verbatim;
   reproduce with the curl below to read the provider's error body. A
   `[flux-stt]`, `[aura-stream]` or `[fast-turns]` tag is the demo line's fast
   classic pipeline degrading (the call carried on): see
   [Fast classic pipeline](#fast-classic-pipeline-scrum-594).
4. One-off vs systemic: re-check the log for repeats. Systemic on the PROD
   pipeline → consider the [pipeline kill switch](#pipeline-switching--kill-switches).
5. Raise this rule's threshold when real call volume makes single-error emails
   noisy.

### `Voice server — high error rate` (warning, >5 errors/min for 5m)
Sustained failure — likely a provider outage or a bad deploy.
1. `fly releases -a phondo-voice` — did a deploy just happen? Roll back first,
   diagnose second.
2. No deploy → provider status pages (Gemini/Twilio/Deepgram/OpenAI) + the
   error text itself.
3. Gemini down → flip fallback: `fly secrets set VOICE_PIPELINE=classic -a phondo-voice`
   (classic needs DEEPGRAM_API_KEY + OPENAI_API_KEY, both already set).

### `Voice server — hallucinated action detected` (warning, quality)
The AI claimed a booking/cancel/callback it never completed
(`[HallucinatedAction]`), or `end_call` was blocked/allowed on an unfinished
booking (`[HallucinationGuard]`).
1. Get the callSid from the log line → open the call in the dashboard.
2. **Call the customer** — they may believe an appointment exists.
3. The failed-call email to the business owner uses call-to-action copy for
   `hallucinated_*` reasons (SCRUM-496) — confirm it went out
   (`[Email] Sent` in Vercel logs).

### `Voice server — AI fabricating actions` (warning, quality)
Transcript-regex variant of the above (confirmation phrase with no matching
tool call in the window). Same triage; more false-positive-prone.

### `Next.js — error logged` (warning)
A `pageSentry` `[ALERT:error]` from the web app: cron failures, paid-action
errors, admin/webhook problems. The line's `reason=` tag and Vercel function
logs identify the route.

### `Next.js — admin profile rows missing` (warning)
>5 `admin-profile-row-missing` denials in 1h → likely signup regression
leaving users without `user_profiles` rows. Check recent migrations + signup
flow.

### Alert-rule liveness (quarterly manual check — no automation yet)
A rule sitting in **Normal (NoData)** for >30 days is more likely broken than
healthy (that's how 2026-07-02 happened). Quarterly: open each rule, run its
query over a window known to contain matching lines, confirm non-empty.

**SCRUM-579 caveat** (at either `min_machines_running` setting): the voice server
logs nothing while idle (no heartbeat; `/health` doesn't log), and nothing at all
while stopped at 0, so NoData is the *normal* state between calls and doesn't
distinguish "rule broken" from "nobody called". The verification window must
contain a **known call** (place a test call, note the time, query that window) —
a merely recent window proves nothing. The flip side: **no voice-server rule
fires on a dead or silent machine** — they all match log content and treat
NoData as OK. The outage signal comes from the web app instead: see "Voice
server down" below.

### Voice server down — callers hear "temporarily unavailable" (`reason=voice-fallback-served`)
When /twiml fails or times out, Twilio falls back to
`src/app/api/twilio/voice-fallback/route.ts`: the caller hears "our system is
temporarily unavailable" + voicemail and a `status: "failed"` row lands in the
business's call log. Since SCRUM-589 that route pages on every such caller:
`[ALERT:error] [next-api] … reason=voice-fallback-served` with the Twilio
`errorCode`, the failed `errorUrl` path (`/twiml` = the server is down; an action
URL such as `/twiml/transfer-status` = one broken flow) and `callSid` (look the
call up in the Twilio console; the caller's number is never in the line). `reason=voice-fallback-failed` means the fallback
itself threw (the caller got no voicemail either), and
`reason=voice-fallback-env-missing` means `TWILIO_AUTH_TOKEN` is unset on Vercel
(every fallback is rejected). Grafana's `Voice server down — callers getting
voicemail` rule (critical, uid `bg0xba28vjkzka`, repeats every 30 min while
firing) emails on any of them within ~3-4 minutes, alongside the generic
`Next.js — error logged` rule. The daily health-check cron
(`src/app/api/cron/health-check`) also pages `reason=voice-server-down` on a
healthy→down change, but it wakes a stopped machine before probing it, so it
only catches a server that can't come up at all; its own email/SMS additionally
needs `ADMIN_ALERT_EMAIL` (plus `EMAIL_API_KEY`) or `ADMIN_ALERT_PHONE` on
Vercel. Triage:
1. `fly status -a phondo-voice` — expect `started`, checks `1 passing`. Stopped at
   `min_machines_running = 1` means always-on broke: `fly machine start <id> -a phondo-voice`.
2. `fly logs -a phondo-voice` — crash, OOM, or no boot line (`Voice pipeline: …`).
3. Look for `status: "failed"` rows in the affected businesses' call logs.

---

## ended_reason codes

`calls.metadata->>'ended_reason'`, written by the voice server; the
customer-facing email maps them to neutral copy in
`src/lib/notifications/humanize-ended-reason.ts` (raw codes must never appear
in emails — SCRUM-496).

| Code | Meaning | First move |
|---|---|---|
| `gemini-error` / `grok-error` / `openai-error` | that pipeline's session errored mid-call | provider status; log line has the WS/API error |
| `gemini-setup-timeout` / `grok-…` / `openai-…` | session never became ready (10s watchdog); caller heard the apology TTS | usually provider auth/handshake — see curl below |
| `gemini-session-closed` / `grok-…` / `openai-…` | provider closed the socket unexpectedly | provider status; retry pattern |
| `stt-error`, `stt-connection-lost`, `tts-error`, `llm-error`, `server-error` | classic-pipeline component failures | matching component logs |
| `hallucinated_booking` / `_callback` / `_cancellation` … | post-call phantom detection marked the call failed | CALL THE CUSTOMER; see quality alert above |
| `end_call_tool` / `transferred` | normal endings | none |

### Worked example — the 2026-07-02 Grok 403
Symptom: caller heard ~2s silence then the call dropped; owner email said
"Failed Call". Logs showed `[Pipeline] TEST override → grok-realtime` then
`[GrokRealtime] WS error: Unexpected server response: 403`; DB row
`ended_reason=grok-error`. The ws library hides the response body, so we
replayed the handshake:

```bash
curl -s -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  "https://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0"
```

Body: *"Your newly created team doesn't have any credits"* — the key belonged
to a different xAI team than the one that was topped up. Same replay technique
works for any provider WS 4xx.

---

## Deploy & rollback

```bash
./voice-server/deploy.sh      # fly deploy (~2-4 min) THEN the mandatory warm — use this, not a bare fly deploy
fly status -a phondo-voice    # expect started + checks passing; stopped at min_machines_running = 1 = always-on broken → fly machine start <id> -a phondo-voice
```

Args pass through: `./voice-server/deploy.sh --strategy immediate`. A bare
`cd voice-server && fly deploy -a phondo-voice` still works but skips the warm —
see below for what that costs a caller.

- **The post-deploy warm is mandatory, not a nicety** (SCRUM-579) — that is why
  it lives in `voice-server/deploy.sh` rather than as a step someone can skip. With
  `min_machines_running = 0`, the first wake after a deploy re-pulls the image onto
  the host and measured **14.5s** of client-side wall clock: 8.25s to create and
  start the machine (6.4s of that pulling the image), ~4s of Node boot before the
  port accepts, and ~2s of fly-proxy wake detection plus TLS on top;
  fly-proxy even logged `could not wake up machine due to a timeout`. Twilio's read
  timeout for call HTTP requests is **hard-capped at 15s**, and fly-proxy holds the
  request open for the whole boot, so a real call landing on that first wake very
  likely times out and Twilio invokes the fallback URL — the caller hears
  "our system is temporarily unavailable" + voicemail
  (`src/app/api/twilio/voice-fallback/route.ts`) and a `status: "failed"` row lands
  in the business's call log. The curl absorbs that wake, leaving the image
  host-cached (~6s wakes thereafter), and doubles as a smoke test of the new image.
  **The stop is load-bearing**: `fly deploy` leaves the machine started, so curling
  straight after a deploy would absorb nothing — the pull would land on the first
  wake after it later autostops, i.e. on whoever calls next. The script reports
  which happened: a wake under 10s was cached, so the pull was not absorbed.
  **At `min_machines_running = 1` the script skips the stop** (SCRUM-580): with no
  autostop there is no later wake for a caller to pay, and stopping the only
  machine would itself drain live calls and leave the line dead for the wake — so
  it deploys and just checks `/health`.
  The same applies to the **public /demo page**: a browser opening `wss://…/ws/test`
  autostarts the machine exactly like Twilio does, so marketing visitors pay the
  same wake — see the always-on note below.

- **Verify before dialing**: a call placed mid-deploy lands on the OLD version
  (burned two eval sessions). Confirm the boot line
  (`Voice pipeline: …`) appears in `fly logs` AFTER the deploy finishes.
- **Rollback**: `fly releases -a phondo-voice` → copy the previous image ref →
  `fly deploy -a phondo-voice -i <registry.fly.io/phondo-voice@sha256:…>`.
- **Secrets**: `fly secrets set K=V -a phondo-voice` restarts machines
  immediately; add `--stage` to batch several and apply on next deploy.
- **Always-on while outreach or a pilot runs (SCRUM-580)**: `min_machines_running = 1`
  keeps the performance-1x/2GB machine up 24/7 (~$39/mo), because a caller should
  never pay a 6s wake, let alone the post-deploy 14.5s one. Set it back to 0
  (SCRUM-579) only while no pilot, outreach or marketing push is running; the
  machine then autostops when idle (~5 min). **Merging changes nothing live** —
  Fly applies `fly.toml` on the next deploy. To apply only the config (none of
  `main`'s undeployed code), redeploy the running image: copy the top image ref
  from `fly releases -a phondo-voice --image`, then run
  `./voice-server/deploy.sh -i <that ref>` from a `main` that already has
  SCRUM-580 (release develop → main first: an older `main` re-deploys 0, and its
  `deploy.sh` stops the machine). **Verify**:
  `fly config show -a phondo-voice` shows `min_machines_running` 1, and
  `fly status -a phondo-voice` still says `started` 10+ minutes after the last
  call (autostop would have stopped it by ~5). Measured wakes (2026-08-23, syd,
  performance-1x/2GB): **~6s** with the image host-cached, **~14.5s** on the first
  wake after a deploy. The log line
  `Health check 'servicecheck-00-http-3001' … has failed` **once per
  cold start is EXPECTED** (first probe races the boot; `grace_period=30s`
  already suppresses status consequences; steady state must show
  `1 passing`). Only investigate if it repeats after boot — or, at
  `min_machines_running = 1`, if it shows up outside a deploy, a `fly secrets
  set` or a `fly machine restart`: an always-on machine has no other cold
  starts, so one means a crash, OOM or host migration.
- **The public /demo page is exposed today, not at launch.**
  `src/app/(marketing)/demo/page.tsx` is live and taking flyer-QR traffic; its
  browser WebSocket to `/ws/test` wakes the machine the same way an inbound call
  does. While scaled to zero, every organic visitor after an idle period waits
  6-15s on the "connecting" state. Since SCRUM-579 an expiry at least fails loudly (the demo
  token lives 120s and close code 4003 surfaces as an error) instead of
  rendering a blank "Call Complete", but the dead air itself remains.

## Fast classic pipeline (SCRUM-594)

The demo line can run a faster variant of the classic pipeline: Twilio → Deepgram
**Flux** (hears the caller and decides when they have finished) → **Claude**
(`claude-haiku-5-5`, thinks) → Deepgram **Aura-2** over a WebSocket (speaks) → Twilio.
It is off by default; `DEMO_LINE_PIPELINE=classic-fast` turns it on for the demo line only.
Spec: `docs/superpowers/specs/2026-10-17-fast-classic-pipeline-design.md`.

**Why.** Gemini Live mishears real phone callers. It garbles spelled names and other
languages, and it heard "Nine is good" as "No, it's good" in 16 of 16 clean tests where
Deepgram transcribed the same calls correctly. The old classic pipeline hears well but took
about 4 s per reply. This variant keeps Deepgram's hearing and wins the time back: Flux
reports the end of the caller's turn early, so Claude starts before they have quite
finished; Claude's first spoken chunk can end at a comma; and Aura streams its first audio
about 50-100 ms after a flush.

**Latency.** Bench run during development (n=6): from the last speech frame to the first AI
audio, **median 1339 ms, p90 1748 ms**, with the early draft used on 6 of 6 turns. That is
synthetic phone audio streamed in real time from a Sydney laptop to the live Flux, Claude
and Aura APIs, so it excludes Twilio playout and the phone network. The same style of
harness measured Gemini Live at about 1.5 s and the old classic pipeline at about 4 s. The
target on real calls is a median of 1.8 s or less; the real numbers come from the
`[FastTurn]` and `[FastCall]` lines below.

### Turn it on, and off

```bash
fly secrets set DEMO_LINE_PIPELINE=classic-fast -a phondo-voice   # on
fly secrets unset DEMO_LINE_PIPELINE -a phondo-voice              # kill switch
```

Either one restarts the machine: a live call has up to 15 s to end on its own and is then
cut off, and a call arriving during the restart hears the voicemail fallback. Do it when
`fly logs -a phondo-voice --no-tail` shows no recent `callSid=`. Unset puts the demo line
back on `VOICE_PIPELINE`; `DEMO_LINE_PIPELINE=gemini-live` or `=classic` pins it to that
pipeline instead. Any other value is ignored, with one warning per value:
`[PipelineRouting] DEMO_LINE_PIPELINE "<x>" not recognised — ignoring (expected one of: classic-fast, classic, gemini-live)`.

There is no boot line for this switch. To confirm it took effect, call the demo line and
look for `[FastPath] Flux STT and the Aura stream on api.au.deepgram.com (callSid=…)`, then
`[FastPath] Flux connected (callSid=…)`. The tuning variables (`FLUX_EOT_THRESHOLD`,
`FLUX_EAGER_EOT_THRESHOLD`, `FLUX_EOT_TIMEOUT_MS`, `FAST_LLM_MODEL`, `FAST_DEEPGRAM_HOST`,
`NO_TURN_WATCHDOG`) are documented in `voice-server/.env.example`.

The no-turn watchdog (speech in the caller's audio but no Flux turns: another language, or a
noisy line it misjudged) only logs and captures by default (`NO_TURN_WATCHDOG=log`). Once
its `would fall back` lines have proved trustworthy on real calls, let it act:

```bash
fly secrets set NO_TURN_WATCHDOG=act -a phondo-voice    # hand such calls to Nova
fly secrets unset NO_TURN_WATCHDOG -a phondo-voice      # back to log only
```

### What a call needs to use it

All three, or the call takes the pipeline it would have taken without the switch:

- **A customer call to the demo line.** The called number is in `DEMO_LINE_NUMBERS`
  (default `+61238205672`). Owner calls (`OWNER_PIPELINE`), every other number and the
  browser test calls (`/ws/test`) are untouched.
- **`ANTHROPIC_API_KEY` and `DEEPGRAM_API_KEY` both set** (an empty value counts as
  missing). Otherwise the call goes to the global pipeline and the server logs, once per
  process, `[PipelineRouting] classic-fast needs ANTHROPIC_API_KEY and DEEPGRAM_API_KEY — using <pipeline>`.
- **An English assistant.** Flux is English-only. Otherwise every such call logs
  `[PipelineRouting] DEMO_LINE_PIPELINE=classic-fast ignored — the assistant's language is "<lang>" …`.

The Gemini-specific safeguards (the Tier-1/Tier-2 tool-result validators and the SCRUM-593
booking pre-check) are not on this path: when you test, read the saved booking back against
what was said.

### How a turn works

- **Early drafts.** Flux sends an early end-of-turn when it is fairly sure the caller has
  finished. Claude starts on those words at once as a silent draft: nothing is spoken, the
  conversation is not touched and no tool runs. If the real end-of-turn has the same words,
  the draft is used and the reply starts that much sooner (`spec=adopted`). If the caller
  carries on, or the words differ, it is thrown away (`spec=discarded`, one wasted Claude
  call). No draft starts while the AI is speaking or still working on the last turn, or when
  a phone number, email, name, address or date is expected. `FLUX_EAGER_EOT_THRESHOLD=off`
  turns drafts off.
- **Phone numbers, spelled names, emails, addresses, dates.** When the AI has just asked for
  one, the caller's words go through the classic debounce buffer (`trigger=buffered`), which
  merges digits and letters that Flux splits across turns.
- **Barge-in.** Three or more words from the caller while the AI is speaking or working stop
  the AI at once: its audio is cleared, the reply in flight is aborted and any draft is
  dropped. A tool that is already running is never cut off; the turn ends before Claude's
  next round. The caller's words are kept and answered, and the AI's side is recorded as what
  it had already said plus "…". One or two words are judged when the caller stops talking:
  an interrupt word first ("stop", "wait", "hold on", "no", "cancel", "never mind",
  "excuse me", "hello", "hey", and on this path also "sorry", "pardon", "what", "huh",
  "say that again", "repeat that") cuts in, and the caller is answered at once.
- **Backchannels are ignored.** One or two of "okay", "yeah", "yep", "yes", "sure", "right",
  "alright", "cool", "great", "perfect", "thanks", "thank you", "mm-hmm", "uh-huh",
  "no worries" or "no problem", said while the AI is speaking or working, are not a turn: the
  AI carries on and the log shows `[STT] Dropped (backchannel while the AI is busy)`. Any
  other short reply ("Tuesday") is a real turn. It waits up to 10 s for the AI to finish and
  is then answered, instead of talking over the AI. The words are recorded at once, so if the
  caller then talks over the AI (a barge-in), that wait ends without a reply to them alone:
  the next turn answers both.
- **An answer at the tail of a question is kept.** If the AI's reply ends in a question, at
  most 2 s of its audio is left, and the caller began speaking after the question started
  (Flux's start of turn at least 0.5 s after it), a one- or two-word reply ("Yes", "Ten AM")
  is the answer, and is answered as soon as the AI finishes. An "okay" to the sentence before
  the question is a backchannel. When the timing is unknown (the AI is speaking over REST),
  the tail rule does not apply.
- **An answer during a long question is not lost.** A "yes" said after a long question
  started, but before its last 2 s, is dropped while the question plays and answered when the
  AI finishes (`[FastTurn] … trigger=deferred`).
- **A silence after a question gets one re-prompt.** If the AI finishes on a question and the
  caller says nothing for 6 s, it says "Sorry, I didn't catch that." and the question again,
  once per question (`[FastTurn] No answer 6000 ms after the AI's question — asking it again`).
  Never while the caller is already talking (a turn Flux has open), and never after a Flux
  fallback. It is added to the conversation only once its audio is heard.
- **The recording disclosure cannot be interrupted.** While it plays, a barge-in is ignored
  (`[Barge-in] (fast) ignored — the recording disclosure is playing`), nothing clears the
  audio, and a turn that starts waits. The greeting after it can be interrupted.
- **Speakerphone echo.** A speakerphone feeds the AI's voice back into the caller's mic and
  Flux transcribes it. A phrase of three or more words that is mostly the AI's own recent
  words (80% or more of its words appear in what the AI said, with a run of three in a row,
  and no number the AI did not say) is not a barge-in, and as a final it is dropped
  (`[STT] Dropped (echo-like: the AI's own words coming back)`), so the AI does not answer
  itself. The cost: a caller who repeats the AI's sentence almost word for word loses that
  turn and the AI asks again. A restated phrase with a changed number ("ten fifteen" against
  the AI's "ten thirty") is never taken for echo.
- **A goodbye hangs up.** When Claude calls `end_call`, the AI says goodbye and the line
  closes once the audio has played (at most 8 s, plus 0.5 s), with `ended_reason`
  `end_call_tool`. This is a fix for every classic call: they used to ignore `end_call` and
  leave the line open. The SCRUM-373 booking guard applies: with a booking started and not
  finished, the first `end_call` is blocked and Claude is told to finish it
  (`[HallucinationGuard] Blocking end_call …`). After a failed reschedule it is told the
  caller's existing appointment is unchanged, never that there is no appointment.
- **Short replies.** The fast path adds a voice-style section to the system prompt: at most
  two short sentences a turn, one question at a time, no repeating the last offer, and a
  booking made earlier in the call is changed or cancelled with the name and time booked,
  without asking the caller for them again.
- **Spelled letters.** Aura drops letters of a hyphenated spelling ("M-A-K-H-O-U-L" came out
  as five letters), so the words sent to TTS spell them with commas ("M, A, K, …"). The
  transcript and the conversation keep what Claude wrote. Words ("co-op"), numbers ("9-5")
  and phone numbers are left alone.

### Fallbacks and watchdogs

Each half degrades on its own, to the classic component, and never to an ended call. A
fallback can cost a moment of silence, but no words are lost silently: when Aura fails
mid-reply, what it was given and never voiced is said again over REST (`[FastPath] Saying
again over REST the N characters the Aura stream never voiced`; it may repeat the last
sentence, if its audio did arrive but Aura died before confirming it), and if that is impossible
(the stream is closing, or REST fails too) the next turn is told the caller did not hear it.
When Flux fails mid-turn, the caller's words so far are answered (`[FastPath] Answering the
turn Flux left open`, `trigger=stt-fallback`), unless the engine would have dropped them (a
backchannel while the AI is busy, or the AI's own words coming back: `[STT] Dropped (a
backchannel or echo Flux left open)`), or, if the turn had started with no words yet and the
AI is not speaking, the caller is asked to say it again. Each fallback also writes an `[ALERT:error]` line
(the Sentry shim logs captures), so the generic `Voice server — error logged` rule fires.

| Falls back | When | Log lines | Then |
|---|---|---|---|
| **Flux → Nova** | Flux does not open within 3 s; a Flux error, or a close we did not ask for, before or after it opens; the stuck-stream watchdog: no frame at all from Flux for 5 s while the caller's audio keeps going out (Flux normally sends one about every 240 ms); or, with `NO_TURN_WATCHDOG=act` only, the no-turn watchdog: 3 s of the caller's speech within 8 s, while the AI is silent and idle, with no Flux turn event at all (`speech but no turns`: a language Flux does not transcribe; the caller is asked to say it again; captured at warning level, so it does not page). Speech is a frame at 4 times the line's noise floor (its 20th-percentile level over 10 s), and never below RMS 300, so a steady site or van noise does not count | `[FastPath] Flux unavailable — falling back to Nova (<reason>, callSid=…)` and `[ALERT:error] [flux-stt] … what=Flux unavailable: <reason>` | Nova-3 and the classic debounce buffer for the rest of the call; Aura keeps speaking. `[FastCall]` says `stt=nova-fallback` |
| **Aura → REST** | Aura does not open within 3 s; an Aura error, or a close we did not ask for; or the stuck-stream watchdog: a flush whose `Flushed` is 3 s overdue with no Aura audio in that time | `[FastPath] Aura stream unavailable — falling back to REST TTS (<reason>, callSid=…)` and `[ALERT:error] [aura-stream] … what=Aura stream unavailable: <reason>`. A healthy stream logs `[FastPath] Aura connected` | REST TTS, one request per sentence on the default Deepgram host, for the rest of the call. `[FastCall]` says `tts=rest-fallback` |

Both at once is close to the old classic pipeline, with Claude as its LLM. A turn action that throws
is contained and the call carries on: `[FastTurn] <action> failed (callSid=…)` with
`[ALERT:error] [fast-turns]`. Logged without an alert:

- `[FastPath] Aura flush refused (N in the last minute) — relying on sentence release`, once
  per call. Aura allows 20 flushes a minute and the client stops at 18; finished sentences
  are still released.
- `[FastPath] Aura warning <code>: …` and `[FastPath] Flux <type> <code>: …`: provider
  warnings, such as `CLEARED_TIMEOUT` (a Clear that was never acknowledged; the client stops
  waiting after 750 ms).
- `[FastPath] A playback mark (<what>) never came back — treating that audio as played`:
  Twilio never returned a mark, so 5 s past the audio's estimated end it counts as played.
- `[FastTurn] Waited N ms for the AI to finish before answering`, or `The AI was still
  speaking after N ms — answering anyway` once the 10 s cap is hit.
- `[SpeculativeReply] draft failed turn=N: …`: an early draft's Claude call failed, so the
  turn answers with its own call.
- `[FastTurn] Draft cap reached (…) — answering live`, once per call: a turn had 2 drafts, or
  the call 60, so later turns are answered without one.

Claude itself has no fallback (Fly runs `LLM_PROVIDER=anthropic`, so another provider would
use the same key). A Claude error or a 15 s timeout gets the classic apology ("I'm sorry, I'm
having a little trouble right now. Could you repeat that?") and the caller's words for that
turn are dropped from the history. The log shows `[Pipeline] unknown error (callSid=…)`
followed by the error (an `Anthropic …` message for an API error): the error-source label
only knows OpenAI, so "unknown" is expected here. Each such turn is captured with service
`claude-chat` (`what=fast turn failed (N in a row)`): warning level for the first, error
level from the second in a row, which pages. A bad `ANTHROPIC_API_KEY` or `FAST_LLM_MODEL`
shows up there on the first call. `[FastCall]` counts them as `llm_errors`, and an apology
is never counted as a turn's latency.

### Log lines

Per-call lines carry `callSid=`. None carries caller words: the `[STT] Dropped …` lines end
in a length (`[5 chars]`), and the `[FastTurn]` and `[FastCall]` lines are ids, times and enums.

- `[FastTurn] callSid=… trigger=… spec=… eot_to_llm=… eot_to_audio=… eager_lead=… waited=…`:
  one per answered turn, written when its first audio goes out.
  - `trigger`: how the turn ended. `model` is Flux's own decision, `timeout` is silence for
    `FLUX_EOT_TIMEOUT_MS`, and `buffered` means it came through the debounce buffer (a phone
    number or spelled name, or any turn after the Nova fallback). `stt-fallback` is the turn
    Flux left open when it failed; `deferred` is a short answer to a long question, answered
    once the AI finished.
  - `spec`: `adopted` (an early draft was used), `discarded` (one was started and thrown
    away) or `none`.
  - `eot_to_llm`: ms from Flux's end-of-turn to Claude's first words or first tool call.
    Shorter with an adopted draft, because Claude has been running since the early end-of-turn.
  - `eot_to_audio`: ms from Flux's end-of-turn to the first audio of the reply handed to
    Twilio (a filler or an apology does not count). The number to watch.
  - `waited`: ms the turn waited before Claude could start: queued behind another turn, or
    waiting for the AI's own audio to finish. Such a turn's `eot_to_audio` includes the wait,
    so it is logged but left out of the call's p50/p90.
  - `eager_lead`: ms from the early end-of-turn to the real one when a draft was started:
    the head start it bought.
  - `-` means it never happened, for example a barge-in before the first audio.
- `[FastCall] callSid=… turns=N eot_to_audio_p50=… p90=… spec_adopted=N spec_discarded=N llm_errors=N stt=… tts=…`:
  the call's summary, at the end. The percentiles leave out turns that waited. `llm_errors`
  counts turns that got the apology. `stt` is `flux` or `nova-fallback`; `tts` is `stream` or
  `rest-fallback`.
- `[Barge-in] (fast) Stopped the AI's audio and its reply`, then `[FastTurn] Reply stopped
  (barge-in) — kept what was said`. Also `[Barge-in] (fast) ignored — …` (the disclosure is
  playing, or the AI is ending the call).
- `[EndCall] Hanging up after end_call — waited Nms for playback`: the goodbye played and
  the line closed.
- `[FastPath] Asking the caller to say it again after the Flux fallback` and `[FastTurn] No
  answer … asking it again`: the two prompts the AI says on its own.
- Fallbacks and watchdogs: the lines in the section above.

In the database, `calls.metadata.pipeline` is `classic-fast`, `classic` or `gemini-live`,
written for demo-line customer calls only (older calls have no such key), and
`calls.metadata.fastPath` is the `[FastCall]` summary as `{ turns, eotToAudioP50,
eotToAudioP90, specAdopted, specDiscarded, llmErrors, stt, tts }`, on fast-path calls only.
Both survive a transfer: the first leg's values are written with the call.

```sql
select started_at, metadata->>'pipeline' as pipeline, metadata->'fastPath' as fast_path
from calls where metadata->>'pipeline' is not null order by started_at desc limit 20;
```

```bash
fly logs -a phondo-voice --no-tail | grep -E "\[Fast(Path|Turn|Call)\]"       # the fast path's story
fly logs -a phondo-voice --no-tail | grep -E "\[FastPath\].*falling back"     # fallbacks
```

```logql
{fly_app_name="phondo-voice"} |~ "\\[Fast(Path|Turn|Call)\\]"
{fly_app_name="phondo-voice"} |~ "\\[ALERT:(error|warning)\\] \\[(flux-stt|aura-stream|fast-turns|claude-chat)\\]"
```

### Phone test: what to compare with Gemini calls

Call the demo line with the switch on. The demo cap is 3 minutes (`DEMO_MAX_CALL_MINUTES`,
whole minutes 1-15), so raise it for a long test and unset it afterwards. A script: spell the
surname; ask for "ten AM" and say "nine is good"; answer a question with a quick "yes"; talk
over the AI mid-sentence; say "No worries" while it says "one moment"; say "Hello?" into a
silence; say goodbye; and run it once from a speakerphone. Then compare with a Gemini call:

1. **Hearing.** The transcript has the spelled surname, the time and the numbers right. This
   is what Gemini got wrong. On the call page, "Live transcript" is what the AI heard during
   the call; the default view is the re-transcription of the recording.
2. **Speed.** By ear first, then `[FastTurn] eot_to_audio` per turn and the `[FastCall]`
   p50 and p90. Gemini calls log no per-turn timing, so time those by stopwatch or from the
   recording. `eot_to_audio` starts at Flux's end-of-turn, which lands a few hundred ms after
   the caller stops (0.4-0.9 s in the bench), so add that, plus Twilio and the phone network,
   before comparing it with Gemini's gap of roughly 1.5 s. Target: a median of 1.8 s or less.
3. **Turn-taking.** No cut-in on a pause mid-sentence (if it jumps in, raise
   `FLUX_EOT_THRESHOLD`). A barge-in stops the AI within a beat and the AI answers the new
   words. "Okay" and "mm-hmm" do not derail it. A "yes" at the end of a question is answered.
   Nothing cuts the recording disclosure. On a speakerphone the AI does not answer itself.
4. **Bookings and the ending.** The appointment saved matches what was said, and the goodbye
   hangs up the line.
5. **Health.** `[FastCall]` says `stt=flux tts=stream`, and `spec_adopted` outnumbers
   `spec_discarded`. A high discard rate means callers pause mid-sentence: raise
   `FLUX_EAGER_EOT_THRESHOLD` or set it to `off`.

Watch for:
- A "yes" said to the sentence before a question is ignored, as it should be, but one said
  very early in a long question is only answered once the question ends: check that this
  feels natural, and that a caller who says nothing gets the one re-prompt after 6 s.
- `[FastPath] no-turn watchdog would fall back (speech but no turns)`: the caller's audio
  carried speech Flux reported no turns for. With `NO_TURN_WATCHDOG=log` (the default) that
  is all that happens. Check these calls: a real non-English or garbled caller means the
  watchdog is right (consider `NO_TURN_WATCHDOG=act`); a noisy site, van or street with an
  English caller means it misfired.
- An echo that is garbled or partial slips past the filter and is answered as if the caller
  said it. If a speakerphone test shows the AI answering itself, that is the case to bring back.
- The Flux watchdog assumes Flux keeps sending frames through silence. A fallback reading
  `no frames for … ms while audio went out` on a healthy, quiet line would show up as
  `stt=nova-fallback`.

### Privacy

- Every Deepgram connection the fast path opens sends `mip_opt_out=true`, which keeps the
  audio out of Deepgram's Model Improvement Program: Flux, the Aura stream, and the REST
  speech for the greeting and disclosure. The Nova and REST fallbacks and the post-call
  re-transcription carry it too (SCRUM-595).
- Deepgram processing runs on Deepgram's Australian endpoint; the LLM (Anthropic) is
  offshore. In detail: Flux, the Aura stream and the greeting and disclosure synthesis use
  `FAST_DEEPGRAM_HOST` (default `api.au.deepgram.com`). The fallbacks (Nova after a Flux
  failure, REST speech after an Aura failure) and the post-call re-transcription use the
  default `api.deepgram.com`, so a call that degrades touches that endpoint too. Claude
  receives the conversation as text only, never audio.
- Do not describe this path as keeping call data inside Australia. Use the approved
  data-residency wording: storage at rest in Sydney, AI processing that may occur outside
  Australia, providers disclosed.
- Logs hold no caller words unless `DEBUG_TRANSCRIPTS=true` (SCRUM-339); it is not set in
  production.

## Customer calls (SCRUM-598)

The owner's assistant can phone a customer about one booking: after a cancel or
a move ("let them know by call"), or through `owner_call_customer` to confirm a
booking or find a new time. The voice server places the call from the org's
Phondo number and runs it as a receptionist session with an OUTBOUND CALL
section last (`lib/notify-call-prompt.js`). The owner gets one email per call,
built from the call row and the diary (`src/lib/owner-assistant/call-outcome.ts`).
It ships dark: nothing is offered until the flag is set.

### What a call needs

`lib/customer-call.js` checks all of this twice, when the owner's read-back is
built and again at placement:

- `OWNER_CUSTOMER_CALLS_ENABLED=true` and Gemini Live (`GEMINI_API_KEY`). The
  classic pipeline never runs these calls.
- A request from that org's own owner session. The demo org is never called from.
- An AU org and an AU mobile or landline (`+61[23478]…`) that matches the
  booking's number exactly, between 8 am and 8 pm in the org's time.
- An active, AI-on Twilio number with an assistant. It is the caller ID, so
  ringing back reaches the receptionist.
- Caps over 24 hours: 20 calls per org, 2 per customer number, and 1 per booking
  and purpose. A number that asked not to be called is never called again.
- A backstop of 30 placements per 10 minutes across all orgs.

### How a call ends

- **The session's cleanup** writes the row and calls call-completed, which sends
  the email.
- **Twilio's status callback** finishes the calls nobody talked on: no answer,
  busy, failed, or a fax.
- **A sweeper** runs every 5 minutes while the flag is on. It finishes rows
  stuck for 15+ minutes from Twilio's own record of the call, and gives up
  after 2 hours (finished as unknown). A row no placement wrote (no real call
  sid, or one Twilio has no record of) is closed quietly, with no email:
  `sweep: closed row … no call to finish`. Many of those from one org means
  someone is inserting junk rows.
- **One machine.** Live customer calls are tracked in memory
  (`liveCustomerCalls`), so the status callback must reach the machine running
  the session. The app runs one machine today. **Before scaling to two, make
  the session's final write conditional.** Otherwise a callback on the other
  machine finishes a live call as "cut off", and the owner can get two
  contradicting emails.

### Alerts

Every line starts `[CustomerCall]`:
`{fly_app_name="phondo-voice"} |= "[CustomerCall]"`.

| `[ALERT:error]` line | Meaning | Action |
|---|---|---|
| `placement backstop hit` | 30 placements in 10 minutes across all orgs | Look for a loop (same org or booking). Unset the flag if it's runaway. |
| `Twilio refused the call` / `returned no call sid` | `calls.create` failed (code and status only, never the message) | Look up the Twilio error code; check the from-number. |
| `Twilio accepted call … after the timeout — cancelling it` | Twilio took over 9 s; the call was cancelled | Nothing, unless `could not cancel` follows. |
| `could not cancel …` | A call may be ringing with no row | Find the sid in Twilio's call log and cancel it. |
| `call row not written — cancelling the call` | The insert failed after Twilio accepted | Check Supabase. The call was cancelled. |
| `record was not written after its conversation` | Both writes of a finished conversation failed | Check Supabase. The sweeper finishes it as cut off. |
| `could not finish call … no outcome email` | The final row write failed | Check Supabase. The sweeper retries. |
| `status: row unreadable` / `status handling threw` | Twilio's status callback couldn't be handled | The sweeper retries within about 20 minutes. |
| `sweep: open customer calls unreadable` / `sweep threw` | The sweeper failed | Check Supabase. It runs again in 5 minutes. |
| `could not read call … to stamp` / `could not stamp call …` | A do-not-call, a setup failure or the answer type wasn't saved | A lost do-not-call matters: tell the owner. |
| `no call context` / `no briefing` / `the line now belongs to another org` | The session couldn't start | The row is stamped `setup_failed` (waiting at most 2 s), and the email says it failed on our side. |
| `wasn't waiting for this stream` | A replayed or late stream for a call another flow already claimed | The session ends without touching the row. Nothing to do unless it repeats. |
| `INTERNAL_API_URL/SECRET unset — no outcome email` | The voice server can't reach Next.js | Set the secrets. |

On the web side, a failed outcome email pages with
`reason=customer-call-outcome-email-failed`.

## Pipeline switching & kill switches

| Goal | Action |
|---|---|
| Force classic fallback (Gemini outage) | `fly secrets set VOICE_PIPELINE=classic -a phondo-voice` |
| Back to production | `fly secrets set VOICE_PIPELINE=gemini-live -a phondo-voice` |
| Route ONE number to a test pipeline | `fly secrets set 'TEST_PIPELINE_OVERRIDES=+61238205672:grok-realtime' -a phondo-voice` |
| Kill all eval overrides | `fly secrets unset TEST_PIPELINE_OVERRIDES -a phondo-voice` |
| Demo line on the fast classic pipeline (SCRUM-594) | `fly secrets set DEMO_LINE_PIPELINE=classic-fast -a phondo-voice` (restarts the machine: see [Fast classic pipeline](#fast-classic-pipeline-scrum-594)) |
| Demo line back to `VOICE_PIPELINE` (SCRUM-594 kill switch) | `fly secrets unset DEMO_LINE_PIPELINE -a phondo-voice` |
| Aura voice louder / quieter, or the boost off (SCRUM-594, phone test F7) | `fly secrets set AURA_GAIN_DB=8 -a phondo-voice` (0-12 dB, default 6); off: `AURA_GAIN_DB=off` |
| Revert the voice model (SCRUM-588) | `fly secrets set GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview -a phondo-voice` |
| Revert post-call analysis / Tier-2 validator models | `fly secrets set ANALYSIS_MODEL=gpt-4.1-mini VALIDATOR_MODEL=claude-haiku-4-5-20251001 -a phondo-voice` |
| Per-number AI off (calls forward instead) | `phone_numbers.ai_enabled=false` in DB / dashboard toggle |
| AI calls to customers on (SCRUM-598) | `fly secrets set OWNER_CUSTOMER_CALLS_ENABLED=true -a phondo-voice` |
| AI calls to customers off (stops even calls already ringing, at their TwiML fetch) | `fly secrets unset OWNER_CUSTOMER_CALLS_ENABLED -a phondo-voice` |

Proof of which pipeline a call ran (tool/transcript logs say `[GeminiLive]` on
several shared paths): the `[Pipeline] TEST override → …` line and the
adapter's own `[GrokRealtime]`/`[OpenAIRealtime]` lines.

## Log cookbook

```bash
fly logs -a phondo-voice                                   # live tail
fly logs -a phondo-voice --no-tail | grep "ALERT:error"    # recent errors
fly logs -a phondo-voice --no-tail | grep -i pipeline      # pipeline routing per call
fly logs -a phondo-voice --no-tail | grep "callSid=CAxxxx" # one call's story
```

Loki (Grafana Explore, datasource `grafanacloud-logs`):

```logql
{fly_app_name="phondo-voice"} |= "[ALERT:error]"            # voice errors
{fly_app_name="phondo-voice"} |~ "\\[Hallucin(atedAction|ationGuard)\\]"
{service_name="phondo-next"} |= "[ALERT:"                   # web app alerts
sum(count_over_time({fly_app_name="phondo-voice"} |= "[ALERT:error]" [1h]))  # error count
```

Labels: voice = `fly_app_name="phondo-voice"` (its `level` label is ALWAYS
`info` — never filter on it); Next.js = `service_name="phondo-next"` (Vercel
preserves real levels, but content-matching is the house convention).

## Notification chains (who hears about what)

- **Customer (business owner + org admins)**: failed/missed/unsuccessful-call
  emails, booking/callback/daily-summary — via Resend, per-recipient sends
  (SCRUM-497). Copy is provider-neutral (SCRUM-496).
- **Operator (you)**: Grafana `phondo-email` only. If a failure email reaches a
  customer but not you, the relevant Grafana rule is broken — see liveness
  check.
- Subscription/billing emails: owner only, by design.

## Escalation cheatsheet

- Fly dashboard: https://fly.io/apps/phondo-voice · Grafana: stack `michaelm` (AU)
- Key envs on `phondo-voice`: `VOICE_PIPELINE`, `DEMO_LINE_PIPELINE`, `TEST_PIPELINE_OVERRIDES`,
  `GEMINI_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `XAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `INTERNAL_API_URL`/`INTERNAL_API_SECRET` (owner
  notifications die without these two), `TWILIO_*`
- Log shipper: app `phondo-log-shipper` must be scaled to 1 (`fly scale count 1 -a phondo-log-shipper`) or Loki goes blind (and every alert with `no_data_state=OK` goes silently green).
