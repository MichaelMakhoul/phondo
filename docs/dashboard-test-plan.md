# Dashboard Integration Test Plan

These are the tests that complement `docs/test-scenarios.md` for behaviors that
**cannot be exercised through the outbound voice runner alone**. They cover:

1. **Cache invalidation triggered by dashboard mutations** (SCRUM-245)
2. **Confirmation row writes from the SMS pipeline** (SCRUM-240 Phase 1)
3. **Twilio status-callback webhook** (SCRUM-240 Phase 1 + SCRUM-251)
4. **Failure modes** that need DB poking or network manipulation

The voice runner can verify what Sophie *says* and what gets *booked*. It can't
easily verify that a row landed in `appointment_confirmations`, that the cache
was actually invalidated, or that a webhook payload was rejected — those need
either a SQL query or a controlled HTTP call.

> **Setup:** All tests below assume a logged-in dashboard user, a phone number
> connected, and a test org with at least one practitioner / service type / free
> slot tomorrow. Run each test against a **dedicated test org**, not production.

---

## Section A — Schedule cache invalidation (SCRUM-245)

The voice-server caches schedules in memory for 3 minutes per org. Dashboard
mutations to `appointments` and `blocked_times` must POST to
`/cache/invalidate` on the voice-server so the next call sees fresh data.

### A.1 — POST /api/v1/appointments invalidates voice cache

**Setup:**
- Watch voice-server logs: `fly logs -a phondo-voice-server`

**Steps:**
1. cURL POST `/api/v1/appointments` from dashboard with valid auth + body:
   ```bash
   curl -X POST https://<host>/api/v1/appointments \
     -H "Cookie: <session>" -H "Content-Type: application/json" \
     -d '{"first_name":"Test","last_name":"Cache","phone":"+15555550100",
          "start_time":"2026-04-16T15:00:00Z","duration_minutes":30}'
   ```

**Expected:**
- [ ] Response is `201` within ~500ms (NOT a hang waiting for cache)
- [ ] Voice-server log shows `[scheduleCache] invalidated for org=<id>` within 1s
- [ ] If voice-server is DOWN: dashboard still returns `201`, log shows
      `[appointments POST] cache invalidation failed (non-fatal): ...`
- [ ] DB has the new appointment row

### A.2 — PATCH /api/v1/appointments/[id] invalidates voice cache

Same setup, with PATCH to an existing appointment ID. Same expectations.

### A.3 — DELETE /api/v1/appointments/[id] invalidates voice cache

Same. The DELETE soft-deletes (status='cancelled'), so re-querying the appointment
should show `status='cancelled'` AND the voice cache should be invalidated.

### A.4 — Cache invalidation is fire-and-forget, doesn't block on slow voice-server

**Setup:** Add an `iptables` block (or `pf` rule on macOS) that drops outbound
to the voice-server URL, so the HTTP call hangs.

**Steps:**
1. Time a POST to `/api/v1/appointments`.

**Expected:**
- [ ] Total response time is well under the dashboard's HTTP timeout (no 30s hang)
- [ ] Server log shows `cache invalidation failed (non-fatal)` after the timeout
- [ ] The appointment was still created
- [ ] No 5xx, no error toast on the dashboard

### A.5 — Existing blocked-times invalidation still works (regression for SCRUM-245)

The blocked-times API was the only mutation path that already had cache invalidation.
Verify the fire-and-forget refactor didn't break it.

**Steps:**
1. POST a blocked time via `/api/v1/blocked-times`.
2. Watch voice-server log for invalidation.
3. DELETE that blocked time.
4. Watch voice-server log for invalidation.

**Expected:**
- [ ] Both POST and DELETE log `cache invalidated`
- [ ] Both responses return promptly

### A.6 — Vitest unit test (recommended)

Write `src/app/api/v1/appointments/__tests__/cache-invalidate.test.ts` that:
- Mocks `invalidateVoiceScheduleCache`
- Asserts it's called with the right `orgId` after POST/PATCH/DELETE
- Asserts the API still returns the success response when the mock throws
  (proves fire-and-forget pattern, not awaited)

---

## Section B — appointment_confirmations write path (SCRUM-240 Phase 1)

These tests exercise the row that gets written when `book_appointment` succeeds
and Twilio is told to send the confirmation SMS. The voice runner exercises the
happy path; these cover the branches.

### B.1 — Successful send writes status='sent' + provider_message_id

**Setup:** A booking happens via outbound voice runner (or via the local
helper script `scripts/test-confirmation-send.ts` if it exists).

**Verify:**
- [ ] `SELECT * FROM appointment_confirmations WHERE appointment_id = '<id>'`
- [ ] Row exists with `status='sent'`, non-null `provider_message_id`,
      `sent_at` populated, `last_attempt_at` populated
