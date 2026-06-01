# Loop prompt: Security-audit fixes (SCRUM-338 … SCRUM-350)

Created 2026-05-28 from the first full security audit. Fixes the 12 code/DB-fixable findings; SCRUM-350 is a manual dashboard toggle the loop must SKIP.

## Order (one ticket = one iteration = one PR)

| # | Ticket | Severity | Touches | Deploy |
|---|---|---|---|---|
| 1 | SCRUM-338 | High | SSRF: integration test + webhook delivery + notification webhook_url | Next.js |
| 2 | SCRUM-339 | High | Caller transcript/name PII logging | voice-server (Fly) |
| 3 | SCRUM-340 | High | Demo-call token IP/cap | Next.js |
| 4 | SCRUM-341 | High | Single-use demo/test token + /ws/test cap | voice-server (Fly) + Next.js token issuance |
| 5 | SCRUM-342 | High | Next.js version upgrade | Next.js |
| 6 | SCRUM-343 | Medium | /ws/audio upgrade auth + caps — **CAUTION live call path** | voice-server (Fly) |
| 7 | SCRUM-344 | Medium | Internal per-call signed token — **CAUTION internal contract** | Next.js + voice-server (coordinated) |
| 8 | SCRUM-345 | Medium | org_members INSERT role guard | migration |
| 9 | SCRUM-346 | Medium | /auth/callback open redirect | Next.js |
| 10 | SCRUM-347 | Low | Hardening bundle (errors / .strict / timingSafe / shallow /health) | Next.js + voice-server (Fly) |
| 11 | SCRUM-348 | Low | SECURITY DEFINER auth.uid() guard | migration |
| 12 | SCRUM-349 | Low | Stripe webhook idempotency ledger | migration + Next.js |
| — | SCRUM-350 | Low | Leaked-password protection — **MANUAL, SKIP** | — |

## How to run

Fresh session (or the current one): `/loop` then paste the prompt below. No interval → self-paced (one ticket per wakeup).

## The prompt

