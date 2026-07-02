# Cliniko Integration (SCRUM-12) — Design

**Date:** 2026-07-02
**Status:** Approved decisions from owner (5 questions answered); technical approach selected autonomously per standing instruction, flagged for veto.
**Branch:** `feature/SCRUM-12-cliniko-integration`

## Goal

When an org connects their Cliniko account, the AI receptionist books real appointments in the practice's actual Cliniko diary: availability checks, new bookings, cancellations, and reschedules all hit the Cliniko API live. Cliniko is the source of truth; Phondo keeps mirror rows for dashboard, transcripts, confirmation codes, and caller verification.

## Owner decisions (locked)

1. **Sync depth:** Full Cliniko mode — availability, book, cancel, reschedule all live against Cliniko.
2. **Outage behavior:** After a quick retry, stop offering booking and switch to the existing take-a-message/callback flow. Never book blind.
3. **Patient matching:** Find by phone, else create a minimal patient. Ambiguous matches create a new patient flagged as a possible duplicate in the appointment note.
4. **MVP scope:** Bookings only. No post-call patient-note sync (fast-follow ticket). The appointment note carries caller-provided visit reason + caller phone + provenance line.
5. **Gating:** Professional+ (same tier story as webhook integrations).

## Verified Cliniko API facts (docs.api.cliniko.com, checked 2026-07-02)

- **Auth:** HTTP Basic; API key as username, empty password (`Basic base64(key + ":")`). Key carries a region shard suffix (e.g. `MS0x...-au2`).
- **Base URL:** `https://api.{shard}.cliniko.com/v1/` (e.g. `api.au2.cliniko.com`). Shard parsed from the key suffix; MVP **requires** the suffix and rejects keys without it.
- **User-Agent:** `AppName (contact@email)` is **required**; requests without it may be blocked.
- **Rate limit:** 200 requests/min per user; 429 + `X-RateLimit-Reset` (UNIX ts).
- **Filtering:** `q[]=field:{op}value`; string ops `=`, `!=`, `~` (contains), `~~` (wildcard).
- **Patients:** `POST /patients` requires only `first_name`+`last_name`; phones via `patient_phone_numbers: [{phone_type: "Mobile", number}]`. List filter supports name/email/dob/etc — **NOT phone numbers**. Archived patients live under `/patients/archived`.
- **Availability:** `GET /businesses/{b}/practitioners/{p}/appointment_types/{t}/available_times?from&to` — per-practitioner, `from`/`to` ≤ 7 days apart, not in the past (account TZ). Response items: `{appointment_start}` (UTC ISO). Also `.../next_available_time`.
- **Create appointment:** `POST /individual_appointments` with `starts_at`, `patient_id`, `practitioner_id`, `appointment_type_id`, `business_id`; `ends_at` auto-derived from the appointment type duration when omitted; `notes` optional.
- **Cancel:** `PATCH /individual_appointments/{id}/cancel` with mandatory integer `cancellation_reason` (50 = Other) + optional `cancellation_note`. Already-cancelled/missing → treat 404/409 as success and re-sync the mirror row.
- **Reschedule:** `PUT /individual_appointments/{id}` updating `starts_at` — atomic in Cliniko (no free-then-insert dance needed on the Cliniko side).
- **Caveat:** API writes are trusted — Cliniko does NOT reject conflicting appointments. We must re-verify the slot via `available_times` immediately before create (small TOCTOU window accepted; noted below).

## Approaches considered

