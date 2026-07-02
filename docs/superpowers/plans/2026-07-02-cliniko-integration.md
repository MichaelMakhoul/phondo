# Cliniko Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI receptionist books/cancels/reschedules real appointments in a connected Cliniko diary, with availability read live from Cliniko.

**Architecture:** New provider modules (`cliniko.ts` client, `cliniko-patients.ts` matching, `cliniko-sync.ts` catalog import, `cliniko-booking.ts` flows) behind a top-priority dispatch branch in the existing `tool-handlers.ts`. Cliniko catalog imported into existing `practitioners`/`service_types` tables via new external-ref columns; every Cliniko booking mirrored as a local `appointments` row so verification/SMS/dashboard work unchanged.

**Tech Stack:** Next.js 15 App Router, Supabase (service-role admin client), Vitest, Zod, existing `safeEncrypt` crypto helpers. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-02-cliniko-integration-design.md` — read it first; it holds verified Cliniko API facts (auth, endpoints, no-phone-filter constraint, rate limits).

## Global Constraints

- DB `snake_case`, API/frontend `camelCase`; Supabase admin client typed `(supabase as any)`.
- Every org-scoped query filters by `organization_id`.
- Voice-path Cliniko requests: 3.5s timeout; admin-path: 10s. GETs retry once on 5xx/network; **writes never auto-retry**.
- `User-Agent: Phondo (${process.env.CLINIKO_CONTACT_EMAIL || "michaelmakhoul0@gmail.com"})` on every Cliniko request; `Accept: application/json`.
- API key never logged, never returned by any route; store `safeEncrypt(key)`; expose only `keyLast4` via `settings`.
- Shard regex allowlist `^[a-z]{2,3}\d{1,2}$` before hostname interpolation (SSRF guard).
- Mirror-row ordering: local mirror insert FIRST (reserves + generates confirmation code), Cliniko create SECOND, delete mirror on Cliniko failure.
- ToolResult failure messages reuse the existing take-a-message phrasing style (see `tool-handlers.ts` internal-booking fallback copy).
- Run `npx vitest run <file>` after each task; `npm run lint && npx tsc --noEmit && npx vitest run` before the PR.
- Commit after each task with `feat(SCRUM-12): …` messages.

---

### Task 1: Migration `00159_cliniko_integration.sql`

**Files:**
- Create: `supabase/migrations/00159_cliniko_integration.sql`

**Interfaces:**
- Produces: `'cliniko'` accepted by `calendar_integrations.provider` + `appointments.provider` CHECKs; `practitioners.external_provider/external_id`, `service_types.external_provider/external_id` columns; `crm_patient_links` table.

- [ ] **Step 1: Write the migration**

```sql
-- SCRUM-12: Cliniko CRM integration
-- 1) Allow 'cliniko' as a calendar integration + appointment provider
ALTER TABLE calendar_integrations DROP CONSTRAINT IF EXISTS calendar_integrations_provider_check;
ALTER TABLE calendar_integrations ADD CONSTRAINT calendar_integrations_provider_check
  CHECK (provider IN ('cal_com', 'calendly', 'google_calendar', 'cliniko'));

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_provider_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_provider_check
  CHECK (provider IN ('cal_com', 'calendly', 'google_calendar', 'manual', 'internal', 'cliniko'));

-- 2) External refs on the local catalog (imported from the CRM)
ALTER TABLE practitioners ADD COLUMN IF NOT EXISTS external_provider TEXT;
ALTER TABLE practitioners ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_practitioners_external_ref
  ON practitioners(organization_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL;

ALTER TABLE service_types ADD COLUMN IF NOT EXISTS external_provider TEXT;
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_types_external_ref
  ON service_types(organization_id, external_provider, external_id)
  WHERE external_provider IS NOT NULL;

-- 3) Phone -> CRM patient link cache (backend-only; service role)
CREATE TABLE IF NOT EXISTS crm_patient_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('cliniko')),
  phone_e164 TEXT NOT NULL,
  external_patient_id TEXT NOT NULL,
  patient_name TEXT,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (organization_id, provider, phone_e164)
);
CREATE INDEX IF NOT EXISTS idx_crm_patient_links_org ON crm_patient_links(organization_id);
ALTER TABLE crm_patient_links ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (same posture as subscriptions).

