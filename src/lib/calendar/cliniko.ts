/**
 * Cliniko API client (SCRUM-12).
 *
 * Facts verified against docs.api.cliniko.com (2026-07-02):
 * - HTTP Basic auth, API key as username, empty password.
 * - The key carries its region shard as a suffix (e.g. "...-au2") and the
 *   base URL is shard-specific: https://api.{shard}.cliniko.com/v1
 * - A `User-Agent: Name (email)` header is REQUIRED — requests without it
 *   may be blocked by Cliniko.
 * - Rate limit: 200 requests/min per user; 429 carries X-RateLimit-Reset.
 * - Patients canNOT be filtered by phone number (see cliniko-patients.ts).
 */

const DEFAULT_TIMEOUT_MS = 3500;
const MAX_PAGES = 20;

// Shard is interpolated into a hostname — this allowlist is the SSRF guard.
const SHARD_PATTERN = /^[a-z]{2,3}\d{1,2}$/;
const KEY_CHARSET = /^[A-Za-z0-9+/=._-]+$/;

// `name` is set on each class so the taxonomy survives in Sentry/console output
// (a bare `extends Error {}` reports as "Error") and makes the otherwise-
// structurally-identical subclasses distinct to TypeScript.
export class ClinikoApiKeyError extends Error {
  readonly name = "ClinikoApiKeyError";
}
export class ClinikoAuthError extends Error {
  readonly name = "ClinikoAuthError";
}
export class ClinikoRateLimitError extends Error {
  readonly name = "ClinikoRateLimitError";
  readonly resetAtMs?: number;
  constructor(message: string, resetAtMs?: number) {
    super(message);
    this.resetAtMs = resetAtMs;
  }
}
export class ClinikoValidationError extends Error {
  readonly name = "ClinikoValidationError";
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}
export class ClinikoUnavailableError extends Error {
  readonly name = "ClinikoUnavailableError";
}

/**
 * The `settings` JSONB on a Cliniko `calendar_integrations` row — the real
 * cross-module contract (read in the booking path, cron, and settings routes).
 * `errorState` is a closed union so a typo in any writer can't silently break
 * the dashboard banner or the auth-failure email dedupe.
 */
export type ClinikoErrorState = "auth_failed" | "sync_failed";
export interface ClinikoIntegrationSettings {
  shard?: string;
  businessId?: string | null;
  businessName?: string | null;
  keyLast4?: string;
  errorState?: ClinikoErrorState | null;
  lastSyncedAt?: string | null;
  // SCRUM-482: reconciliation cursor — the poll-start time of the last successful
  // change-reconciliation run. Doubles as the freshness marker for the at-call gate.
  lastReconciledAt?: string | null;
}

export function parseClinikoApiKey(raw: string): { key: string; shard: string } {
  const key = (raw || "").trim();
  if (!key || !KEY_CHARSET.test(key)) {
    throw new ClinikoApiKeyError(
      "That doesn't look like a Cliniko API key. Copy the full key from Cliniko → My Info → Manage API keys."
    );
  }
  const match = key.match(/-([a-z]{2,3}\d{1,2})$/);
  if (!match || !SHARD_PATTERN.test(match[1])) {
    // Older Cliniko keys have no region suffix at all — "copy everything after
    // the dash" wouldn't help, so tell them to generate a fresh key (current
    // Cliniko keys always carry the suffix).
    throw new ClinikoApiKeyError(
      "This key is missing its region suffix (e.g. \"-au1\"). Generate a new API key in Cliniko (My Info → Manage API keys) and paste it here — new keys include the suffix."
    );
  }
  return { key, shard: match[1] };
}