- **A (chosen): Provider module behind existing handlers.** New `cliniko.ts` client + `cliniko-booking.ts` flows; the five tool handlers get a top-priority "Cliniko connected?" branch (mirrors today's built-in→Cal.com priority). Catalog imported into existing `practitioners`/`service_types` tables via new external-ref columns, so prompt builder, round-robin, verification, SMS, dashboard keep working untouched.
- **B (rejected for now): Extract a formal CalendarProvider interface** across internal/cal_com/cliniko. Cleaner, but refactors 2,872 lines of battle-tested security-relevant code (SCRUM-438 caller verification, SCRUM-399 reschedule LEG) with zero user-visible gain. Revisit when a second external provider (ServiceM8) lands — rule of three. Follow-up ticket.
- **C (rejected): Live-fetch catalog at call time.** No local practitioners/service_types for Cliniko orgs. Avoids sync drift but breaks prompt builder/dashboard assumptions and adds mid-call latency everywhere.

## Data model (migration `00159_cliniko_integration.sql`)

1. `calendar_integrations.provider` CHECK: add `'cliniko'`.
2. `appointments.provider` CHECK: add `'cliniko'`.
3. `practitioners`: add `external_provider TEXT`, `external_id TEXT`; partial unique index `(organization_id, external_provider, external_id) WHERE external_provider IS NOT NULL`.
4. `service_types`: same two columns + same index.
5. **New table `crm_credentials`** — `id`, `organization_id` FK, `provider TEXT` (`'cliniko'`), `secret TEXT NOT NULL`, `created_at`, `updated_at`; UNIQUE `(organization_id, provider)`. **RLS enabled with NO policies** → service-role only (same posture as `subscriptions`). Rationale: Cliniko API keys grant full access to a medical records system. The existing `calendar_integrations` RLS policy (`FOR ALL` to org members) makes `access_token` readable from any org member's browser session — acceptable-ish for Cal.com, not for Cliniko. (Cal.com exposure → Jira finding, see Follow-ups.)
6. **New table `crm_patient_links`** — `id`, `organization_id` FK, `provider TEXT`, `phone_e164 TEXT`, `external_patient_id TEXT`, `patient_name TEXT`, `last_seen_at`, timestamps; UNIQUE `(organization_id, provider, phone_e164)`. RLS enabled, no policies (backend cache only; upsert-on-write).
7. `calendar_integrations` row for Cliniko stores **no secret**: `access_token` NULL; `settings` JSONB = `{ shard, businessId, businessName, lastSyncedAt, errorState }`; `is_active` as the on/off switch.

## Components

### 1. `src/lib/calendar/cliniko.ts` — API client (mirrors `cal-com.ts` shape)

- `parseClinikoApiKey(raw)` → `{ key, shard }`; shard must match `^[a-z]{2,3}\d{1,2}$` (allowlist regex — the shard is interpolated into a hostname; this is the SSRF guard). Keys without a recognizable shard suffix are rejected at connect time with a clear message.
- `ClinikoClient` with: `listBusinesses`, `listPractitioners(businessId?)`, `listAppointmentTypes`, `availableTimes(b, p, t, from, to)`, `nextAvailableTime(b, p, t, from, to)`, `findPatientsByName(first, last)`, `getPatient(id)`, `createPatient(...)`, `createAppointment(...)`, `cancelAppointment(id, reasonCode, note)`, `updateAppointment(id, patch)`, `getAppointment(id)`.
- Every request: `User-Agent: Phondo ({CLINIKO_CONTACT_EMAIL})` (env, default owner email — **open question** below), `Accept: application/json`, timeout **3.5s on voice paths / 10s on admin paths**, single retry on 5xx/network **for GETs only**. Writes are never auto-retried (a retried create can double-book). 429 → respect reset if ≤2s on voice path, else fail over to outage behavior.
- Error taxonomy: `ClinikoAuthError` (401/403), `ClinikoRateLimitError` (429), `ClinikoValidationError` (422), `ClinikoUnavailableError` (5xx/timeout/network). API key never logged; masked (`…last4`) everywhere.
- Pagination helper for list endpoints (`per_page=100`, follow `links.next`).

### 2. `src/lib/calendar/cliniko-sync.ts` — catalog import

- `syncClinikoCatalog(orgId)`: practitioners (for the selected business) → upsert into `practitioners` by external ref; appointment types → upsert into `service_types` (name, `duration_minutes` from type duration). Local rows whose external counterpart disappeared/archived → `is_active = false`. Never deletes.
- New Cliniko-imported service types default active; org can toggle in the existing scheduling settings UI.
- Calls `invalidateVoiceScheduleCache(orgId)` after any change.
- Triggered: on connect, on manual "Sync now", and daily via new cron route `/api/cron/cliniko-catalog-sync` (Vercel daily-only constraint; syncs all active Cliniko integrations, per-org isolation on errors).

### 3. `src/lib/calendar/cliniko-booking.ts` — voice-path flows

- `getActiveClinikoIntegration(orgId)` → joined read of `calendar_integrations` (provider `cliniko`, `is_active`) + `crm_credentials` → `ClinikoClient` + settings, or null. One indexed query; called at the top of each handler.
- **Dispatch rule in `tool-handlers.ts`:** Cliniko (when connected & healthy) > built-in > Cal.com. Caller verification (possession/knowledge factors) runs BEFORE provider dispatch for cancel/reschedule and operates on local mirror rows — unchanged.
- **check_availability:** resolve `service_type_id` → linked `appointment_type_id` (service types without external refs are not offered for Cliniko orgs); fan out `available_times` across active Cliniko-linked practitioners in parallel (clinics: typically 1–8); merge chronologically, dedupe, format with the existing voice availability formatter (org timezone). No caching in MVP — stale availability is a double-booking vector.
- **book_appointment:** honor `args.practitioner_id` (map local row → external id) else round-robin among practitioners whose `available_times` contain the requested slot; **re-verify the slot for the chosen practitioner immediately before create**; patient find-or-create (below); `POST /individual_appointments` with `notes` = visit reason (AI-collected `notes` arg) + caller phone + `"Booked by Phondo AI receptionist"` + possible-duplicate flag; insert mirror `appointments` row (`provider: 'cliniko'`, `external_id`, `metadata: { clinikoPatientId, clinikoBusinessId, clinikoAppointmentTypeId, clinikoPractitionerId }`, normal confirmation code); existing SMS confirmation + notification paths fire as today.
- **cancel_appointment:** verification → resolve mirror row → `PATCH .../cancel` (`cancellation_reason: 50`, note `"Cancelled by caller via Phondo"`) → mirror `status: 'cancelled'`. Cliniko 404/already-cancelled → treat as success, sync mirror.
- **reschedule_appointment:** verification → slot re-verify → single `PUT` updating `starts_at` → mirror follows the existing lifecycle convention: new mirror row (`status: 'confirmed'`, `rescheduled_from_id` chain, same `external_id`), old row `status: 'rescheduled'`. Dashboard timeline and `appointment_events` audit stay consistent.
- **lookup_appointment:** unchanged (reads mirror rows).
- **Outage behavior everywhere:** on `ClinikoUnavailableError`/`ClinikoRateLimitError`/`ClinikoAuthError`, return the existing take-a-message ToolResult phrasing; on `ClinikoAuthError` additionally set `settings.errorState = 'auth_failed'` and send ONE email via the existing notification service (deduped by `errorState` — cleared on successful reconnect/sync).

### 4. Patient find-or-create (no phone filter exists — this is the workaround)

Normalization: names → trim/collapse whitespace, case- and diacritic-insensitive compare; phones → strip non-digits, compare by **last 9 digits** (covers `04xx…`, `+614xx…`, `614xx…` AU forms; works generically elsewhere).

1. **Link cache:** `crm_patient_links` by `(org, phone_e164)` → `GET /patients/{id}` → verify name still matches (first initial + last name) → use. (2 requests.)
2. **Name search:** `q[]=last_name:=` (+ `first_name:=`, falling back to `~` contains) → client-side phone corroboration against returned `patient_phone_numbers`. Exactly one corroborated match → use.
3. **Create:** minimal patient (`first_name`, `last_name`, `patient_phone_numbers: [{phone_type: "Mobile", number: callerPhone}]`). If step 2 had name-matches that failed phone corroboration, append `"Note: may duplicate existing patient {name} (#id) — please review/merge."` to the appointment note.
4. On success (any path): upsert link cache with `last_seen_at`.

Phone source: verified caller ID when present (`TrustedCallContext`), else the AI-collected phone arg (browser/test calls). No medical data is ever written — names, phone, visit reason only.

### 5. API routes — `src/app/api/v1/integrations/cliniko/`

- `POST /` (connect): body `{ apiKey }` → parse/validate shard → live `GET /businesses` to prove the key → persist `crm_credentials` + `calendar_integrations` → run initial catalog sync → return `{ businesses, masked key, sync summary }`. If multiple businesses: integration saved with `businessId` unset & inactive until `PATCH` picks one (single-business accounts auto-select).
- `PATCH /` : select business / toggle `is_active`.
- `GET /` (status): masked key, business, last sync, error state, counts. Secret never leaves the server.
- `DELETE /` (disconnect): deactivate integration, delete `crm_credentials` row, `is_active=false` on Cliniko-linked practitioners/service_types (history rows untouched).
- `POST /sync`: manual catalog re-sync.
- All routes: session auth + org membership (same role requirements as existing integrations routes), `hasFeatureAccess(orgId, "crmIntegrations")`, standard rate limiting, input validation. Key accepted via POST body only; never echoed, never logged.

### 6. Feature gating

`GatedFeature` union += `"crmIntegrations"`; plan flags: starter `false`, professional `true`, business `true`. Enforced server-side in all Cliniko routes; UI shows the existing upgrade prompt pattern when gated. (Voice path intentionally NOT gated at call time — if a connected org downgrades, dashboard blocks management but live calls keep working until disconnect; fails open per billing-service conventions.)

### 7. Settings UI — Cliniko card on Settings → Integrations

States: gated (upgrade prompt) → not connected (API key paste, password-type input + link to Cliniko's "generate API key" help) → business picker (when >1) → connected (business name, masked key, last-synced, practitioner/service counts, Sync now, Disconnect) → error banner (`auth_failed`: re-paste key CTA). Loading/disabled/error states per existing UX checklist; mobile OK (single-column card).

### 8. Voice server

**No changes.** Context loading reads local `service_types`/`practitioners`; tools execute via the Next.js internal API where dispatch happens. Catalog sync + booking paths already invalidate the voice schedule cache.

## Error handling matrix (voice path)

| Failure | Caller experience | System action |
|---|---|---|
| Cliniko 5xx/timeout/network | Take-a-message flow (existing phrasing) | GETs retried once; writes never; Sentry breadcrumb |
| 429 | ≤2s wait then retry once, else take-a-message | respect `X-RateLimit-Reset` |
| 401/403 | Take-a-message flow | `errorState=auth_failed`, one dedup'd email to org, Sentry |
| Slot taken between check & create (TOCTOU) | Re-verify catches most; residual risk accepted (seconds-wide window) | if create verifiably conflicts → offer alternative slots |
| Cancel of already-cancelled | "You're all set" (idempotent success) | mirror synced |

## Testing

Vitest, following repo mock patterns (mocked `fetch`, mocked Supabase admin client):

- `cliniko.ts`: key/shard parsing (valid, missing suffix, hostile input → SSRF guard), auth header, User-Agent, pagination, per-class error mapping, GET-only retry, write no-retry, 429 handling.
- Patient matching: cache hit + name drift, name search + phone corroboration (AU formats), ambiguous → create + duplicate flag, no-phone caller path.
- Sync: upsert idempotency, archived → deactivate, no deletes, cache invalidation called.
- Handlers: dispatch priority (Cliniko > built-in > cal_com), booking happy path writes mirror + Cliniko payload shape, practitioner honor + round-robin-among-available, outage → take-a-message on each verb, cancel idempotency, reschedule mirror chain (`rescheduled_from_id`, same `external_id`).
- Routes: gating (starter blocked), authz, connect validates live + stores secret only in `crm_credentials`, masked responses, disconnect cleanup.

## Rollout

Inherently opt-in (an org must paste a key); no env flag. Ships enabled for Professional+. Docs: short connect guide in the existing integrations guide-data.

## Follow-ups (Jira tickets to create at PR time)

1. Cal.com `access_token` readable by org members via `calendar_integrations` RLS — migrate to `crm_credentials` posture (P2, security).
2. Inbound Cliniko webhooks → live mirror updates when the practice moves/cancels appointments in Cliniko (P2).
3. Post-call patient notes/communications sync — the deferred half of SCRUM-12 (P3, needs pilot validation).
4. CalendarProvider interface refactor when ServiceM8 lands (P3, tech debt).
5. Multi-business (multi-location) Cliniko accounts — MVP supports one selected business (P3).
6. Group appointment types / classes — excluded from MVP (P3).
7. Availability response caching if voice latency shows up in pilots (P3, perf).

## Open questions for owner (non-blocking; defaults chosen)

1. **Cliniko `User-Agent` contact email** — env `CLINIKO_CONTACT_EMAIL`, defaulting to `michaelmakhoul0@gmail.com`. Swap to a support@ address when the domain mailbox exists.
2. **Cancellation reason code** — defaulting to `50` ("Other") with a descriptive note. Fine?
3. **Marketing/pricing page mention** of Cliniko — not touched in this PR; say the word and it goes in the features list.
