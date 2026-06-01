# Loop prompt: Kill-switch follow-up tickets

Created 2026-05-19. Implements the 5 follow-up Jira tickets created after PR #198 (kill-switch fallback forwarding) was merged.

## How to use

In a fresh Claude Code session, paste:

```
/loop
```

Then paste the prompt below as the argument. The interval is omitted intentionally — Claude self-paces, doing one ticket per iteration and scheduling the next wakeup itself.

## What it does

Implements 5 tickets in priority order (P1s first, then a 1-hour quick win, then larger pieces). Each iteration = one complete ticket: branch → code → reviews → fixes → PR → CI → merge → Jira Done. Auto-exits when all 5 are merged.

## Tickets in order

1. [SCRUM-269](https://michaelo.atlassian.net/browse/SCRUM-269) — Wire Sentry/structured logging for kill-switch and fail-open events (P1, ~3h)
2. [SCRUM-267](https://michaelo.atlassian.net/browse/SCRUM-267) — Recording-consent disclosure on fallback Dial (P1, ~2h)
3. [SCRUM-271](https://michaelo.atlassian.net/browse/SCRUM-271) — getPhoneNumberContext returns null for empty-assistant numbers (P3, ~1h)
4. [SCRUM-268](https://michaelo.atlassian.net/browse/SCRUM-268) — "Send test call" button in fallback dialog (P2, ~3-4h)
5. [SCRUM-270](https://michaelo.atlassian.net/browse/SCRUM-270) — Schema-wide auth_rls_initplan performance cleanup (P2, ~4-6h)

## The prompt

```
Work through the following Jira tickets in this priority order, one per loop iteration:

1. SCRUM-269 — Wire Sentry/structured logging for kill-switch and fail-open events (P1, ~3h)
2. SCRUM-267 — Recording-consent disclosure on fallback Dial (P1, ~2h)
3. SCRUM-271 — getPhoneNumberContext returns null for empty-assistant numbers (P3, ~1h)
4. SCRUM-268 — "Send test call" button in fallback dialog (P2, ~3-4h)
5. SCRUM-270 — Schema-wide auth_rls_initplan performance cleanup (P2, ~4-6h)

EACH ITERATION = ONE TICKET, START TO MERGE. Do not start the next ticket in the same iteration.

STEP 1 — Pick the next ticket
- Fetch each ticket above from Jira (mcp__mcp-atlassian__jira_get_issue, in parallel).
- The next ticket is the first one in the list above whose status is NOT "Done".
- If all five are "Done", post a final summary listing every merged PR URL and exit. Do not schedule another wakeup.

STEP 2 — Prep the workspace
- `git checkout main && git pull --ff-only`. Abort if either fails — never force-overwrite local changes.
- Create branch: `feature/SCRUM-<ID>-<short-kebab-slug>` (or `fix/...` for bugs).
- Transition the Jira ticket to "In Progress" (mcp__mcp-atlassian__jira_transition_issue).

STEP 3 — Implement per the ticket's acceptance criteria
- Touch only the files described in the ticket. Do not refactor adjacent code.
- If new behaviour, add tests. Never delete or weaken existing tests.
- For DB changes: write a new migration file (next number after 00132), but DO NOT apply it yet.
- For voice-server changes: do not deploy yet.
- Run after each meaningful edit: `npx tsc --noEmit`, `npm run lint`, `npx vitest run`. For voice-server changes, also `node --test voice-server/tests/<relevant>.test.js`.
- Fix all failures before moving on.

STEP 4 — Run review pipeline IN PARALLEL (single message, multiple Agent tool calls)
- `pr-review-toolkit:code-reviewer` on the diff for this ticket only.
- `pr-review-toolkit:silent-failure-hunter` on the diff for this ticket only.
- If TypeScript types/interfaces changed: also `pr-review-toolkit:type-design-analyzer`.
- For UI changes: read the diff manually for accessibility/loading/empty/error states (CLAUDE.md Phase 2 UX checklist). No separate agent for this.
- Each agent prompt must:
  - List the exact files in scope (avoid pre-existing unrelated changes elsewhere).
  - Include the full path to CLAUDE.md for project conventions.
  - Ask for findings with file:line references and severity (P0/P1/P2). Tell them not to fix anything.

STEP 5 — Address findings
- Fix every P0 and every P1.
- For P2s: fix if cheap (<30 min). Otherwise create a follow-up Jira ticket (mcp__mcp-atlassian__jira_create_issue) referencing the current PR.
- For findings flagged as out-of-scope or pre-existing, create a Jira ticket per CLAUDE.md Phase 4.5.
- After fixes: re-run lint, typecheck, tests.

STEP 6 — Apply migration (if applicable) and deploy voice-server (if applicable)
- ORDER IS CRITICAL: migration first → voice-server deploy → then merge the Next.js PR.
- Migration: read the file, apply via mcp__supabase-phondo__apply_migration (NOT execute_sql for DDL). Verify with mcp__supabase-phondo__list_migrations.
- After migration applied: run mcp__supabase-phondo__get_advisors for both security and performance. New findings must be addressed or ticketed before merging.
- Voice-server deploy: from project root, run `fly deploy -c voice-server/fly.toml` OR cd voice-server && fly deploy. Verify with `curl -fsSL https://phondo-voice.fly.dev/health`.

STEP 7 — Open PR
- Commit message format: `feat(SCRUM-<ID>): <short>` or `fix(SCRUM-<ID>): <short>`, with full body explaining the why. End with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- Stage only files relevant to this ticket. `git status --short` should show no other staged changes.
- Push with `-u origin <branch>`.
- `gh pr create --title "<type>(SCRUM-<ID>): <description>" --body "<body>"` where body includes:
  - Summary (1-3 bullets)
  - Review findings addressed (briefly list, link to any follow-up tickets)
  - Test plan (markdown checklist, including manual smoke checks)
  - Note any migration applied or voice-server deploy already done
- Return the PR URL.

STEP 8 — Wait for CI and merge
- Use `gh pr checks <PR#> --watch` (foreground) to wait for results — do NOT poll in a sleep loop.
- If any check fails, investigate logs (`gh run view <run-id> --log-failed`), fix, push again, restart watch.
- Once all checks pass and `gh pr view <PR#> --json mergeable,mergeStateStatus` shows MERGEABLE/CLEAN:
  - `gh pr merge <PR#> --squash --delete-branch`
  - `git checkout main && git pull --ff-only`

STEP 9 — Mark Jira Done
- Transition the ticket to "Done" via mcp__mcp-atlassian__jira_transition_issue.
- Add a brief comment via mcp__mcp-atlassian__jira_add_comment with the merged PR URL.

STEP 10 — Schedule next iteration
- If more tickets remain in the list above (status != "Done"), end this iteration with a one-line status. The /loop runtime will fire this prompt again to pick up the next ticket.
- If all five are now Done, post a final summary message to the user with every merged PR URL and exit. Do not schedule another wakeup.

GUARDRAILS
- If any review agent flags a P0 you cannot resolve, STOP. Add a PR comment describing the blocker, mark the Jira ticket "Blocked" (or add a "blocked" label), and exit this iteration.
- If a migration apply fails halfway, STOP. Do not try to manually clean up — report state and ask the user.
- Never push to main directly. Never use `--no-verify`. Never `--force-push`.
- Migrations are applied to production. Treat them as one-way operations. If you realise a migration is wrong AFTER applying, write a follow-up migration that fixes forward, do not try to roll back.
- Keep test coverage. Every new public function or behaviour gets a vitest case. Never weaken or delete existing tests to make CI pass.
- The user has authorized git, gh, supabase MCP, and fly CLI operations per CLAUDE.md. You do not need to ask for permission inside this loop.
```

## Coordination with parallel session

If another Claude Code session is doing non-code work in parallel (prospecting, configuration, email, ABN admin), this loop is safe because:

- Each ticket gets its own feature branch — no contention on main
- The loop never modifies docs, prospect lists, or marketing files outside the ticket scope
- All state is in git + Jira + Supabase, which both sessions can read

**Rule for the non-loop session:** do not touch code files in `src/`, `voice-server/`, or `supabase/migrations/` while the loop is active. Stick to `docs/`, `.env*`, prospect lists, and reading-only operations.