```
Work the Phondo security-fix backlog, ONE TICKET PER ITERATION, in this exact order:
SCRUM-338, 339, 340, 341, 342, 343, 344, 345, 346, 347, 348, 349. SKIP SCRUM-350 (manual dashboard toggle — never attempt it).

STEP 1 — Pick the next ticket
- Fetch each ticket's status (mcp__mcp-atlassian__jira_get_issue, parallel). The next ticket is the first in the order above whose status is NOT Done and NOT the manual SCRUM-350.
- If all are Done, post a final summary (every merged PR URL + which were deferred/blocked) and STOP — do not schedule another wakeup.
- Read the chosen ticket's full description — it carries the exact file:line, exploit, fix, acceptance criteria, and deploy target.

STEP 2 — Prep
- git checkout main && git pull --ff-only (abort on failure; never force-overwrite).
- Branch: fix/SCRUM-<id>-<short-slug>.
- Transition the ticket to In Progress (jira_transition_issue id 21).

STEP 3 — Implement strictly to the ticket's acceptance criteria
- Touch only what the fix requires. Match existing patterns. Add/keep tests — never weaken or delete a test to make CI green.
- DB tickets (345, 348, 349): write a NEW migration file (next number after the latest in supabase/migrations/) — do NOT apply it yet.
- voice-server tickets: do NOT deploy yet.
- After each meaningful edit run: npx tsc --noEmit, npm run lint, npx vitest run. For voice-server changes ALSO run BOTH: `cd voice-server && node --test tests/*.test.js` AND `cd voice-server && npm run typecheck` (checkJs via jsconfig — CI runs this; `node -c` is syntax-only and MISSES checkJs type errors). Fix every failure before moving on.

STEP 4 — Review pipeline IN PARALLEL (single message, multiple Agent calls), scoped to THIS ticket's diff only
- pr-review-toolkit:code-reviewer
- pr-review-toolkit:silent-failure-hunter
- Also invoke the /security-review skill mentally / via a third reviewer agent focused on whether the FIX fully closes the vulnerability and introduces no new one (these are security tickets — the fix itself must be adversarially checked).
- For DB/RLS tickets, the reviewer must reason about RLS bypass and service-role assumptions.
- Each agent prompt: list exact in-scope files, give the CLAUDE.md path, ask for findings with file:line + severity (P0/P1/P2), tell them not to edit.

STEP 5 — Address findings
- Fix every P0 and P1. Fix cheap P2s (<30 min); otherwise file a follow-up SCRUM ticket referencing this PR (jira_create_issue).
- Re-run tsc/lint/tests after fixes.
- IMPORTANT for security tickets: if a reviewer shows the fix is incomplete (vuln still reachable), do NOT merge — iterate until the exploit path is closed, or STOP and report if it needs architectural change beyond the ticket.

STEP 6 — Apply DB migration (if any), then deploy voice-server (if any) — ORDER MATTERS
- Migration FIRST: read the migration file, apply via mcp__supabase-phondo__apply_migration (NOT execute_sql for DDL), verify with list_migrations, then run mcp__supabase-phondo__get_advisors (security + performance) — new findings must be addressed or ticketed before merging.
- voice-server deploy: after the migration (if any) and after the PR is ready — `cd voice-server && fly deploy` (auth already present). Verify `curl -fsSL https://phondo-voice.fly.dev/health` returns ok.
- For Next.js-only tickets, Vercel deploys on merge — nothing to do here.

STEP 7 — CAUTION tickets (343, 344, and the live-call parts of 341)
- These change live inbound-call authentication or the internal API contract. Implement BACKWARD-COMPATIBLY (accept the old path AND the new during rollout) so in-flight/real calls don't break.
- If you cannot guarantee backward compatibility, STOP: push the branch, open a draft PR describing the risk, transition the ticket to add a "blocked" label, post a comment asking the user to review before deploy/merge, and END the iteration (move to the next ticket on the NEXT wakeup only if the user hasn't intervened — otherwise wait).

STEP 8 — Open PR
- Commit: `fix(SCRUM-<id>): <short>` (or feat/chore as fitting), body explains the vuln + fix + that reviews ran. End body with: Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
- Stage ONLY this ticket's files (git status --short must show nothing else staged).
- Push -u; gh pr create with: summary, the exploit it closes, review findings addressed, test plan (incl. the security acceptance checks from the ticket), and a note of any migration applied / voice deploy done.

STEP 9 — CI + merge
- gh pr checks <PR#> --watch (foreground). On failure, gh run view <id> --log-failed, fix, push, re-watch.
- When green AND gh pr view <PR#> --json mergeable,mergeStateStatus shows MERGEABLE/CLEAN: gh pr merge <PR#> --squash --delete-branch, then git checkout main && git pull --ff-only.

STEP 10 — Close out
- jira_transition_issue to Done (id 51), then jira_add_comment with the merged PR URL.
- End the iteration with a one-line status. The loop fires again for the next ticket. When the list is exhausted, post the final summary and STOP.

GUARDRAILS
- Never push to main directly, never --no-verify, never --force-push.
- Migrations are applied to PRODUCTION and are one-way — if one is wrong AFTER applying, write a forward-fix migration; never try to roll back.
- For the two CAUTION tickets, prefer safety over completion: a paused ticket awaiting user review is correct; a broken live-call path is not.
- The user authorized git, gh, supabase MCP, and fly per CLAUDE.md — no need to ask permission inside the loop. But the CAUTION-ticket STOP rule overrides this.
- SCRUM-350 is manual — never attempt it; mention it in the final summary as the user's to-do.
```

## Notes / sequencing rationale

- **338 first** — highest blast radius (cloud-metadata exfil), and it establishes `isUrlAllowedAsync` usage that 344's reviewers may reference.
- **341 + 343 + 344** are the delicate ones (live call auth / internal contract). They carry explicit backward-compat + STOP rules. If the loop pauses on any of these for review, that's expected and good.
- **345, 348** are migration-only → tiny PRs (the migration file) + apply + advisors.
- **349** adds a table + webhook dedup → migration + code.
- **350** stays manual: Supabase dashboard → Auth → enable leaked-password protection.
