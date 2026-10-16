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

## Pipeline switching & kill switches

| Goal | Action |
|---|---|
| Force classic fallback (Gemini outage) | `fly secrets set VOICE_PIPELINE=classic -a phondo-voice` |
| Back to production | `fly secrets set VOICE_PIPELINE=gemini-live -a phondo-voice` |
| Route ONE number to a test pipeline | `fly secrets set 'TEST_PIPELINE_OVERRIDES=+61238205672:grok-realtime' -a phondo-voice` |
| Kill all eval overrides | `fly secrets unset TEST_PIPELINE_OVERRIDES -a phondo-voice` |
| Revert the voice model (SCRUM-588) | `fly secrets set GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview -a phondo-voice` |
| Revert post-call analysis / Tier-2 validator models | `fly secrets set ANALYSIS_MODEL=gpt-4.1-mini VALIDATOR_MODEL=claude-haiku-4-5-20251001 -a phondo-voice` |
| Booking pre-check off (SCRUM-593) | `fly secrets set PRECHECK_MODE=off -a phondo-voice` (restarts the machine: see [Booking pre-check](#booking-pre-check-scrum-593)) |
| Per-number AI off (calls forward instead) | `phone_numbers.ai_enabled=false` in DB / dashboard toggle |

Proof of which pipeline a call ran (tool/transcript logs say `[GeminiLive]` on
several shared paths): the `[Pipeline] TEST override → …` line and the
adapter's own `[GrokRealtime]`/`[OpenAIRealtime]` lines.

## Booking pre-check (SCRUM-593)

Before a Gemini call writes a booking change (`book_appointment`,
`reschedule_appointment`, `update_appointment`, and the RebookGuard's name fix),
Claude (`PRECHECK_MODEL`, default `claude-haiku-5-5`) checks the name, date and
practitioner against what the caller said and confirmed. On a problem the write is
held and Gemini is told to confirm with the caller; after 2 holds of one tool in a
call the next attempt goes through. If Claude is slow (over 3 s) or down, the write
goes through unchecked (fail-open). The public website demo is never checked.
Spec: `docs/superpowers/specs/2026-10-15-booking-precheck-design.md`.

**Modes** (`PRECHECK_MODE`):
- unset or `enforce` (default): checks and holds;
- `shadow`: checks and logs what it would have done (the first verdict; no re-check), never holding or delaying a write;
- `off`, also `disabled`, `disable`, `false`, `0`, `no`, `n`, `none`, `skip`, `bypass` or `stop` (trimmed, any case): no check at all.

Any other value (`on`, `true` and `yes` included) ENFORCES, warns once (`[Precheck] unknown PRECHECK_MODE="…" — enforcing`) and pages at boot (below).

**At boot**, right after the `Voice pipeline:` line, the server logs what the check will do:
`[Precheck] mode=<enforce|shadow|off> model=<model> key=<set|MISSING|unset>`. `MISSING` means the check is
on but `ANTHROPIC_API_KEY` is not set; `unset` means it is off and the key does not matter. Two settings
that silently defeat the check page at boot, once each:
- `[ALERT:error] [booking_precheck] PRECHECK_MODE is not recognised: the booking pre-check is ENFORCING | … mode_value="…"`. Someone typed a mode we don't know. Fix the secret if they meant off or shadow.
- `[ALERT:error] [booking_precheck] Booking pre-check is on but ANTHROPIC_API_KEY is not set: writes go through unchecked`. Every booking write goes through unchecked until the key is set.

**Kill switch:** `fly secrets set PRECHECK_MODE=off -a phondo-voice`. Setting a secret
restarts the always-on machine: a live call gets the 15 s shutdown drain and is then
cut off, and a call that arrives during the restart gets the voicemail fallback. Do it
at a quiet time (no recent `callSid=` in `fly logs`). Back on:
`fly secrets unset PRECHECK_MODE -a phondo-voice`.

**Not behind the flag:** the Tier-2 checker's date fix (it now gets the business's
date and time, so "today"/"tomorrow" are no longer flagged as mismatches) ships with
the code. `PRECHECK_MODE` does not switch it back.

**Log lines.** Each carries `callSid=` and never caller words, names or values.

| Line | Meaning |
|---|---|
| `[Precheck] allow <tool> (<ms>ms)` | Claude read the call and allowed the write |
| `[Precheck] Holding <tool>: <problem> — hold n/2 (<ms>ms)` | held: Gemini confirms with the caller, then calls again |
| `[Precheck] unchecked <tool> (<ms>ms)` | no usable verdict (timeout, HTTP error, unreadable reply), so written unchecked; the cause is on the line before it: `[Precheck] No usable verdict (…)`, or the page below |
| `[Precheck] skip <tool> (no name or date to save)` | nothing to check (e.g. an email-only update) |
| `[Precheck] skip <tool> (public demo)` | the website demo (`/ws/test`, demo org) is never checked (no line while the check is off) |
| `[Precheck] (shadow) would hold <tool>: <problem>` | shadow mode: the would-be hold; the write went ahead |
| `[Precheck] caller spoke during the check — re-checking <tool> once` | the caller's words grew during a held check (a late "yes"), so it asked again |
| `[Precheck] re-check failed — holding on the first verdict <tool>: <problem>` | that second ask got no verdict, so the first verdict's hold stands (the failure still counts toward the page below) |
| `[Precheck] session ended during the check — writing the allowed <tool> anyway` | the caller hung up mid-check; the allowed write still happened |
| `[Precheck] <tool> let through unchecked after 2 holds` | the hold cap let it through; this pages (see below) |
| `[Precheck] held <tool> dropped — call ended during the check` | the caller hung up mid-check on a write the check held; nothing was written |
| `[Precheck] practitioner not resolved — rule 4 not applied` | the write saves a practitioner the call's staff list can't name (no snapshot, as for a Cliniko org, or an unknown id), so the practitioner rule could not be checked |
| `[NowLine] org timezone "<zone>" is not a valid IANA zone — using Australia/Sydney` | the org's timezone is malformed; "today"/"tomorrow" are judged against Sydney's date until it is fixed (once per bad value per process) |

**Pages:** `[ALERT:error] [booking_precheck] Booking pre-check producing no verdicts (…) — writes go through unchecked`.
- It fires at once on a config failure: `ANTHROPIC_API_KEY not set`, or HTTP 400/401/403/404 (a bad key, model or request field).
- It also fires from the 3rd failed check in a row (`(<n> unreadable in a row)`).
- Intermittent failures page too: `(<n> of the last <m> checks unreadable)` fires once 3 of the last 10 checks have failed, for example two failures in every three checks. It fires once per failed check while that holds.
- Bookings keep working, but unchecked. Triage from the line's `cause=`, `status=` and `error_type=`. For a bad model, `fly secrets unset PRECHECK_MODEL -a phondo-voice`.
- A page that ends `— held on the first verdict` came from a failed re-check: that write was held, not let through.
- `[ALERT:error] [booking_precheck] Booking pre-check glue threw — write went through unchecked` is a code bug: one write went through unchecked. Its `stack=` shows up to 3 frames of where it threw.
- `[ALERT:error] [booking_precheck] Booking pre-check: <tool> let through unchecked after 2 holds | … reason=precheck-hold-cap`: the check held one write twice in a call and let the third attempt through unchecked, so the caller is never trapped. One page is a caller the check could not satisfy. Several in a short time mean it is holding correct bookings: look at the `Holding … <problem>` lines, and step down to `shadow` if needed.

Loki: `{fly_app_name="phondo-voice"} |= "[Precheck]"`.

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