COMMENT ON TABLE crm_patient_links IS 'Cache mapping caller phone numbers to CRM patient ids (Cliniko has no phone filter on patients).';
```

- [ ] **Step 2: Apply via Supabase MCP `apply_migration` (name `cliniko_integration`) and verify** `list_tables` shows `crm_patient_links`, then commit.

### Task 2: `src/lib/calendar/cliniko.ts` — API client

**Files:**
- Create: `src/lib/calendar/cliniko.ts`
- Test: `src/lib/calendar/__tests__/cliniko.test.ts`

**Read first:** `src/lib/calendar/cal-com.ts` (client/CRUD shape), `src/lib/security/encryption.ts` (`safeEncrypt`/`safeDecrypt` signatures), one existing test using mocked `fetch` (`grep -rl "vi.stubGlobal(\"fetch\"\|global.fetch" src --include="*.test.ts"`).

**Interfaces (Produces):**
```ts
export class ClinikoApiKeyError extends Error {}           // bad key format / missing shard
export class ClinikoAuthError extends Error {}             // 401/403
export class ClinikoRateLimitError extends Error { resetAtMs?: number }
export class ClinikoValidationError extends Error { detail?: unknown } // 422
export class ClinikoUnavailableError extends Error {}      // 5xx / timeout / network

export function parseClinikoApiKey(raw: string): { key: string; shard: string } // throws ClinikoApiKeyError
export interface ClinikoBusiness { id: string; business_name: string }
export interface ClinikoPractitioner { id: string; first_name: string; last_name: string; active: boolean }
export interface ClinikoAppointmentType { id: string; name: string; duration_in_minutes: number; archived_at: string | null }
export interface ClinikoPatient {
  id: string; first_name: string; last_name: string; archived_at?: string | null;
  patient_phone_numbers?: Array<{ phone_type: string; number: string }>;
}
export interface ClinikoAppointment {
  id: string; starts_at: string; ends_at: string; cancelled_at: string | null;
  patient_id?: string; practitioner_id?: string; appointment_type_id?: string; business_id?: string; notes?: string | null;
}
export class ClinikoClient {
  constructor(opts: { apiKey: string; shard: string; timeoutMs?: number })
  listBusinesses(): Promise<ClinikoBusiness[]>
  listPractitioners(): Promise<ClinikoPractitioner[]>
  listAppointmentTypes(): Promise<ClinikoAppointmentType[]>
  availableTimes(businessId: string, practitionerId: string, appointmentTypeId: string, fromDate: string, toDate: string): Promise<string[]> // appointment_start ISO strings
  findPatientsByName(firstName: string, lastName: string, opts?: { contains?: boolean }): Promise<ClinikoPatient[]>
  getPatient(id: string): Promise<ClinikoPatient | null>                     // null on 404
  createPatient(p: { firstName: string; lastName: string; phone?: string }): Promise<ClinikoPatient>
  createAppointment(a: { businessId: string; practitionerId: string; appointmentTypeId: string; patientId: string; startsAtIso: string; notes?: string }): Promise<ClinikoAppointment>
  cancelAppointment(id: string, note?: string): Promise<void>                // PATCH …/cancel {cancellation_reason: 50, cancellation_note}; 404/already-cancelled => resolves (idempotent)
  updateAppointmentTime(id: string, startsAtIso: string): Promise<ClinikoAppointment> // PUT
}
```
Cliniko ids are numbers in JSON — normalize to strings at the client boundary (`String(raw.id)`).

- [ ] **Step 1: Failing tests** covering: `parseClinikoApiKey` (valid `-au2` suffix; uppercase/whitespace trimmed; missing suffix throws; hostile `evil.com/-au1` style input throws — regex `^[a-z]{2,3}\d{1,2}$` on shard only); Basic auth header = `Basic ${base64(key + ":")}`; `User-Agent` present; GET retries once on 500 then succeeds; POST does NOT retry on 500; 429 maps to `ClinikoRateLimitError` with `resetAtMs` from `X-RateLimit-Reset`; 401 → `ClinikoAuthError`; 422 → `ClinikoValidationError`; timeout (AbortController) → `ClinikoUnavailableError`; pagination follows `links.next` until absent; `availableTimes` returns `appointment_start` strings; `cancelAppointment` swallows 404; ids normalized to strings.
- [ ] **Step 2: Run tests — expect FAIL** (module not found).
- [ ] **Step 3: Implement** — single private `request(method, path, {query, body, retryGets})` helper: URL `https://api.${shard}.cliniko.com/v1${path}`; AbortController timeout (default 3500); error mapping; no key in any error message/log (wrap fetch errors: `new ClinikoUnavailableError("cliniko request failed: " + status)`); list helpers paginate with `per_page=100`.
- [ ] **Step 4: Run tests — expect PASS.**
- [ ] **Step 5: Commit** `feat(SCRUM-12): Cliniko API client with shard parsing and error taxonomy`

