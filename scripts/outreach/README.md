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
