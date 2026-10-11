#!/usr/bin/env bash
# Deploy the voice server, then force the expensive wake so a CALLER never pays it.
# Use this instead of a bare `fly deploy`.
#
# SCRUM-579: whenever the app runs with min_machines_running = 0, the machine
# stops when idle. Twilio's read timeout for call webhooks is hard-capped at 15s,
# and a real call landing on a slow wake falls through to the fallback URL: the
# caller hears "our system is temporarily unavailable" and a status: "failed"
# row lands in the business's call log.
#
# SCRUM-580: at min_machines_running >= 1 (always-on while outreach or a pilot
# runs) the machine never autostops, so no later wake is waiting for a caller —
# and the stop below would CREATE one: it drains any call that began after the
# deploy and leaves the line dead for a 6-14.5s wake. So the stop runs only
# when fly.toml scales to zero; always-on, this script deploys and then just
# checks /health.
#
# WHY THE STOP BELOW (scale-to-zero only) — measured 2026-08-23. `fly deploy`
# leaves the machine STARTED, so curling /health right
# after a deploy hits a running machine in ~80ms and absorbs nothing. The
# expensive wake (~14.5s: the host re-pulls the image) lands on the FIRST wake
# after the machine subsequently autostops — i.e. on whoever calls next.
# Observed: deploy 06:19:54Z left it started; it autostopped by 06:25:14Z; the
# wake at 06:25:15Z pulled the image and took 14.5s; the next wake, image now
# host-cached, took 5.9s.
#
# So we stop it ourselves and wake it ourselves. The deploy has already
# restarted the machine at this point, so the stop only drains calls begun in
# the seconds since — worth it at scale-to-zero, where the alternative is a
# caller paying the pull. (Based on one measured deploy — if a future deploy shows a pull
# at deploy time instead, this stop becomes unnecessary rather than harmful.)
set -euo pipefail

APP="${FLY_APP:-phondo-voice}"
# Derived from APP, not hardcoded: otherwise FLY_APP=phondo-voice-staging would
# deploy staging, warm PRODUCTION, and report success for an unwarmed machine.
HEALTH_URL="${VOICE_SERVER_HEALTH_URL:-https://${APP}.fly.dev/health}"

cd "$(dirname "$0")"   # fly.toml + Dockerfile live here; deploying from the repo root fails

echo "→ deploying $APP"
fly deploy -a "$APP" "$@"

# Reads ./fly.toml, so don't pass -c/--config through this script. The ^ anchor
# skips comment lines that merely mention the setting. A missing key means 0
# (Fly's default), so scale-to-zero — and the stop — stay the default.
if grep -Eq '^[[:space:]]*min_machines_running[[:space:]]*=[[:space:]]*[1-9]' fly.toml; then
  always_on=1
else
  always_on=0
fi

if [ "$always_on" = 1 ]; then
  echo "→ always-on (min_machines_running >= 1): skipping the stop-and-warm"
  echo "→ checking $APP via $HEALTH_URL"
else
  echo "→ stopping $APP so the post-deploy image pull is paid here, not by a caller"
  # Explicit IDs: `fly machine stop` with no ids falls back to interactive
  # selection, which has no TTY in CI — it would fail every run, and the `||` below
  # would swallow it. `-w 30s` waits out the transition so the warm can't catch a
  # half-stopped machine.
  ids=$(fly machines list -a "$APP" -q 2>/dev/null || true)
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 -- word splitting is what we want; one arg per id
    fly machine stop -a "$APP" -w 30s $ids || echo "  (stop failed — warming anyway; see the check after the warm)"
  else
    echo "  (could not list machines — warming anyway; see the check after the warm)"
  fi
  echo "→ warming $APP via $HEALTH_URL"
fi
start=$(date +%s)
# NOT curl -f: with set -e, -f aborts the script at this assignment, so the
# diagnostic below never runs and the operator sees a bare `curl: (22)`. Read as
# a failed DEPLOY, that invites a re-run — which re-pulls the image and puts the
# machine straight back on the cold path this script exists to avoid.
# `|| code="000"` catches DNS/connect/timeout, which have no HTTP status at all.
code=$(curl -sS --max-time 60 -o /dev/null -w "%{http_code}" "$HEALTH_URL") || code="000"
elapsed=$(( $(date +%s) - start ))
echo "→ warm: HTTP $code in ${elapsed}s"

if [ "$code" != "200" ]; then
  echo "✗ health check returned $code after ${elapsed}s — the deploy is LIVE but NOT verified." >&2
  echo "  Do not just re-run this: check 'fly logs -a $APP' first. A re-deploy" >&2
  echo "  re-pulls the image and puts the machine back on the cold path." >&2
  echo "  If 'fly status -a $APP' shows the machine stopped, start it:" >&2
  echo "    fly machine start <id> -a $APP" >&2
  exit 1
fi

if [ "$always_on" = 1 ]; then
  echo "✓ deployed and answering (HTTP 200 in ${elapsed}s). Confirm the boot line: fly logs -a $APP"
  exit 0
fi

# Gate the success claim on the measured wake. An absorbed wake is ~6s cached or
# ~14.5s with a pull; a warm against an already-running machine returns in ~80ms.
# If the stop didn't take effect — for any reason, including a future flyctl
# change or Fly pulling at deploy time instead — the ✓ below would otherwise
# assert an absorption that never happened, and the exit code would agree.
if [ "$elapsed" -lt 3 ]; then
  echo "⚠ warm returned in ${elapsed}s — the machine was already running, so NO wake was absorbed." >&2
  echo "  The stop above did not take effect. The next caller after an autostop pays the pull." >&2
  echo "  Do it by hand:" >&2
  echo "    fly machine stop -a $APP -w 30s \$(fly machines list -a $APP -q)" >&2
  echo "    curl -sS --max-time 60 -o /dev/null -w '%{http_code}\\n' $HEALTH_URL" >&2
  # Exit 0 deliberately: the deploy succeeded. Only the warm-up is unverified.
  exit 0
fi

# 3-10s means a real wake happened, but off the host's cached image — so the
# ~14.5s image-pull wake was NOT reproduced here. That is the one premise in this
# script nobody has proven: a stop should not evict the image, so the pull
# measured on 2026-08-23 may have come from a host migration or a Fly GC, neither
# of which a stop reproduces. If so the expensive wake is still ahead, on a
# caller. Report it rather than let the ✓ imply otherwise.
if [ "$elapsed" -lt 10 ]; then
  echo "⚠ warm took ${elapsed}s — that is a CACHED wake (~6s), not a pull (~14.5s)." >&2
  echo "  A stop does not normally evict the image, so the pull was probably not" >&2
  echo "  absorbed here and may still land on a caller. Deploy is fine; see SCRUM-579." >&2
  exit 0
fi

echo "✓ deployed and warm (${elapsed}s — a pull-sized wake, absorbed here). Confirm the boot line: fly logs -a $APP"