- [ ] `idempotency_key` ends with `:confirmation:<startTime>`

### B.2 — Org-disabled toggle skips and writes status='skipped_disabled'

**Setup:**
```sql
UPDATE organizations SET send_customer_confirmations = false WHERE id = '<test-org>';
```

**Steps:**
1. Trigger a booking (voice or via the manual POST to `/api/v1/calendar/book-appointment`).

**Expected:**
- [ ] Booking succeeds, returns confirmation_code as normal
- [ ] Row in `appointment_confirmations` with `status='skipped_disabled'`,
      NULL `provider_message_id`
- [ ] Twilio console shows NO message sent for this caller
- [ ] Reset the toggle back to true after the test

### B.3 — Per-user toggle off (notification_preferences.sms_appointment_confirmation = false)

**Setup:**
```sql
UPDATE notification_preferences SET sms_appointment_confirmation = false
 WHERE organization_id = '<test-org>';
```

**Steps:** Trigger a booking.

**Expected:**
- [ ] Booking still succeeds
- [ ] Row in `appointment_confirmations` with `status='skipped_disabled'`
- [ ] No SMS sent

### B.4 — Caller opted out (caller_sms_optouts row exists)

**Setup:**
```sql
INSERT INTO caller_sms_optouts (phone_number, organization_id, source)
VALUES ('+15555550100', '<test-org>', 'twilio_stop');
```

**Steps:** Trigger a booking that uses that caller phone.

**Expected:**
- [ ] Booking still succeeds
- [ ] `caller_sms_log` row with `status='blocked_optout'`
- [ ] `appointment_confirmations` row with `status='opted_out'`
- [ ] No SMS sent

### B.5 — Rate-limited (existing 'sent' row in last hour)

**Setup:** Trigger one booking + confirmation. Then within 1 hour, trigger
another booking confirmation for the SAME caller.

**Expected:**
- [ ] Second confirmation gets `caller_sms_log.status='blocked_ratelimit'`
- [ ] Second `appointment_confirmations` row with `status='skipped_cap'`
- [ ] No second SMS sent

### B.6 — Cancellation has its own rate-limit bucket (regression for SCRUM-247)

**Setup:** Same as B.5 but the second message is a CANCELLATION not a confirmation.

**Steps:**
1. Book confirmation for caller X → SMS sent.
2. Within 1 hour, cancel that appointment for caller X.

**Expected:**
- [ ] Cancellation SMS IS sent (NOT rate-limited)
- [ ] `caller_sms_log` has TWO rows: confirmation + cancellation, both `status='sent'`
- [ ] `appointment_confirmations` has TWO rows with different `idempotency_key`
      (one ending `:confirmation:`, one ending `:cancellation:`)

### B.7 — Confirmation upsert doesn't clobber provider_message_id (SCRUM-249)

**Setup:** After B.6, query the confirmation row and the cancellation row.

**Expected:**
- [ ] Confirmation row's `provider_message_id` is unchanged (matches what was set when SMS was sent)
- [ ] Cancellation row has its OWN distinct `provider_message_id`
- [ ] Neither row has been overwritten by the other

### B.8 — checkOrgConfirmationEnabled fail-closed on DB error (SCRUM-250)

**Setup:** Hard to simulate without breaking Postgres. Best approach:
revoke `service_role` SELECT on `organizations` for the duration of a test
(`REVOKE SELECT ON organizations FROM service_role;`).

**Steps:** Trigger a booking.

**Expected:**
- [ ] `appointment_confirmations` row written with `status='skipped_disabled'`
      (because the read failed and we fail closed)
- [ ] Sentry alert with tag `reason=org_toggle_read_failed`
- [ ] No SMS sent
- [ ] **CRITICAL:** restore the GRANT after the test

> **Easier alternative:** add a unit test that mocks `checkOrgConfirmationEnabled`
> dependencies, returns an error with `code='42P01'` (not 42703), and asserts
> the function returns `false`.

### B.9 — Pre-migration schema fails open (SCRUM-250)

If a fresh deploy hits a stale DB, the `send_customer_confirmations` column
might not exist. The function should fail open in this case.

**Steps:**
1. In a sandbox: `ALTER TABLE organizations DROP COLUMN send_customer_confirmations;`
2. Trigger a booking.

**Expected:**
- [ ] Booking goes through normal path (column-missing path → `return true`)
- [ ] Console warns `column missing — defaulting to enabled (pre-migration)`
- [ ] SMS sent normally
- [ ] Restore the column after.

> **Easier alternative:** unit test mocking the supabase response with `error.code='42703'`.

---

## Section C — Twilio status webhook (SCRUM-240 Phase 1, SCRUM-251)

The webhook is at `POST /api/webhooks/twilio-sms-status`. It must validate the
Twilio signature, look up the row by `MessageSid`, advance the lifecycle, and
NEVER return 4xx (because Twilio retries aggressively on errors).