### Task 3: `src/lib/calendar/cliniko-patients.ts` — find-or-create matching

**Files:**
- Create: `src/lib/calendar/cliniko-patients.ts`
- Test: `src/lib/calendar/__tests__/cliniko-patients.test.ts`

**Read first:** the mocked-Supabase test pattern (`src/app/api/v1/notification-preferences/__tests__/route.test.ts` mocks `createAdminClient` — copy the chain-mock helper style).

**Interfaces:**
- Consumes: `ClinikoClient` (Task 2), `createAdminClient`.
- Produces:
```ts
export function normalizePhoneForMatch(phone: string): string | null   // strip non-digits, last 9; null if <8 digits
export function namesLooselyMatch(aFirst: string, aLast: string, bFirst: string, bLast: string): boolean
  // case/diacritic-insensitive; last names equal AND first initials equal
export interface PatientResolution { patientId: string; created: boolean; duplicateWarning?: string }
export async function findOrCreateClinikoPatient(opts: {
  client: ClinikoClient; organizationId: string;
  firstName: string; lastName: string; phone?: string;   // phone: verified caller ID preferred, else AI-collected
}): Promise<PatientResolution>
```
- Algorithm (spec §4): (1) link-cache hit by `(org,'cliniko', phone_e164)` → `getPatient` → `namesLooselyMatch` → return, bump `last_seen_at`; (2) `findPatientsByName` exact then contains → keep non-archived → phone-corroborate via `normalizePhoneForMatch` equality when caller phone present (no phone → require exactly ONE name match to use it); exactly one survivor → return; (3) `createPatient`; if step-2 had name matches that failed corroboration, set `duplicateWarning` = `"May duplicate existing patient ${name} (#${id}) — please review/merge."`; (4) upsert cache (`onConflict: "organization_id,provider,phone_e164"`) on every success when phone present.

- [ ] **Step 1: Failing tests**: AU phone normalization (`0412 345 678`, `+61412345678`, `61412345678` all → `412345678`; short/garbage → null); name matching (case, `José`≈`Jose`, first-initial rule); cache-hit path (2 client calls max: getPatient only); cache-hit with name drift falls through to search; exact-name single corroborated match; multiple name matches + phone picks the corroborated one; matches without corroboration → create + `duplicateWarning`; no-phone caller with single name match uses it, with 2+ creates new; cache upserted after create.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(SCRUM-12): Cliniko patient find-or-create with phone corroboration`

### Task 4: `src/lib/calendar/cliniko-sync.ts` — catalog import

**Files:**
- Create: `src/lib/calendar/cliniko-sync.ts`
- Test: `src/lib/calendar/__tests__/cliniko-sync.test.ts`

**Read first:** `src/lib/voice-cache/invalidate.ts` (signature), `practitioner_services` join usage in `tool-handlers.ts` (`getPractitionersForService`).

**Interfaces:**
- Consumes: `ClinikoClient`, `createAdminClient`, `invalidateVoiceScheduleCache(orgId)`.
- Produces:
```ts
export interface ClinikoSyncResult { practitionersUpserted: number; serviceTypesUpserted: number; deactivated: number }
export async function syncClinikoCatalog(organizationId: string, client: ClinikoClient): Promise<ClinikoSyncResult>
```
- Behavior: upsert practitioners (`name = first_name + " " + last_name`, `external_provider: 'cliniko'`, `external_id`, `is_active: p.active !== false`) keyed on the external-ref unique index; upsert service types (`name`, `duration_minutes: duration_in_minutes || 30`, non-archived only); Cliniko-linked local rows missing from the fetch (or archived) → `is_active: false`, never delete; link every imported practitioner to every imported service type in `practitioner_services` (upsert, ignore-duplicates) — Cliniko's `available_times` is the real capability filter, over-linking self-corrects at availability time (spec: MVP caveat); finish with `invalidateVoiceScheduleCache`.

- [ ] **Step 1: Failing tests**: fresh import creates rows with external refs; re-run is idempotent (updates, no duplicates); renamed practitioner updates in place by external_id; archived appointment type → local `is_active=false` (not deleted); practitioner_services links created; cache invalidation called once; per-entity DB error doesn't abort the rest (collect + continue, throw aggregate at end).
- [ ] **Step 2–4: FAIL → implement → PASS.**
- [ ] **Step 5: Commit** `feat(SCRUM-12): Cliniko catalog sync into local practitioners/service_types`

### Task 5: `src/lib/calendar/cliniko-booking.ts` — voice flows

**Files:**
- Create: `src/lib/calendar/cliniko-booking.ts`
- Test: `src/lib/calendar/__tests__/cliniko-booking.test.ts`

**Read first:** `tool-handlers.ts` internal booking block (~lines 2440–2560: requested-practitioner honor, round-robin, confirmation-code retry loop, 23P01 handling, ToolResult copy), `handleCancelAppointment` mirror update, reschedule mirror-chain semantics in `reschedule-core.ts`, `formatBuiltInAvailabilityForVoice`, SMS confirmation call site, `getCalendarIntegration` in `cal-com.ts`.

**Interfaces:**
- Consumes: Tasks 2–4 exports; `safeDecrypt`; existing helpers (`generateConfirmationCode` — reuse via export or local copy of the existing pattern, `sendAppointmentConfirmationSMS`, `invalidateVoiceScheduleCache`).
- Produces (consumed by Task 6):
```ts
export interface ClinikoContext { client: ClinikoClient; businessId: string; integrationId: string }
export async function getActiveClinikoIntegration(organizationId: string): Promise<ClinikoContext | null>
  // calendar_integrations where provider='cliniko' AND is_active=true, settings.businessId set; safeDecrypt token; null on any miss
