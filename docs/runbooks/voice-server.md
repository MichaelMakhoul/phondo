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
| Voice server | Fly.io app `phondo-voice` (syd), `performance-1x`/2GB, autostop/autostart | deploy from `voice-server/` ONLY |
| Web app + internal API | Vercel (Next.js), auto-deploys on merge to `main` | receives `/api/internal/call-completed` |
| DB | Supabase (AU) | `calls`, `appointments`, `org_members`, … |
| Logs | Fly → `fly-log-shipper` app → Grafana Cloud Loki (AU, `grafanacloud-logs`) | shipper must stay scaled to 1 or logs are lost |
| Alerts | Grafana folder `Phondo`, contact point `phondo-email` → michaelmakhoul0@gmail.com | policy: warning 30s wait/4h repeat, critical 10s/30m |
| Telephony | Twilio (AU + US numbers) | webhook → `https://phondo-voice.fly.dev/twiml` |

### Pipelines (per call)

- **Production**: Gemini 3.1 Flash Live (`VOICE_PIPELINE=gemini-live`).
- **Fallback**: classic Deepgram STT → OpenAI → Deepgram TTS (automatic when
  `GEMINI_API_KEY` missing; or `VOICE_PIPELINE=classic`).
- **Eval overrides (SCRUM-378)**: `TEST_PIPELINE_OVERRIDES="<number>:<pipeline>"`
  routes ONE dialed number to `openai-realtime` (needs `OPENAI_API_KEY`),
  `grok-realtime` (needs `XAI_API_KEY`), or `conversationrelay` (needs
  `ANTHROPIC_API_KEY`). Unknown names and missing keys warn loudly and fall
  back to Gemini — grep `[Pipeline]` to see what a call actually ran.

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
   reproduce with the curl below to read the provider's error body.
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
cd voice-server               # fly.toml + Dockerfile live HERE; deploying from repo root FAILS
fly deploy -a phondo-voice    # remote Docker build, ~2-4 min
fly status -a phondo-voice    # expect state started/stopped, checks passing
curl -s -o /dev/null -w "%{http_code}\n" https://phondo-voice.fly.dev/health   # 200
```

- **Verify before dialing**: a call placed mid-deploy lands on the OLD version
  (burned two eval sessions). Confirm the boot line
  (`Voice pipeline: …`) appears in `fly logs` AFTER the deploy finishes.
- **Rollback**: `fly releases -a phondo-voice` → copy the previous image ref →
  `fly deploy -a phondo-voice -i <registry.fly.io/phondo-voice@sha256:…>`.
- **Secrets**: `fly secrets set K=V -a phondo-voice` restarts machines
  immediately; add `--stage` to batch several and apply on next deploy.
- Machine autostops when idle; first call after idle cold-starts (~4s). The
  log line `Health check 'servicecheck-00-http-3001' … has failed` **once per
  cold start is EXPECTED** (first probe races the 3s boot; `grace_period=30s`
  already suppresses status consequences; steady state must show
  `1 passing`). Only investigate if it repeats after boot. Eliminating the
  cold start entirely = SCRUM-189 (`min_machines_running=1`, +$27/mo, owner
  decision before launch).

## Pipeline switching & kill switches

| Goal | Action |
|---|---|
| Force classic fallback (Gemini outage) | `fly secrets set VOICE_PIPELINE=classic -a phondo-voice` |
| Back to production | `fly secrets set VOICE_PIPELINE=gemini-live -a phondo-voice` |
| Route ONE number to a test pipeline | `fly secrets set 'TEST_PIPELINE_OVERRIDES=+61238205672:grok-realtime' -a phondo-voice` |
| Kill all eval overrides | `fly secrets unset TEST_PIPELINE_OVERRIDES -a phondo-voice` |
| Per-number AI off (calls forward instead) | `phone_numbers.ai_enabled=false` in DB / dashboard toggle |

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
- Key envs on `phondo-voice`: `VOICE_PIPELINE`, `TEST_PIPELINE_OVERRIDES`,
  `GEMINI_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `XAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `INTERNAL_API_URL`/`INTERNAL_API_SECRET` (owner
  notifications die without these two), `TWILIO_*`
- Log shipper: app `phondo-log-shipper` must be scaled to 1 (`fly scale count 1 -a phondo-log-shipper`) or Loki goes blind (and every alert with `no_data_state=OK` goes silently green).
