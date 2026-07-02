# Cliniko Change Reconciliation (SCRUM-482) — Design Spec

**Status:** Approved 2026-07-02
**Follows:** SCRUM-12 (Cliniko integration, PR #361)

## Problem

The AI books, cancels, and reschedules live in a connected Cliniko diary, and keeps a local mirror `appointments` row per booking (`provider='cliniko'`, `external_id`). Availability is read live from Cliniko, but **everything else reads the mirror**: `lookup_appointment`, caller verification, SMS, the dashboard, and — critically — the local overlap **exclusion constraint** that reserves a slot.

When practice staff cancel or move an appointment **inside Cliniko**, Phondo never hears about it, so the mirror goes stale and two concrete failures follow:

1. **Stale lookup.** `lookup_appointment` reads the mirror and confirms an appointment the practice already cancelled.
2. **False "slot taken" loop.** The practice cancels/moves an appointment, freeing a slot. Availability (live) offers that slot, but `book_appointment` inserts a mirror row that collides with the *old, still-`confirmed*` mirror row under `no_overlapping_appointments` → Postgres `23P01` → the AI loops on "that slot was just taken."

This is the biggest correctness gap for live pilots (P1).

## Constraint that shapes the whole design: Cliniko has no webhooks

Cliniko exposes **no webhook / push mechanism**. The "Add Webhooks" request (redguava/cliniko-api#150) has been open since 2017; the repo is now archived. Every third-party "Cliniko webhook" product (Pipedream, Pabbly, Zapier) is really **polling** Cliniko's REST API under the hood.

So SCRUM-482 is implemented as **pull-based reconciliation**, not push. The ticket's intent (Cliniko-side edits stop breaking Phondo) is met; the mechanism is polling, which is the only mechanism available. This is called out explicitly so the "webhook" title is not read as a literal capability.

**Polling primitives (verified against the Cliniko API docs):**
- `GET /individual_appointments` is filterable by `updated_at` and `starts_at` (multiple `q[]` params AND together).
- Appointment records expose `starts_at`, `ends_at`, `cancelled_at`, `deleted_at`, `updated_at`, `patient`, `appointment_type`, `practitioner`.
- `GET /individual_appointments/deleted` lists hard-deleted appointments (soft cancels keep `cancelled_at` and still list normally).

## What "reconcile" means

For a given org, pull the Cliniko appointments that **changed since we last looked** and are **upcoming**, then drag each matching mirror row back in line:

| Cliniko state | Mirror action | Why |
|---|---|---|
| `cancelled_at` or `deleted_at` set | `status = 'cancelled'` | Removes the row from `no_overlapping_appointments` (constraint is `WHERE status IN ('confirmed','pending')`), freeing the slot and fixing lookup. |
| `starts_at` / `ends_at` changed | update `start_time` / `end_time` | Frees the old slot, reflects the new one in the constraint, and fixes lookup accuracy. |
| unchanged, or no mirror row for that `external_id` | skip | We only reconcile appointments Phondo booked. |

Verified: `no_overlapping_appointments` (migration 00149) and the per-practitioner constraint (00115/00116) both carry `WHERE status IN ('confirmed','pending')`, so flipping a mirror to `cancelled` frees the slot — identical to the existing cancel path, which is why this is low-risk.

## Architecture

### New module — `src/lib/calendar/cliniko-reconcile.ts`

```ts
export interface ReconcileResult {
  ran: boolean;        // false when the freshness gate skipped it
  cancelled: number;   // mirror rows voided
  moved: number;       // mirror rows retimed
  scanned: number;     // Cliniko appointments examined
}

export async function reconcileClinikoOrg(
  ctx: ClinikoContext,
  organizationId: string,
  opts?: { force?: boolean; nowMs?: number },
): Promise<ReconcileResult>;
```

Behavior:
1. **Freshness gate.** Read `settings.lastReconciledAt`. If `!force` and it was within `RECONCILE_FRESHNESS_MS` (60s), return `{ ran: false, … }`. This dedupes multiple scheduling tool-calls inside one voice call *and* concurrent calls, with no per-call state.
2. **Cursor.** `since = max(lastReconciledAt − SKEW_OVERLAP_MS (5 min), now − COLD_START_LOOKBACK)`. `COLD_START_LOOKBACK` = 62 days (covers Cliniko's ~7-day availability horizon plus a generous booking horizon) when there is no prior cursor. Idempotent reconciliation makes the overlap harmless.
3. **Poll.** `client.listChangedAppointments({ since, businessId: ctx.businessId })` (upcoming changed) and `client.listDeletedAppointments({ since })` (hard deletes). Both paginate.
4. **Reconcile.** Batch-load mirror rows for the returned `external_id`s in one query (`provider='cliniko'`, `organization_id`, `external_id IN (…)`, `status IN ('confirmed','pending')`); apply the table above. Updates are per-row and independently error-guarded.
5. **Advance cursor** to the poll-start time; write `settings.lastReconciledAt`. **Only on success**, and using read-before-write spread (never clobber `shard`/`businessId`/`errorState`) — the same guard the auth-failure path uses.

Idempotency: reconciling the same appointment twice is a no-op (cancel→cancel, retime→same time).

### Trigger 1 — at call time (primary)

The three Cliniko dispatch branches in `tool-handlers.ts` — `handleCheckAvailability`, `handleBookAppointment`, `handleCancelAppointment` (reschedule flows through book) — call `reconcileClinikoOrg(ctx, orgId)` **immediately after** resolving `{ kind: 'ok', ctx }` and **before** reading or writing mirror rows. The freshness gate makes all but the first scheduling tool per ~minute a cheap no-op. The first one blocks ~300–500 ms, covered by the voice server's existing filler words ("let me check…"). This is the owner-approved behavior: **block scheduling tools until reconciled** (correctness-first), fresh exactly when a caller is on the line.

### Trigger 2 — daily cron (backstop)

New route `src/app/api/cron/cliniko-reconcile-sync/route.ts`, structured like `cliniko-catalog-sync` (cron auth, `MAX_ORGS_PER_RUN` cap, LRU order, per-org isolation, auth-failure flagging). Runs daily (Vercel Hobby allows only daily crons) and calls `reconcileClinikoOrg(ctx, orgId, { force: true })` for every active integration, catching orgs with no recent calls. Registered in `vercel.json` at a distinct time (e.g. `30 19 * * *`, staggered after catalog sync).

### Client additions — `src/lib/calendar/cliniko.ts`

```ts
listChangedAppointments(params: { since: string; businessId: string }): Promise<ClinikoAppointment[]>;
listDeletedAppointments(params: { since: string }): Promise<ClinikoAppointment[]>;
```
- `listChangedAppointments` → `GET /individual_appointments?q[]=updated_at:>{since}&q[]=starts_at:>={today}&per_page=100`, following `links.next` (bounded page cap). Scoped to `businessId` where the API allows.
- `listDeletedAppointments` → `GET /individual_appointments/deleted?q[]=deleted_at:>{since}`, paginated.
- `ClinikoAppointment` gains the fields we read (`cancelled_at`, `deleted_at`, `starts_at`, `ends_at`, `updated_at`, `appointment_type`/`practitioner` ids) if not already present; reuse GET-only retry and the existing error taxonomy.

### Settings field — no migration

`lastReconciledAt?: string | null` is added to `ClinikoIntegrationSettings` and lives in the existing `calendar_integrations.settings` JSON. No schema change.

## Error handling

- **Reconcile failure never breaks the scheduling tool.** On any error, log + `Sentry.captureException` (tag `cliniko_reconcile_failed`), **do not advance the cursor**, and let the tool proceed. Availability and booking already read live Cliniko, and a Cliniko outage falls into the existing take-a-message path, so a stale mirror in that window degrades gracefully rather than dropping the call.
- **Auth failure** during reconcile calls the existing `markClinikoAuthFailure(orgId, integrationId)` (flags the integration, one owner email) and is otherwise swallowed.
- **Per-row update failure** (e.g. a retime that would itself collide with another mirror row) is caught per row, logged + Sentry, and does not abort the batch; the cursor still advances (that appointment is picked up again next run via the skew overlap only if its `updated_at` moves — a known, bounded gap noted below).
- **Cron** mirrors catalog-sync: one org's failure never blocks the rest.

## Testing

- **Reconcile core:** cancelled→void; deleted→void; `starts_at` change→retime; unchanged→untouched; `external_id` with no mirror→skip; freshness gate skips within window and runs with `force`; cursor advances to poll-start on success; error path leaves cursor unchanged; settings write uses read-before-write (no clobber of shard/businessId).
- **Client:** `listChangedAppointments` builds the `updated_at` + `starts_at` `q[]` params and follows pagination; `listDeletedAppointments` hits the deleted endpoint; GET-retry/error taxonomy reused.
- **Dispatch:** each of the three handlers invokes `reconcileClinikoOrg` before touching mirror rows (spy/mock); a reconcile throw does not fail the handler.
- **Cron:** iterates active integrations, force-reconciles, per-org isolation, auth failure flags the integration.

## Out of scope (ticket-honest)

- **True real-time push.** Impossible without Cliniko webhooks; polling is the ceiling. At-call reconciliation makes it effectively live *when it matters* (a caller on the line).
- **Reconciling appointments Phondo never booked.** We only own our mirror rows; the practice's own diary is Cliniko's concern.
- **Sub-daily cron.** Blocked on Vercel Hobby; the at-call trigger is what delivers freshness. Revisit cron cadence on Pro (already tracked in the deployment notes).
- **Retime-collision auto-resolution.** If staff move an appointment into a slot Phondo already mirrors for a different booking, the retime is logged/Sentry'd and left as-is rather than force-resolved; availability stays correct because it reads live Cliniko.

## Follow-ups to file if surfaced in review

- Reconcile-collision handling (retime into an occupied mirror slot) beyond log-and-skip.
- On Vercel Pro, add a frequent reconcile cron so no-call orgs converge faster than daily.