export async function clinikoCheckAvailability(ctx, organizationId: string, args: { date: string; service_type_id: string }): Promise<ToolResult>
export async function clinikoBookAppointment(ctx, organizationId: string, args: BookArgs /* same shape tool-handlers passes */): Promise<ToolResult>
export async function clinikoCancelAppointment(ctx, organizationId: string, appointmentRow: MirrorRow): Promise<ToolResult>
export async function clinikoRescheduleAppointment(ctx, organizationId: string, appointmentRow: MirrorRow, newStartIso: string): Promise<ToolResult>
export function isClinikoOutage(err: unknown): boolean  // Unavailable | RateLimit | Auth
```
- **Availability:** service_type must have `external_provider='cliniko'` (else return the existing "which type of appointment" prompt limited to cliniko-linked active types); practitioners = cliniko-linked active rows for that service (`getPractitionersForService` equivalent query); parallel `availableTimes(business, p.external_id, st.external_id, date, date)`; merge/dedupe/sort; format with the existing voice formatter in org timezone.
- **Booking order:** resolve service type + practitioner candidates → for requested `practitioner_id` verify slot in their `availableTimes`, else pick round-robin among candidates whose times include the slot → `findOrCreateClinikoPatient` → **insert local mirror row FIRST** (`provider:'cliniko'`, confirmation-code retry loop identical to internal, 23P01 → "slot no longer available" copy) → `createAppointment` in Cliniko (notes = visit-reason arg + `Caller: ${name} ${phone}` + `Booked by Phondo AI receptionist.` + duplicateWarning) → update mirror with `external_id` + `metadata:{ clinikoPatientId, clinikoBusinessId, clinikoAppointmentTypeId, clinikoPractitionerId, source:'ai_receptionist' }` → SMS confirmation (existing call) → success ToolResult with confirmation code readback (reuse internal copy). **On Cliniko create failure: delete the mirror row, return take-a-message copy.**
- **Cancel:** `cancelAppointment(external_id, "Cancelled by caller via Phondo")` (idempotent) → mirror `status:'cancelled'` → invalidate cache.
- **Reschedule:** verify new slot via `availableTimes` for the mirror row's practitioner → `updateAppointmentTime` → new mirror row chained per existing convention (`rescheduled_from_id` = old id, same `external_id`, fresh confirmation code), old row `status:'rescheduled'`.
- **Auth failure side-effect:** on `ClinikoAuthError` anywhere: `settings.errorState='auth_failed'` on the integration row + one email via existing notification service iff errorState was previously null (dedupe), Sentry capture; always still return take-a-message ToolResult.

- [ ] **Step 1: Failing tests** (mock ClinikoClient + admin client): availability merges 2 practitioners' slots sorted/deduped; unlinked service type prompts type selection; booking happy path — mirror inserted before Cliniko create, external_id patched after, SMS called, ToolResult has confirmation code; Cliniko create 500 → mirror deleted + take-a-message; requested practitioner without the slot → alternative-times copy; 23P01 on mirror insert → slot-taken copy (no Cliniko call made); cancel idempotent on 404; reschedule creates chained mirror row and old row marked; auth error sets errorState + sends email once (second call: no email); `isClinikoOutage` classification.
- [ ] **Step 2–4: FAIL → implement → PASS.**
- [ ] **Step 5: Commit** `feat(SCRUM-12): Cliniko live booking flows with mirror rows`

### Task 6: Dispatch wiring in `tool-handlers.ts`

**Files:**
- Modify: `src/lib/calendar/tool-handlers.ts` (4 sites: `handleCheckAvailability` top after arg validation; `handleBookAppointment` after name/datetime validation; `handleCancelAppointment` + `handleRescheduleAppointment` AFTER caller verification, at the provider-action point where the resolved appointment row's provider is known)
- Test: `src/lib/calendar/__tests__/cliniko-dispatch.test.ts`

**Pattern (check/book):**
```ts
const clinikoCtx = await getActiveClinikoIntegration(organizationId);
if (clinikoCtx) {
  return clinikoCheckAvailability(clinikoCtx, organizationId, { date, service_type_id });
}
// …existing built-in / cal_com paths unchanged
```
**Pattern (cancel/reschedule):** keep ALL existing verification + row resolution; where the existing code branches on `appointment.provider === "cal_com"`, add the `"cliniko"` branch delegating to Task 5 functions. Cancel/reschedule of an internal-provider row keeps the internal path even when Cliniko is connected (row provider wins — historical bookings must stay manageable).

- [ ] **Step 1: Failing tests**: Cliniko connected → check/book route to cliniko functions (spy), built-in NOT called; not connected → existing behavior (regression: existing tool-handler tests still pass untouched); cancel on a `provider:'cliniko'` row hits cliniko cancel; cancel on `provider:'internal'` row ignores Cliniko; verification still runs before cliniko cancel (spy order).
- [ ] **Step 2–4: FAIL → wire → PASS, and run the FULL existing tool-handlers test suite.**
- [ ] **Step 5: Commit** `feat(SCRUM-12): route booking tools to Cliniko when connected`

### Task 7: Feature flag + API routes

**Files:**
- Modify: `src/lib/stripe/billing-service.ts:108` (`GatedFeature` += `"crmIntegrations"`), `src/lib/stripe/client.ts` (plan flags: starter `crmIntegrations: false`, professional/business `true` — insert beside `webhookIntegrations` at lines 27/56/85)
- Create: `src/app/api/v1/integrations/cliniko/route.ts` (POST connect, GET status, PATCH select-business/toggle, DELETE disconnect), `src/app/api/v1/integrations/cliniko/sync/route.ts` (POST manual sync)
- Test: `src/app/api/v1/integrations/cliniko/__tests__/route.test.ts`

**Read first:** `src/app/api/v1/integrations/route.ts` (auth/membership/rate-limit/Zod/`hasFeatureAccess` pattern — copy it exactly).

**Route behaviors:** POST `{ apiKey }` → `parseClinikoApiKey` → `new ClinikoClient(...).listBusinesses()` (proves key; `ClinikoAuthError` → 401 JSON `{error:"Cliniko rejected that API key"}`) → upsert `calendar_integrations` row (`provider:'cliniko'`, `access_token: safeEncrypt(key)`, `settings:{shard, keyLast4, businessId: businesses.length===1 ? businesses[0].id : null, businessName…}`, `is_active: businesses.length===1`) → if active, `syncClinikoCatalog` → return `{businesses, settings-derived status}`. PATCH `{ businessId }` validates against live `listBusinesses`, activates + first sync. GET returns status/counts (`external_provider='cliniko'` counts), never the token. DELETE: `is_active:false`, `access_token: null`, deactivate cliniko-linked practitioners/service_types. All routes: `withRateLimit(request, path, "standard")`, session auth + org membership, `hasFeatureAccess(orgId, "crmIntegrations")` → 403 with upgrade message.

- [ ] **Step 1: Failing tests**: starter plan → 403; bad key format → 400 (no fetch attempted); auth-rejected key → 401; single-business connect → active + synced; multi-business → inactive until PATCH; GET masks (response JSON contains no `access_token` and not the raw key); DELETE deactivates catalog rows; unauthenticated → 401.
- [ ] **Step 2–4: FAIL → implement → PASS.** Also `grep -rn "crmIntegrations" src/lib/stripe` to confirm compile-time plan/enum sync assertion passes (`npx tsc --noEmit`).
- [ ] **Step 5: Commit** `feat(SCRUM-12): crmIntegrations gate + Cliniko connect/status/sync routes`

### Task 8: Daily catalog-sync cron

**Files:**
- Create: `src/app/api/cron/cliniko-catalog-sync/route.ts`
- Modify: `vercel.json` (add `{"path": "/api/cron/cliniko-catalog-sync", "schedule": "0 19 * * *"}` — 19:00 UTC ≈ 5am Sydney)
- Test: `src/app/api/cron/__tests__/cliniko-catalog-sync.test.ts`

**Read first:** `src/app/api/cron/subscription-dunning/route.ts` (cron auth guard pattern — CRON_SECRET header check — copy exactly).

- [ ] **Step 1: Failing tests**: rejects without cron auth; iterates all active cliniko integrations; one org's failure doesn't stop others (result JSON reports per-org ok/error); decrypt failure → org skipped + errorState set.
- [ ] **Step 2–4: FAIL → implement → PASS.**
- [ ] **Step 5: Commit** `feat(SCRUM-12): daily Cliniko catalog sync cron`

### Task 9: Settings UI — Cliniko card

**Files:**
- Modify: `src/app/(dashboard)/settings/integrations/page.tsx` (add card section), `src/lib/integrations/guide-data.ts` (Cliniko connect guide entry)
- Create: `src/components/integrations/cliniko-card.tsx`

**Read first:** the existing integrations page (states, upgrade-prompt pattern, shadcn components used), `src/components/ui/` available primitives.

**States:** gated (upgrade CTA, reuse existing pattern) → disconnected (key input `type="password"`, help link `https://help.cliniko.com/…api-key`, Connect button w/ loading+error) → business picker (radio list when >1) → connected (business name, `keyLast4`, last-synced timestamp, practitioner/service counts, Sync-now button w/ spinner, Disconnect w/ confirm dialog) → error banner when `errorState==='auth_failed'` (re-enter key CTA). All fetches against Task 7 routes; optimistic-free (refetch after mutations); accessible labels; mobile single-column.

