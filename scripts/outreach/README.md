# Outreach sender

Safe-by-default cold-outreach tool. **Dry-run unless you pass `--send`.** Michael approves and runs every batch — nothing sends automatically.

## One-time setup

1. **Create a separate Resend key.** In the **phondo** Resend account (check the account name — not "Queroa"): API Keys → Create → name `phondo-outreach`, permission **Sending access**. Do **not** reuse the app's `EMAIL_API_KEY`.
2. **Pick a from-address on a verified phondo.ai domain.** Recommended: verify a subdomain (e.g. `go.phondo.ai`) in Resend and send as `michael@go.phondo.ai`, so outreach reputation can't hurt your transactional/root domain. Root `@phondo.ai` also works but shares reputation.
3. `cp scripts/outreach/.env.example scripts/outreach/.env` and fill in the key + from + reply-to. This file is gitignored; never put the outreach key in `.env.local`.

## Run

```bash
# 1. Preview a batch (no key needed):
node scripts/outreach/send.mjs --batch=scripts/outreach/batch.sample.json

# 2. Send ONE test to yourself first (confirm inbox placement, from-name, reply-to):
node --env-file=scripts/outreach/.env scripts/outreach/send.mjs --test=you@gmail.com

# 3. Schedule the real batch (all recipients get the time in --at, or per-row scheduledAt):
node --env-file=scripts/outreach/.env scripts/outreach/send.mjs --send --at="2026-07-15T09:30:00+10:00"
```

## Batch format

`scripts/outreach/batch.json` = JSON array (gitignored — it holds recipient addresses). Copy `batch.sample.json`. Per row: `email`, `template` (`T1` reviews / `T2` job-ad / `T3` real-call), `business`, `verticalPlural`, and the template's vars. **`evidence` is mandatory for T1/T2** — the real review or ad quote (honesty gate; the script refuses rows without it). `scheduledAt` is optional per row (ISO 8601, or use `--at` for the whole batch; Resend allows up to 30 days ahead).

## Rules the script enforces

- Honesty gate: no email goes out without the recipient's own quote.
- Suppression: anyone in `suppression.csv` (first column = email) is skipped. Add every "no" here permanently.
- Daily cap (default 15): refuses an oversized batch rather than silently trimming. Warm up 10–15/day → 20–25/day max.
- Plain text, one link (`phondo.ai/demo`), opt-out line on every message.

## Compliance (AU Spam Act)

Only email addresses the business has **published** (their site, their Seek/Indeed ad, `reception@`/`info@`). Keep the pitch relevant to their operations, identify yourself, and honour every opt-out. Don't reuse the app's transactional key or domain reputation for this.

## Calling from a business number (`dial.mjs`)

Twilio rings **your** mobile. Answer it and say hello, and after a moment you'll hear a two-digit code. Type the code in the terminal and Twilio rings the tradie, who sees Phondo's number, (02) 5701 5064. If they ring back, Phondo's AI receptionist answers.

**The code is the safeguard.** Only type a code you heard yourself on the call, never one read off a voicemail transcript or a call-screening screen. That way the tradie is never rung into a silent call.

As a backstop, Twilio's answering-machine detection hangs up if voicemail or a call screener answers your phone, so declining the call cancels it. The terminal shows the detection's verdict on every call, and the call log records it.

```bash
# Preview: runs every check and shows the plan without calling
node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/dial.mjs "0491 570 006"
# Place the call
node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/dial.mjs "0491 570 006" --call
```

0491 570 006 is an ACMA number reserved for fiction, so it's safe to try.

- **Set up:**
  - Set `DIAL_MY_MOBILE` (your own mobile) in `scripts/outreach/.env`.
  - Create the do-not-call list, even empty: `mkdir -p ~/.phondo-outreach && touch ~/.phondo-outreach/do-not-call.txt`. The script refuses to run without it.
  - Save (02) 5701 5064 in your contacts, so your phone's call screening doesn't answer it for you.
  - `DIAL_CALLER_ID`, `DIAL_DNC_FILE` and `DIAL_CALL_LOG` are optional; see `.env.example`.
- **First run:** check that the answering-machine backstop works.
  1. Place a call to the fictitious `0491 570 006` with `--call`, during calling hours.
  2. Decline it when your phone rings.
  3. Expected: "Twilio detected voicemail or a call screener", and nothing else happens.
  4. If instead it says "no answering-machine result", press Enter to cancel. The detection isn't working, so only the code protects your calls.
- **Calling hours (Telemarketing Industry Standard 2017, which covers business numbers too):**
  - Weekdays 9am–8pm and Saturdays 9am–5pm, never Sundays or national public holidays, all in **their** local time.
  - Landlines take their zone from the area code.
  - Mobiles are assumed to be in Sydney; add `--tz=Australia/Perth` (or similar) if they're elsewhere.
  - The hours are checked again just before connecting.
- **Consent:** if they asked you to ring outside those hours, add `--consented="asked 3/10 to ring Sat 7:30am"`. The note is logged as your evidence.
- **Do-not-call:** when someone asks you to stop, add their number to the list, one per line, with any note after a `#`:
  - Example: `0491 570 006  # Joe, asked to stop 7/10`
  - The script refuses listed numbers.
  - It stops on any line that isn't exactly one number, rather than skipping it.
- **Before calling:** check numbers against the national Do Not Call Register. A sole trader's mobile can be registered, and the ACMA offers a free subscription for small lists.
- **Call log:** every connected call is logged to `~/.phondo-outreach/calls.csv`. Each row records the time zones the hours were checked in, the answering-machine verdict, and any consent note.
- **Cost:** each call has two Twilio legs, your mobile and theirs, plus answering-machine detection on yours.
- **Call-backs:** they reach Phondo's AI line. Keep the voice server always-on while calling (see `voice-server/deploy.sh`), and check its call log for anyone asking not to be contacted.
- **Texts:** keep sending these from your own mobile. Twilio texts show as "Unverified" until sender registration, which needs the ABN.
