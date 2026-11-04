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
  3. Expected: "Twilio detected voicemail or a call screener".
  4. Check what else you might see:
     - **The code prompt, for any reason:** press Enter to cancel.
       - If it said "no answering-machine result", Twilio doesn't report the verdict mid-call.
       - If it showed a verdict, the detection missed your voicemail.
       - Either way, only the code protects your calls.
     - **"Your phone wasn't answered (busy)":** your phone rejected the call instead of sending it to voicemail, so the check didn't run. Turn voicemail on and retry.
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
- **Call-backs:** they reach Phondo's AI line. Keep the voice server always-on while calling (`min_machines_running = 1` in `voice-server/fly.toml`; how to apply and verify it is under "Always-on" in `docs/runbooks/voice-server.md`), and check its call log for anyone asking not to be contacted.
- **Texts:** send them with `text.mjs` (below), from Phondo's outreach mobile.

## Texting from Phondo's outreach mobile (`text.mjs`)

Texts go from **0485 094 768**, a Twilio mobile number on Phondo's account, so they show as a normal number and not "Unverified". Replies are forwarded to your mobile. A call to the number rings Phondo's line, (02) 5701 5064.

**Preview first.** With no options, the script reads Twilio's history and lists every text in the batch: its words, how many SMS segments it costs, and whether it goes today, later or not at all, with the reason. Nothing is sent until you add `--send`.

```bash
# Preview today's batch
node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/text.mjs
# Send it
node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/text.mjs --send
# Answer one reply: preview, then add --send. Single quotes stop the shell eating "$149".
node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/text.mjs --to="0491 570 006" --text='From $149 a month after the free 30 days. Michael, Phondo. Reply STOP to opt out.'
```

Load both env files, as above. `scripts/outreach/.env` is where `DIAL_DNC_FILE` lives if your do-not-call list isn't in the default place, and the texter has to read the same list as the dialer.

- **The batch** is `~/.phondo-outreach/texts.json`, a JSON array of `{ "to", "business", "text", "source" }`, sent in order. Set `TEXT_BATCH` to use another file.
  - `source` is your evidence of consent: where the business publishes the number, e.g. "Mobile published at https://example.com.au/; checked 2026-10-05". The Spam Act puts the burden of showing consent on the sender (s 16). It goes in the log with each text.
- **Every text** has to say "Phondo" and "Reply STOP" (Spam Act s 17 and s 18) and fit in 4 SMS segments. Curly quotes and dashes are made plain, so a pasted text doesn't switch to the costlier encoding.
- **Opt-outs:**
  - A STOP-style reply is final. That's "STOP", "Unsubscribe", "Remove", "Cancel please", "stop texting me", "remove me from your list", "stop" as the first or last word ("Who is this? STOP"), or a short reply with "stop" in it. That number is never texted again, and it's added to the do-not-call list, so `dial.mjs` won't ring them either.
  - Each automatic addition is recorded once in `~/.phondo-outreach/opt-outs.csv`, with the list it went on. If you take a number off that list yourself, it stays off (every run reminds you), and texts to them stay blocked. A new STOP from them puts it back.
  - Plainer replies also block texts: "not interested", "no thanks", "wrong number", any other "remove" or "delete", and any other mention of "stop" ("can it stop calls going to voicemail?", "when does the trial stop?", "phones won't stop").
    - The preview quotes each one since your last text, with its ID. Once you've read them and none is a stop, answer with `--not-opt-out="what they meant" --seen=SM…`, using the ID of their newest one, as the preview prints it. The reason is logged.
    - If they've texted again since you looked, `--seen` won't match, and it refuses until you've read that one too.
  - Add anyone who says no some other way to the do-not-call list yourself.
- **Who else is skipped:**
  - anyone on the do-not-call list, `~/.phondo-outreach/do-not-call.txt`, which `dial.mjs` uses too
  - for the batch, anyone this number has already texted or who has texted it. A re-run never doubles up; answer a reply with `--to`.
- **A first text with `--to`** (to someone this number has never texted) needs `--source="…"`, and counts towards the day's limit.
- **Limits:**
  - 5 first texts a day by default (`--max=N`, up to 20), counted across everything this number has sent that day, so editing the batch doesn't reset it
  - only in the dialer's calling hours, Sydney time
  - never below US$5 of Twilio balance, so the phone lines keep answering
  - one send at a time: `--send` holds `~/.phondo-outreach/texts.csv.lock` while it runs. Ctrl-C releases it. If a send is killed outright, the next one tells you to delete the lock first.
- **Log:** sent texts are logged to `~/.phondo-outreach/texts.csv` (set `TEXT_LOG` to move it). Twilio's own history is what stops repeats, so a lost log can't cause a double text.