- [ ] **Step 1: Implement card + wire into page** (UI task — component tests not required by repo convention; logic lives in routes already tested).
- [ ] **Step 2: `npm run lint && npx tsc --noEmit` clean.**
- [ ] **Step 3: Commit** `feat(SCRUM-12): Cliniko connect card in integrations settings`

### Task 10: Env + docs

**Files:**
- Modify: `.env.example` (add `CLINIKO_CONTACT_EMAIL=` with comment "Contact email sent in Cliniko API User-Agent (required by Cliniko; defaults to owner email)"), `CLAUDE.md` Key Integrations list (+ Cliniko line)

- [ ] **Step 1: Edit files; commit** `docs(SCRUM-12): Cliniko env + integration docs`

### Task 11: Full verification + review pipeline + PR

- [ ] **Step 1:** `npm run lint` (exit 0) && `npx tsc --noEmit` (0 errors) && `npx vitest run` (0 failures) — fix anything before proceeding.
- [ ] **Step 2:** Phase-3 reviews in parallel: `code-reviewer`, `silent-failure-hunter`, `/security-review`, `code-simplifier`, `type-design-analyzer` (new types in cliniko.ts) on the branch diff; Phase-3.5 client-simulator personas (Dental Practice Manager, Medical Clinic Receptionist, First-Time User); fix findings; re-run Step 1.
- [ ] **Step 3:** Push branch, open PR titled `feat(SCRUM-12): Cliniko CRM integration — live booking into the practice diary`, create follow-up Jira tickets (spec §Follow-ups), merge when CI green per standing permissions.

## Self-Review (done at write time)

- **Spec coverage:** every spec component maps to a task (client→2, patients→3, sync→4, flows→5, dispatch→6, gating/routes→7, cron→8, UI→9, env/UA→10, testing/rollout→11). Follow-ups intentionally not implemented.
- **Placeholders:** none — each task carries concrete behaviors, copies existing named patterns, or embeds code.
- **Type consistency:** `ClinikoContext`/error classes/`PatientResolution`/`ClinikoSyncResult` names match across Tasks 2–7.