export interface ClinikoBusiness {
  id: string;
  business_name: string;
}
export interface ClinikoPractitioner {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
}
export interface ClinikoAppointmentType {
  id: string;
  name: string;
  duration_in_minutes: number;
  archived_at: string | null;
}
export interface ClinikoPatient {
  id: string;
  first_name: string;
  last_name: string;
  // Always populated by mapPatient (never left undefined) so consumers don't
  // need defensive `?? []` / `?? null`.
  archived_at: string | null;
  patient_phone_numbers: Array<{ phone_type: string; number: string }>;
}
export interface ClinikoAppointment {
  id: string;
  starts_at: string;
  ends_at: string;
  cancelled_at: string | null;
  deleted_at: string | null;
  // null (not "") when Cliniko omits it — reconciliation filters on updated_at
  // server-side via the q[] query, so the mapped value is informational only.
  updated_at: string | null;
  patient_id?: string;
  practitioner_id?: string;
  appointment_type_id?: string;
  business_id?: string;
  notes?: string | null;
}

/**
 * A resolved, ready-to-use Cliniko integration for one org: the authed client
 * plus the ids the booking/reconcile flows need. Lives here (the leaf client
 * module) so both cliniko-booking and cliniko-reconcile can import it without a
 * module cycle.
 */
export interface ClinikoContext {
  readonly client: ClinikoClient;
  readonly businessId: string;
  readonly integrationId: string;
  // The owning org. Carried here so tenant identity has a single source of
  // truth: reconciliation reads the cursor by integrationId and the mirror set
  // by organizationId, and both must belong to the same integration (SCRUM-491).
  readonly organizationId: string;
}

/**
 * Result of resolving an org's Cliniko integration. The distinction matters at
 * dispatch: `none` means genuinely not connected (fall through to built-in
 * booking), but `error` means a transient DB/decrypt failure — the caller must
 * NOT silently fall through (that would confirm a booking the practice never
 * receives, or cancel locally while the real diary keeps the appointment).
 */
export type ClinikoResolution =
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "ok"; ctx: ClinikoContext };

/** A page-capped list result. `truncated` is true when MAX_PAGES was hit and
 *  more records almost certainly remain unread — the caller must treat the set
 *  as incomplete (e.g. reconciliation must not advance its cursor past it). */
export interface PagedResult<T> {
  items: T[];
  truncated: boolean;
}

interface RequestResult {
  status: number;
  data: Record<string, unknown> | null;
}

function userAgent(): string {
  return `Phondo (${process.env.CLINIKO_CONTACT_EMAIL || "support@phondo.ai"})`;
}

/**
 * Coerce a Cliniko id (JSON number, kept as string to dodge >2^53 overflow) to
 * a string, THROWING on a missing/null id rather than minting the poison
 * strings "undefined"/"null" that would then flow into URL paths and be
 * persisted into crm_patient_links.
 */
function requireId(value: unknown, context: string): string {
  if (value === null || value === undefined || value === "") {
    throw new ClinikoUnavailableError(`cliniko returned a record with no id (${context})`);
  }
  return String(value);
}

