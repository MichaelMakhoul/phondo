# Owner assistant on the website: design

2026-10-26 · proposed, waiting for the owner's OK · SCRUM-596 · builds on SCRUM-585/586/587 (the phone owner assistant, live but switched off)

**The owner's choices:** only the org's **owner** can use it, and it works by **voice** in the browser.

## What the owner gets

- A **Talk to your assistant** button in the dashboard. Only the org's owner sees it, and only while `OWNER_ASSISTANT_UI_ENABLED` is on.
- Clicking it asks for the microphone, then opens the same assistant as the phone line: "Hi Michael, what can I do for you?"
  - It reads out today's or this week's jobs and the latest messages and missed calls.
  - It moves or cancels a single job, with the same read-back and "yes" before any change.
- Being logged in replaces the PIN. The web needs no registered mobile and no PIN.
- Each session appears in the call log as an owner call, marked as from the web, with the list of changes it made, the same as an owner phone call. It counts as minutes the same way.

## How it works

1. **Next.js** gets a new route, `POST /api/v1/owner-assistant/token`.
   - It accepts only a logged-in user whose `org_members.role` is `owner`, using the same check as `/api/v1/owner-access`. Admins and members get a 403. It also needs `OWNER_ASSISTANT_UI_ENABLED` on.
   - It returns a token and `wsUrl`. The token is HMAC-signed with `TEST_CALL_SECRET`, the same signing as test calls. It carries `{ mode: "owner", organizationId, assistantId, userId, nonce, exp }`, lasts 2 minutes, and can be used once.
   - It is rate-limited per user with the existing `check_rate_limit_bucket`.
2. **Voice server, `/ws/test`.** A verified token with `mode: "owner"` starts an owner session instead of a test call, if `OWNER_ASSISTANT_ENABLED` is on; otherwise it is refused with a clear message.
   - The nonce is remembered until the token expires, so a token works once.
   - A `calls` row is created up front, with `call_type: "owner"` and `channel: "web"`. Its id is the call id the owner tools already require: their authority (`ownerVerified` plus the call's own id) is unchanged.
   - It uses the owner prompt, greeting, tools and first name (`lib/owner-prompt`, `lib/owner-tools`, `lib/owner-context`), and the pipeline from `OWNER_PIPELINE`: Gemini by default, classic optionally.
   - Every tool call goes through `runOwnerToolCall`, with the phone's confirmation gate and turn stamps. Nothing is simulated: these are the real bookings.
   - At the end it uses the phone's owner post-call: `settleOwnerToolRuns`, `buildOwnerCallSummary`, then `completeCallRecord` with `callType: "owner"`, then `notifyCallCompleted`. There is no recording and no OpenAI analysis.
   - Limits: one web owner session per org at a time. The existing `/ws/test` concurrency caps and time limit also apply.
3. Everyone else's browser test calls are unchanged: simulated tools and no call record.

## Security

- **The token is the only proof.** Next.js issues it only after checking the login and the owner role. It is signed, expires in 2 minutes, works once, and names the org, so the session can only touch that org.
- **The browser can't switch on owner mode.** The voice server sets it only from a verified owner token.
- **The existing safeguards stay in force**, all unchanged: the owner tools' authority check, the refusal of external-calendar bookings, the read-back confirmation, and the cleaning of customer text against prompt injection.

## Not in this phase

Text chat, admins and members, the mobile layout beyond what the test-call page already does, and texting customers about changes (still off, as on the phone).

## Rollout

1. **Branch base.** First merge PR #444 into `develop`, since production's voice server already runs it. Then branch `feature/SCRUM-596-owner-assistant-web` off `develop`. A branch off today's `develop` would roll the demo line's fast pipeline back out of production.
2. **Gate.** The usual review gate (security, code, silent failures, tests) plus mutation testing on the token and authority checks.
3. **Deploy.**
   - Voice server: `deploy.sh`, run by the owner.
   - Website: a release PR from `develop` to `main`, merged by the owner, which deploys to Vercel.
4. **Switch on.** Set `OWNER_ASSISTANT_ENABLED=true` on Fly and `OWNER_ASSISTANT_UI_ENABLED=true` on Vercel. The Fly flag also enables the phone front door, but only for orgs with a registered mobile and PIN, and there are none today.
5. **Test.** Run the owner test plan's script (stages 4–5) in the browser. The Claude round waits for the November Anthropic top-up, because the classic path calls Anthropic directly; Gemini works now.

## Testing

- **The token route:** not logged in (401); an admin or member (403); the flag off; the claims it signs; the rate limit.
- **The voice server:** an owner token starts an owner session with a call record, the `ownerVerified` envelope and the owner tools. A forged, expired or reused token, or the flag off, is refused. A normal test token behaves as before. The post-call writes `call_type: "owner"`.
- **The dashboard:** the button shows only for the owner with the flag on, and it uses the voice-test hook with the owner token route.

About a day of work, including the review gate.