### C.1 — Valid delivered callback advances row

```bash
# Compute a valid signature using TWILIO_AUTH_TOKEN, then:
curl -X POST https://<host>/api/webhooks/twilio-sms-status \
  -H "x-twilio-signature: <computed>" \
  -d "MessageSid=SM<test>&MessageStatus=delivered"
```

**Expected:**
- [ ] `200 OK` with body `<Response></Response>`
- [ ] Row advances from `sent` → `delivered`, `delivered_at` set

### C.2 — Bad signature returns 200 (SCRUM-251)

```bash
curl -X POST https://<host>/api/webhooks/twilio-sms-status \
  -H "x-twilio-signature: completely-wrong" \
  -d "MessageSid=SM<test>&MessageStatus=delivered"
```

**Expected:**
- [ ] `200 OK` (NOT 403)
- [ ] Body `<Response></Response>`
- [ ] Sentry warning captured with `reason=invalid_signature`
- [ ] DB row UNCHANGED

### C.3 — Idempotency: re-firing same status (SCRUM-251)

Fire C.1 twice in a row.

**Expected:**
- [ ] Second call short-circuits (returns 200, no UPDATE issued)
- [ ] Row's `delivered_at` is unchanged (NOT updated to second timestamp)

### C.4 — Lifecycle regression guard (SCRUM-251)

Row at status=delivered. Fire a callback with `MessageStatus=sent`.

**Expected:**
- [ ] `200 OK`
- [ ] Row REMAINS `delivered`
- [ ] Server log: `Skipping regression for <SID>: delivered → sent`

### C.5 — Unknown SID returns 200, no DB write

```bash
# Fire a callback with a SID that doesn't match any row.
```

**Expected:**
- [ ] `200 OK`
- [ ] Console log: `No matching confirmation row for <SID>`
- [ ] No Sentry alert (this is normal for textback SMS)

### C.6 — Undelivered status sets last_error + Sentry alert

```bash
curl ... MessageStatus=undelivered ErrorMessage=invalid_phone ErrorCode=21610
```

**Expected:**
- [ ] Row updates to `status='undelivered'`, `last_error='undelivered: invalid_phone (code 21610)'`
- [ ] Sentry warning captured with `delivery_status=undelivered`

### C.7 — Transient state (queued/sending) is no-op

Fire a callback with `MessageStatus=queued`.

**Expected:**
- [ ] `200 OK`
- [ ] Row UNCHANGED (queued isn't a terminal state we track)

### C.8 — Vitest unit tests (recommended)

Write `src/app/api/webhooks/twilio-sms-status/__tests__/route.test.ts` covering
all 7 cases above with mocked Twilio signature validation and supabase admin client.

---

## Section D — Migration / schema invariants

### D.1 — `appointment_cancellation` is in the CHECK constraint (SCRUM-247)

```sql
SELECT pg_get_constraintdef(oid)
 FROM pg_constraint
 WHERE conname = 'caller_sms_log_message_type_check';
```

**Expected:**
- [ ] Output includes `'appointment_cancellation'`

### D.2 — `appointment_confirmations.idempotency_key` UNIQUE constraint

```sql
SELECT pg_get_indexdef(indexrelid)
 FROM pg_index
 WHERE indrelid = 'appointment_confirmations'::regclass
   AND indisunique = true;
```

**Expected:**
- [ ] One unique index on `idempotency_key`

### D.3 — RLS: org members can SELECT, only service_role can INSERT/UPDATE

```sql
SELECT polname, polcmd FROM pg_policy
 WHERE polrelid = 'appointment_confirmations'::regclass;
```

**Expected:**
- [ ] One SELECT policy for org members
- [ ] No INSERT/UPDATE/DELETE policies (service_role bypasses RLS)

---

## Recommended automation

The dashboard-side tests benefit from being scripted as Vitest integration tests
that hit a local Supabase + a mocked voice-server endpoint. The shape would be:

```ts
// src/app/api/v1/appointments/__tests__/cache-invalidate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";

vi.mock("@/lib/voice-cache/invalidate", () => ({
  invalidateVoiceScheduleCache: vi.fn().mockResolvedValue(undefined),
}));

describe("POST /api/v1/appointments cache invalidation", () => {
  it("calls invalidateVoiceScheduleCache after successful insert", async () => {
    // ... arrange supabase mock to return success
    // ... call POST(request)
    // ... expect invalidateVoiceScheduleCache to have been called once
  });

  it("returns 201 even when invalidation throws (fire-and-forget)", async () => {
    invalidateVoiceScheduleCache.mockRejectedValueOnce(new Error("voice-server down"));
    // ... call POST
    // ... expect status === 201
  });
});
```

Tracked as: SCRUM-252 (write Vitest integration tests for dashboard test plan).