export class ClinikoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string; shard: string; timeoutMs?: number }) {
    if (!SHARD_PATTERN.test(opts.shard)) {
      throw new ClinikoApiKeyError("Invalid Cliniko region shard.");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = `https://api.${opts.shard}.cliniko.com/v1`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Perform one request. 2xx resolves ({status, data}); a 404 resolves ONLY
   * when `opts.allow404` is set (getPatient/cancel, where "already gone" is a
   * valid outcome) — otherwise a 404 is a real failure (a stale
   * practitioner/appointment-type id must NOT masquerade as "no availability",
   * and a 404 on a list endpoint must not be read as an empty catalog).
   * Everything else throws the mapped error. GETs retry once on 5xx/network;
   * writes never do (a retried create can double-book).
   */
  private async request(
    method: string,
    pathOrUrl: string,
    opts: { query?: Record<string, string | string[]>; body?: unknown; allow404?: boolean } = {}
  ): Promise<RequestResult> {
    let url: string;
    if (pathOrUrl.startsWith("http")) {
      // Pagination links come from the response body — only ever follow our own host.
      if (!pathOrUrl.startsWith(this.baseUrl)) {
        throw new ClinikoUnavailableError("cliniko returned an unexpected pagination link");
      }
      url = pathOrUrl;
    } else {
      const u = new URL(this.baseUrl + pathOrUrl);
      for (const [k, v] of Object.entries(opts.query || {})) {
        if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(k, item));
        else u.searchParams.set(k, v);
      }
      url = u.toString();
    }

    const isGet = method === "GET";
    const attempts = isGet ? 2 : 1;
    // Keep only the failure KIND — the status code, or a short network reason.
    // Never the raw fetch error (it can embed the request URL / credentials).
    let lastFailure: number | "network" | null = null;
    let networkReason = "network/timeout";

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
            "User-Agent": userAgent(),
            Accept: "application/json",
            ...(opts.body !== undefined && { "Content-Type": "application/json" }),
          },
          ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
          signal: controller.signal,
        });
      } catch (err) {
        // Abort/timeout/network — retryable for GETs only. Capture only the
        // error NAME (safe: "AbortError"/"TypeError"), never the message.
        lastFailure = "network";
        if (err instanceof Error && err.name) networkReason = err.name;
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (res.ok || (res.status === 404 && opts.allow404)) {
        let data: Record<string, unknown> | null = null;
        if (res.status !== 204) {
          try {
            data = (await res.json()) as Record<string, unknown>;
          } catch {
            data = null;
          }
        }
        return { status: res.status, data };
      }

      if (res.status === 401 || res.status === 403) {
        throw new ClinikoAuthError(`cliniko rejected the API key (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        throw new ClinikoRateLimitError(
          "cliniko rate limit reached",
          Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined
        );
      }
      if (res.status === 422) {
        let detail: unknown;
        try {
          detail = await res.json();
        } catch {
          detail = undefined;
        }
        throw new ClinikoValidationError("cliniko rejected the request (HTTP 422)", detail);
      }

      // 404 without allow404, 5xx, and anything unexpected: retry GETs once.
      lastFailure = res.status;
    }

    if (lastFailure === "network") {
      throw new ClinikoUnavailableError(`cliniko request failed (${networkReason})`);
    }
    throw new ClinikoUnavailableError(`cliniko request failed (HTTP ${lastFailure ?? "?"})`);
  }

  /** Fetch every page of a list endpoint, extracting `collectionKey` from each page. */
  private async listAll<T>(path: string, collectionKey: string, query?: Record<string, string | string[]>): Promise<T[]> {
    return (await this.listAllTracked<T>(path, collectionKey, query)).items;
  }

  /**
   * Like listAll, but reports whether the MAX_PAGES cap was hit with more pages
   * still to fetch. Callers that must not silently drop the tail (reconciliation)
   * use this so they can refuse to advance a cursor past an incomplete read.
   */
  private async listAllTracked<T>(path: string, collectionKey: string, query?: Record<string, string | string[]>): Promise<PagedResult<T>> {
    const items: T[] = [];
    let next: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = next
        ? await this.request("GET", next)
        : await this.request("GET", path, { query: { per_page: "100", ...(query || {}) } });
      if (!data) break;
      const pageItems = data[collectionKey];
      if (Array.isArray(pageItems)) items.push(...(pageItems as T[]));
      const links = data.links as { next?: string } | undefined;
      next = links?.next || null;
      if (!next) break;
      // We exhausted the page budget but Cliniko says there's another page.
      if (page === MAX_PAGES - 1) truncated = true;
    }
    return { items, truncated };
  }

  async listBusinesses(): Promise<ClinikoBusiness[]> {
    const raw = await this.listAll<Record<string, unknown>>("/businesses", "businesses");
    return raw.map((b) => ({ id: requireId(b.id, "business"), business_name: String(b.business_name ?? "") }));
  }

  async listPractitioners(businessId?: string): Promise<ClinikoPractitioner[]> {
    // Scope to a business (location) when given — a multi-location account must
    // not import practitioners from the other site.
    const path = businessId ? `/businesses/${encodeURIComponent(businessId)}/practitioners` : "/practitioners";
    const raw = await this.listAll<Record<string, unknown>>(path, "practitioners");
    return raw.map((p) => ({
      id: requireId(p.id, "practitioner"),
      first_name: String(p.first_name ?? ""),
      last_name: String(p.last_name ?? ""),
      active: p.active !== false,
    }));
  }

  async listAppointmentTypes(): Promise<ClinikoAppointmentType[]> {
    const raw = await this.listAll<Record<string, unknown>>("/appointment_types", "appointment_types");
    return raw.map((t) => ({
      id: requireId(t.id, "appointment_type"),
      name: String(t.name ?? ""),
      duration_in_minutes: Number(t.duration_in_minutes) || 30,
      archived_at: (t.archived_at as string | null) ?? null,
    }));
  }

  async availableTimes(businessId: string, practitionerId: string, appointmentTypeId: string, fromDate: string, toDate: string): Promise<string[]> {
    const path = `/businesses/${encodeURIComponent(businessId)}/practitioners/${encodeURIComponent(practitionerId)}/appointment_types/${encodeURIComponent(appointmentTypeId)}/available_times`;
    const raw = await this.listAll<Record<string, unknown>>(path, "available_times", { from: fromDate, to: toDate });
    return raw
      .filter((t) => typeof t.appointment_start === "string" && t.appointment_start)
      .map((t) => t.appointment_start as string);
  }

  async findPatientsByName(firstName: string, lastName: string, opts: { contains?: boolean } = {}): Promise<ClinikoPatient[]> {
    const op = opts.contains ? ":~" : ":=";
    const q: string[] = [];
    if (firstName) q.push(`first_name${op}${firstName}`);
    if (lastName) q.push(`last_name${op}${lastName}`);
    if (q.length === 0) return [];
    const raw = await this.listAll<Record<string, unknown>>("/patients", "patients", { "q[]": q });
    return raw.map((p) => this.mapPatient(p));
  }

  async getPatient(id: string): Promise<ClinikoPatient | null> {
    const { status, data } = await this.request("GET", `/patients/${encodeURIComponent(id)}`, { allow404: true });
    if (status === 404 || !data) return null;
    return this.mapPatient(data);
  }

  async createPatient(p: { firstName: string; lastName: string; phone?: string }): Promise<ClinikoPatient> {
    const { status, data } = await this.request("POST", "/patients", {
      body: {
        first_name: p.firstName,
        last_name: p.lastName,
        ...(p.phone && { patient_phone_numbers: [{ phone_type: "Mobile", number: p.phone }] }),
      },
    });
    if (!data) {
      throw new ClinikoUnavailableError("cliniko createPatient returned no data");
    }
    return this.mapPatient(data);
  }

  async createAppointment(a: {
    businessId: string;
    practitionerId: string;
    appointmentTypeId: string;
    patientId: string;
    startsAtIso: string;
    notes?: string;
  }): Promise<ClinikoAppointment> {
    const { status, data } = await this.request("POST", "/individual_appointments", {
      body: {
        business_id: a.businessId,
        practitioner_id: a.practitionerId,
        appointment_type_id: a.appointmentTypeId,
        patient_id: a.patientId,
        starts_at: a.startsAtIso,
        ...(a.notes && { notes: a.notes }),
      },
    });
    if (!data) {
      throw new ClinikoUnavailableError("cliniko createAppointment returned no data");
    }
    return this.mapAppointment(data);
  }

  /** PATCH …/cancel with the generic "Other" reason. 404 (already gone) resolves. */
  async cancelAppointment(id: string, note?: string): Promise<void> {
    await this.request("PATCH", `/individual_appointments/${encodeURIComponent(id)}/cancel`, {
      body: { cancellation_reason: 50, ...(note && { cancellation_note: note }) },
      allow404: true,
    });
  }

  async updateAppointmentTime(id: string, startsAtIso: string): Promise<ClinikoAppointment> {
    const { status, data } = await this.request("PUT", `/individual_appointments/${encodeURIComponent(id)}`, {
      body: { starts_at: startsAtIso },
      allow404: true,
    });
    if (status === 404 || !data) {
      throw new ClinikoValidationError("cliniko appointment no longer exists");
    }
    return this.mapAppointment(data);
  }

  async getAppointment(id: string): Promise<ClinikoAppointment | null> {
    const { status, data } = await this.request("GET", `/individual_appointments/${encodeURIComponent(id)}`, { allow404: true });
    if (status === 404 || !data) return null;
    return this.mapAppointment(data);
  }

  /**
   * SCRUM-482: appointments changed since `since` (ISO) that start on/after
   * `today` (YYYY-MM-DD), scoped to the connected business/location. Reconciliation
   * uses this to catch practice-side cancels (cancelled_at set) and moves
   * (starts_at changed) without polling the whole diary.
   */
  async listChangedAppointments(params: { since: string; today: string; businessId: string }): Promise<PagedResult<ClinikoAppointment>> {
    const q = [`updated_at:>${params.since}`, `starts_at:>=${params.today}`];
    const path = `/businesses/${encodeURIComponent(params.businessId)}/individual_appointments`;
    // Sort oldest-change-first: if the page cap truncates, it drops the NEWEST
    // records, so the caller can safely advance its cursor to the newest record
    // it DID fetch and re-poll the rest (SCRUM-490).
    const { items, truncated } = await this.listAllTracked<Record<string, unknown>>(path, "individual_appointments", {
      "q[]": q,
      sort: "updated_at",
      order: "asc",
    });
    return { items: items.map((a) => this.mapAppointment(a)), truncated };
  }

  /**
   * Hard-deleted appointments changed since `since`. Cliniko soft-cancels keep
   * cancelled_at and list normally; only true deletes move here. The q[] filter
   * is applied server-side where supported and re-checked client-side so a stale
   * row is never missed.
   */
  async listDeletedAppointments(params: { since: string }): Promise<PagedResult<ClinikoAppointment>> {
    const { items, truncated } = await this.listAllTracked<Record<string, unknown>>(
      "/individual_appointments/deleted",
      "individual_appointments",
      { "q[]": [`deleted_at:>${params.since}`], sort: "deleted_at", order: "asc" }
    );
    const mapped = items
      .map((a) => this.mapAppointment(a))
      .filter((a) => a.deleted_at != null && a.deleted_at > params.since);
    return { items: mapped, truncated };
  }

  private mapPatient(p: Record<string, unknown>): ClinikoPatient {
    return {
      id: requireId(p.id, "patient"),
      first_name: String(p.first_name ?? ""),
      last_name: String(p.last_name ?? ""),
      archived_at: (p.archived_at as string | null) ?? null,
      patient_phone_numbers: Array.isArray(p.patient_phone_numbers)
        ? (p.patient_phone_numbers as Array<{ phone_type: string; number: string }>).map((n) => ({
            phone_type: String(n.phone_type ?? ""),
            number: String(n.number ?? ""),
          }))
        : [],
    };
  }

  private mapAppointment(a: Record<string, unknown>): ClinikoAppointment {
    return {
      id: requireId(a.id, "appointment"),
      starts_at: String(a.starts_at ?? ""),
      ends_at: String(a.ends_at ?? ""),
      cancelled_at: (a.cancelled_at as string | null) ?? null,
      deleted_at: (a.deleted_at as string | null) ?? null,
      updated_at: (a.updated_at as string | null) ?? null,
      patient_id: a.patient_id != null ? String(a.patient_id) : undefined,
      practitioner_id: a.practitioner_id != null ? String(a.practitioner_id) : undefined,
      appointment_type_id: a.appointment_type_id != null ? String(a.appointment_type_id) : undefined,
      business_id: a.business_id != null ? String(a.business_id) : undefined,
      notes: (a.notes as string | null) ?? null,
    };
  }
}
