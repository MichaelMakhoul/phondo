# Loop prompt: Onboarding + Email follow-ups

Created 2026-05-20 after Phase 1 onboarding UX (PR #212) shipped and the SCRUM-282 confirmation-text fix landed. Implements four tickets discovered during manual testing:

| Ticket | Title | Priority | Effort |
|---|---|---|---|
| [SCRUM-281](https://michaelo.atlassian.net/browse/SCRUM-281) | Notify business owner when AI calls end as "unsuccessful" | P2 | ~3-4h |
| [SCRUM-286](https://michaelo.atlassian.net/browse/SCRUM-286) | Caller-side appointment confirmation email (OFF by default) | P2 | ~4-5h |
| [SCRUM-284](https://michaelo.atlassian.net/browse/SCRUM-284) | Onboarding Phase 2: dedicated Forwarding step in the wizard | P2 | ~4-6h |
| [SCRUM-285](https://michaelo.atlassian.net/browse/SCRUM-285) | Onboarding Phase 3: dashboard setup checklist for new orgs | P3 | ~6-8h |

## How to use

In a fresh Claude Code session, paste:

```
/loop
```

Then paste the prompt below as the argument. The interval is omitted intentionally — Claude self-paces, doing one ticket per iteration and scheduling the next wakeup itself.

## Order rationale

1. **SCRUM-281 first** — smallest, no dependencies, fills an obvious owner-side notification gap.
2. **SCRUM-286 next** — pairs with re-enabling the prompt language guarded by SCRUM-282; uses the same notification-service plumbing as #1.
3. **SCRUM-284 next** — onboarding wizard step uses existing transfer_rules + fallback_forward_number APIs (no new infra).
4. **SCRUM-285 last** — biggest scope (dashboard component + state derivation across many tables).

## The prompt

```
Work through the following Jira tickets in this priority order, one per loop iteration:

1. SCRUM-281 — Notify business owner when AI calls end as "unsuccessful" (P2, ~3-4h)
2. SCRUM-286 — Caller-side appointment confirmation email (OFF by default) (P2, ~4-5h)
3. SCRUM-284 — Onboarding Phase 2: dedicated Forwarding step in the wizard (P2, ~4-6h)
4. SCRUM-285 — Onboarding Phase 3: dashboard setup checklist for new orgs (P3, ~6-8h)

EACH ITERATION = ONE TICKET, START TO MERGE. Do not start the next ticket in the same iteration.

STEP 1 — Pick the next ticket
- Fetch each ticket above from Jira (mcp__mcp-atlassian__jira_get_issue, in parallel).
- The next ticket is the first one in the list above whose status is NOT "Done".
- If all four are "Done", post a final summary listing every merged PR URL and exit. Do not schedule another wakeup.

STEP 2 — Prep the workspace
- `git checkout main && git pull --ff-only`. Abort if either fails — never force-overwrite local changes.
- Create branch using CLAUDE.md naming: `feature/SCRUM-<ID>-<short-kebab-slug>` for stories/features, `fix/SCRUM-<ID>-<slug>` for bugs.
- IMPORTANT: this branch is shared with other potential sessions. If another session is mid-work, use a git worktree (`git worktree add /tmp/phondo-<id> <branch>`) so branch switches don't tug your working tree.
- Transition the Jira ticket to "In Progress" via mcp__mcp-atlassian__jira_transition_issue.

STEP 3 — Implement per the ticket's acceptance criteria
- Touch only the files described in the ticket. Do not refactor adjacent code.
- For SCRUM-286 specifically: also re-enable the conditional confirmation-text wording in voice-server prompts that SCRUM-282 removed. The flag passed into the prompt builder gates the language. Update the SCRUM-282 regression test (voice-server/tests/prompt-no-confirmation-promise.test.js) to allow the wording when the flag is true.
- For SCRUM-285 specifically: derive completion state from existing tables (phone_numbers, transfer_rules, calls, organizations, notification_preferences) — do not add new tracking tables unless absolutely needed.
- If new behaviour, add tests. Never delete or weaken existing tests.
- For DB changes: write a new migration file (next number after the most recent one), DO NOT apply it yet.
- Run after each meaningful edit: `npx tsc --noEmit`, `npm run lint`, `npx vitest run`. For voice-server changes, also relevant tests in voice-server/tests/.
- Fix all failures before moving on.

STEP 4 — Run review pipeline IN PARALLEL (single message, multiple Agent tool calls)
- `pr-review-toolkit:code-reviewer` on the diff for this ticket only.
- `pr-review-toolkit:silent-failure-hunter` on the diff for this ticket only.
- Invoke the `/security-review` skill on the pending changes (CLAUDE.md Phase 3 step #9).
- If TypeScript types/interfaces changed: also `pr-review-toolkit:type-design-analyzer`.
- For UI changes: read the diff manually for accessibility/loading/empty/error states (CLAUDE.md Phase 2 UX checklist).
- Each agent prompt must list the exact files in scope, include the full path to CLAUDE.md, and ask for findings with file:line references and severity. Tell them not to fix anything.

STEP 5 — Address findings
- Fix every P0 and every P1.
- For P2s: fix if cheap (<30 min). Otherwise create a follow-up Jira ticket via mcp__mcp-atlassian__jira_create_issue referencing the current PR.
- For findings flagged as out-of-scope or pre-existing, create a Jira ticket per CLAUDE.md Phase 4.5.
- After fixes: re-run lint, typecheck, tests.

STEP 6 — Apply migration (if applicable) and deploy voice-server (if applicable)
- ORDER IS CRITICAL: migration first → voice-server deploy → then merge the Next.js PR.
- Migration: read the file, apply via mcp__supabase-phondo__apply_migration (NOT execute_sql for DDL). Verify with mcp__supabase-phondo__list_migrations.
- After migration applied: run mcp__supabase-phondo__get_advisors for both security and performance. New findings must be addressed or ticketed before merging.
- Voice-server deploy (only if voice-server files changed): cd voice-server && fly deploy. Verify with curl https://phondo-voice.fly.dev/health.

STEP 7 — Open PR
- Commit message format: `feat(SCRUM-<ID>): <short>` or `fix(SCRUM-<ID>): <short>`, with full body explaining the why. End with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- Stage only files relevant to this ticket. `git status --short` should show no other staged changes.
- Push with `-u origin <branch>`.
- `gh pr create --base main` with title and body including:
  - Summary (1-3 bullets)
  - Review findings addressed (briefly list, link to any follow-up tickets)
  - Test plan (markdown checklist, including manual smoke checks)
  - Note any migration applied or voice-server deploy already done
- Return the PR URL.

STEP 8 — Wait for CI and merge
- Use `gh pr checks <PR#> --watch` (foreground or `run_in_background: true`) to wait for results — do NOT poll in a sleep loop.
- If any check fails, investigate logs (`gh run view <run-id> --log-failed`), fix, push again, restart watch.
- Once all checks pass and `gh pr view <PR#> --json mergeable,mergeStateStatus` shows MERGEABLE/CLEAN:
  - `gh pr merge <PR#> --squash --delete-branch`
  - `git checkout main && git pull --ff-only`
- Clean up the worktree if used: `git worktree remove <path>`.

STEP 9 — Mark Jira Done
- Transition the ticket to "Done" via mcp__mcp-atlassian__jira_transition_issue.
- Add a brief comment via mcp__mcp-atlassian__jira_add_comment with the merged PR URL.

STEP 10 — Schedule next iteration
- If more tickets remain in the list above (status != "Done"), end this iteration with a one-line status. The /loop runtime will fire this prompt again to pick up the next ticket.
- If all four are now Done, post a final summary message to the user with every merged PR URL and exit. Do not schedule another wakeup.

GUARDRAILS
- If any review agent flags a P0 you cannot resolve, STOP. Add a PR comment describing the blocker, mark the Jira ticket "Blocked" (or add a "blocked" label), and exit this iteration.
- If a migration apply fails halfway, STOP. Do not try to manually clean up — report state and ask the user.
- Never push to main directly. Never use `--no-verify`. Never `--force-push` without `--force-with-lease`.
- Migrations are applied to production. Treat them as one-way operations. If you realise a migration is wrong AFTER applying, write a follow-up migration that fixes forward, do not try to roll back.
- Keep test coverage. Every new public function or behaviour gets a vitest case. Never weaken or delete existing tests to make CI pass.
- For SCRUM-286 caller email: the feature MUST be OFF by default at the org level. The migration column default MUST be false. The dashboard toggle MUST start unchecked. This is a deliberate user requirement — some businesses run their own confirmation systems and would be hurt by duplicate emails.
- The user has authorized git, gh, supabase MCP, and fly CLI operations per CLAUDE.md. You do not need to ask for permission inside this loop.
```

## Coordination with parallel session

If another Claude Code session is doing non-code work in parallel (prospecting, configuration, email, ABN admin), this loop is safe because:

- Each ticket gets its own feature branch — no contention on main
- The loop never modifies docs, prospect lists, or marketing files outside the ticket scope
- All state is in git + Jira + Supabase, which both sessions can read

**Rule for the non-loop session:** do not touch code files in `src/`, `voice-server/`, or `supabase/migrations/` while the loop is active. Stick to `docs/`, `.env*`, prospect lists, and reading-only operations.

## Skipped intentionally

- **Phase 3 dashboard checklist auto-dismiss / per-user state.** Item 7 of SCRUM-285 (notification-prefs "confirmed" flag) is the only place where a new "explicitly confirmed" flag is needed. The rest derives from existing data.
- **Re-enabling the AI confirmation language as part of SCRUM-282.** That ticket only removes the promise. Re-enabling lives in SCRUM-286 (caller email) and a future SCRUM-264 follow-up (SMS once ABN clears).
