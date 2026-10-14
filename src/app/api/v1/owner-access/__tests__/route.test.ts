import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Contract coverage for the owner line route (SCRUM-585, spec §6):
 *   - owner role only (admin/member → 403), dark behind the UI flag (→ 404)
 *   - the PIN is scrypt-hashed with a fresh salt on write and NEVER selected
 *     or returned or logged; PUT without a pin leaves the stored hash alone
 *   - guessable PINs (repeats, runs, the commonest PINs) are refused
 *   - first save needs phone + pin; phone is normalised to E.164 for the org
 *   - writes are rate-limited per org
 *   - every statement is scoped to the caller's org and only the public
 *     columns are ever selected (checked for every test in afterEach)
 * Module-level mutable state; vitest runs a file's tests serially.
 */

const state = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  membership: { organization_id: "org-1", role: "owner" } as { organization_id: string; role: string } | null,
  flagOn: true,
  allowed: true,
  country: "AU",
  countryError: null as { message: string } | null,
  countryThrow: null as unknown,
  existing: null as Record<string, unknown> | null,
  readError: null as { code: string; message: string } | null,
  writeError: null as { code: string; message: string } | null,
}));

const calls = vi.hoisted(() => ({
  tables: [] as string[],
  selects: [] as string[],
  eqs: [] as { op: string; col: string; val: string }[],
  upsert: undefined as Record<string, unknown> | undefined,
  update: undefined as Record<string, unknown> | undefined,
  deletedOrg: undefined as string | undefined,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    // getOrgCountry(): organizations.country
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            if (state.countryThrow) throw state.countryThrow;
            return state.countryError
              ? { data: null, error: state.countryError }
              : { data: { country: state.country }, error: null };
          },
        }),
      }),
    }),
  })),
}));

vi.mock("@/lib/auth/membership", () => ({
  getPrimaryMembership: vi.fn(async () => state.membership),
}));

vi.mock("@/lib/feature-flags", () => ({
  isOwnerAssistantUiEnabled: () => state.flagOn,
}));

vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({
    allowed: state.allowed,
    headers: { "Retry-After": "60" },
  })),
}));

/**
 * Admin client: one chainable builder per from() call.
 *   select(cols).eq().maybeSingle()               → the existing row (or readError)
 *   upsert(payload).select(cols).single()         → first save: a row echoing the payload
 *   update(payload).eq().select(cols).single()    → patch: existing row merged with the payload
 *   delete().eq(col, val)                         → resolves { error } and records the org
 * A failing write carries a Postgres-style `details` string with the failing
 * row in it (hash and salt included), as PostgREST does, so the log tests can
 * prove the route never logs it.
 */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      calls.tables.push(table);
      const builder: Record<string, unknown> = {};
      let op = "read";
      let payload: Record<string, unknown> = {};
      Object.assign(builder, {
        select: (cols: string) => {
          calls.selects.push(cols);
          return builder;
        },
        eq: (col: string, val: string) => {
          calls.eqs.push({ op, col, val });
          if (op === "delete") {
            calls.deletedOrg = val;
            return Promise.resolve({ error: state.writeError });
          }
          return builder;
        },
        maybeSingle: async () => ({ data: state.readError ? null : state.existing, error: state.readError }),
        upsert: (p: Record<string, unknown>) => {
          op = "upsert";
          calls.upsert = p;
          payload = p;
          return builder;
        },
        update: (p: Record<string, unknown>) => {
          op = "update";
          calls.update = p;
          payload = p;
          return builder;
        },
        delete: () => {
          op = "delete";
          return builder;
        },
        single: async () => {
          if (state.writeError) {
            return {
              data: null,
              error: { ...state.writeError, details: `Failing row contains (${JSON.stringify(payload)})` },
            };
          }
          const row = { ...(state.existing ?? {}), ...payload };
          return {
            data: {
              id: "row-1",
              phone_e164: row.phone_e164,
              pin_length: row.pin_length,
              enabled: row.enabled ?? true,
              last_verified_at: null,
              updated_at: "2026-10-09T09:00:00.000Z",
            },
            error: null,
          };
        },
      });
      return builder;
    },
  })),
}));

import { GET, PUT, DELETE } from "@/app/api/v1/owner-access/route";
import { rateLimitDistributed } from "@/lib/security/rate-limiter";
import { verifyPin } from "@/lib/owner-assistant/pin";
import { PIN_FORMAT_MESSAGE } from "@/lib/owner-assistant/pin-rules";
import { PHONE_MAX_LENGTH } from "@/lib/owner-assistant/line-form";

const EXISTING = {
  id: "row-1",
  phone_e164: "+61412345678",
  pin_length: 6,
  enabled: true,
  last_verified_at: null,
  updated_at: "2026-10-01T00:00:00.000Z",
};

// A strong PIN (not a repeat, run or common PIN). The string "9753" appears
// nowhere in the E.164 phone, the ids or the timestamps below, so the leak
// assertions can search a response or a log for it.
const PIN = "9753";

const WEAK_PIN_ERROR = "Choose a PIN that's harder to guess — avoid repeats, runs like 1234, and common PINs.";

function putRequest(body: unknown) {
  return new Request("http://localhost/api/v1/owner-access", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  state.user = { id: "user-1" };
  state.membership = { organization_id: "org-1", role: "owner" };
  state.flagOn = true;
  state.allowed = true;
  state.country = "AU";
  state.countryError = null;
  state.countryThrow = null;
  state.existing = null;
  state.readError = null;
  state.writeError = null;
  calls.tables.length = 0;
  calls.selects.length = 0;
  calls.eqs.length = 0;
  calls.upsert = undefined;
  calls.update = undefined;
  calls.deletedOrg = undefined;
});

afterEach(() => {
  errorSpy.mockRestore();
  // Cross-cutting invariants, every verb: the route only touches owner_access,
  // never reads the secret columns (or `*`) back, and never filters a
  // statement by anything but the caller's own org.
  expect(calls.tables.every((t) => t === "owner_access")).toBe(true);
  expect(calls.selects.join(" ")).not.toMatch(/pin_hash|pin_salt|\*/);
  expect(calls.eqs.every((e) => e.col === "organization_id" && e.val === "org-1")).toBe(true);
});

describe("owner-access gating", () => {
  it("404s on every verb while the UI flag is off, touching nothing", async () => {
    state.flagOn = false;
    expect((await GET()).status).toBe(404);
    expect((await PUT(putRequest({ phone: "0412 345 678", pin: PIN }))).status).toBe(404);
    expect((await DELETE()).status).toBe(404);
    expect(calls.tables).toEqual([]);
    expect(calls.upsert).toBeUndefined();
    expect(calls.deletedOrg).toBeUndefined();
    expect(rateLimitDistributed).not.toHaveBeenCalled();
  });

  it("401s on every verb when there is no user", async () => {
    state.user = null;
    expect((await GET()).status).toBe(401);
    expect((await PUT(putRequest({ enabled: false }))).status).toBe(401);
    expect((await DELETE()).status).toBe(401);
    expect(calls.tables).toEqual([]);
  });

  it("403s admins and members on every verb — owner only", async () => {
    for (const role of ["admin", "member"]) {
      state.membership = { organization_id: "org-1", role };
      expect((await GET()).status).toBe(403);
      expect((await PUT(putRequest({ enabled: false }))).status).toBe(403);
      expect((await DELETE()).status).toBe(403);
    }
    expect(calls.tables).toEqual([]);
    expect(calls.upsert).toBeUndefined();
    expect(calls.update).toBeUndefined();
    expect(calls.deletedOrg).toBeUndefined();
  });

  it("404s on every verb when the user has no organization", async () => {
    state.membership = null;
    expect((await GET()).status).toBe(404);
    expect((await PUT(putRequest({ enabled: false }))).status).toBe(404);
    expect((await DELETE()).status).toBe(404);
    expect(calls.tables).toEqual([]);
  });
});

describe("GET /api/v1/owner-access", () => {
  it("reports configured:false when no row exists", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  it("returns the public fields and never selects or returns the hash or salt", async () => {
    state.existing = EXISTING;
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      configured: true,
      phoneE164: "+61412345678",
      pinLength: 6,
      enabled: true,
      lastVerifiedAt: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(calls.selects.join(" ")).not.toMatch(/pin_hash|pin_salt|\*/);
    expect(calls.eqs).toContainEqual({ op: "read", col: "organization_id", val: "org-1" });
  });

  it("only ever maps the public fields, even if the row handed back more", async () => {
    const hash = "a".repeat(64);
    const salt = "b".repeat(32);
    state.existing = { ...EXISTING, pin_hash: hash, pin_salt: salt, organization_id: "org-1", created_by: "user-1" };
    const res = await GET();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(hash);
    expect(text).not.toContain(salt);
    expect(text).not.toMatch(/pin_hash|pin_salt|pinHash|pinSalt|organization|created/);
  });

  it("500s on a DB read error and logs it", async () => {
    state.readError = { code: "57014", message: "timeout" };
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to load your assistant line" });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("PUT /api/v1/owner-access", () => {
  it("creates the row: E.164 phone, fresh salt, scrypt hash that verifies, pin_length, created_by", async () => {
    const res = await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(res.status).toBe(200);
    // The pre-save read that decides first-save vs patch is scoped to the caller's org too.
    expect(calls.eqs).toContainEqual({ op: "read", col: "organization_id", val: "org-1" });
    expect(calls.upsert).toMatchObject({
      organization_id: "org-1",
      created_by: "user-1",
      phone_e164: "+61412345678",
      pin_length: 4,
    });
    const { pin_salt: salt, pin_hash: hash } = calls.upsert as { pin_salt: string; pin_hash: string };
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // What was stored is exactly what the voice server will check the PIN against.
    expect(verifyPin(PIN, salt, hash)).toBe(true);
    expect(verifyPin("9754", salt, hash)).toBe(false);
    expect(calls.upsert).not.toHaveProperty("pin");
    const json = await res.json();
    expect(json).toMatchObject({ configured: true, phoneE164: "+61412345678", pinLength: 4, enabled: true });
    expect(JSON.stringify(json)).not.toMatch(/pin_hash|pin_salt|pinHash|pinSalt|9753/);
  });

  it("records the PIN's own length, up to 8 digits", async () => {
    const res = await PUT(putRequest({ phone: "0412 345 678", pin: "40271958" }));
    expect(res.status).toBe(200);
    expect(calls.upsert).toMatchObject({ pin_length: 8 });
    expect(await res.json()).toMatchObject({ pinLength: 8 });
  });

  it("uses a different salt on every save", async () => {
    await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    const first = calls.upsert?.pin_salt;
    await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(calls.upsert?.pin_salt).not.toBe(first);
  });

  it("takes the org and author from the session, never from the body", async () => {
    const res = await PUT(
      putRequest({
        phone: "0412 345 678",
        pin: PIN,
        organization_id: "org-evil",
        created_by: "user-evil",
        pin_hash: "x",
        pin_salt: "y",
        last_verified_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    expect(calls.upsert).toMatchObject({ organization_id: "org-1", created_by: "user-1" });
    expect(Object.keys(calls.upsert ?? {}).sort()).toEqual([
      "created_by",
      "organization_id",
      "phone_e164",
      "pin_hash",
      "pin_length",
      "pin_salt",
    ]);
    expect(calls.upsert?.pin_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.upsert?.pin_salt).toMatch(/^[0-9a-f]{32}$/);
  });

  // Postgres checks NOT NULL on the proposed row BEFORE it looks at ON
  // CONFLICT, so upserting a partial row ({organization_id, enabled}) would
  // fail on phone_e164 / pin_hash / pin_salt / pin_length even though the row
  // exists. An existing row is therefore patched with UPDATE, not upserted.
  it("keeps the stored PIN when the patch omits it (UPDATE of just the changed columns)", async () => {
    state.existing = EXISTING;
    const res = await PUT(putRequest({ enabled: false }));
    expect(res.status).toBe(200);
    expect(calls.upsert).toBeUndefined();
    expect(calls.update).toEqual({ enabled: false });
    expect(calls.eqs).toContainEqual({ op: "read", col: "organization_id", val: "org-1" });
    expect(calls.eqs).toContainEqual({ op: "update", col: "organization_id", val: "org-1" });
    expect(await res.json()).toMatchObject({ configured: true, pinLength: 6, enabled: false });
  });

  it("changes only the phone when only a phone is sent", async () => {
    state.existing = EXISTING;
    const res = await PUT(putRequest({ phone: "0499 111 222" }));
    expect(res.status).toBe(200);
    expect(calls.update).toEqual({ phone_e164: "+61499111222" });
    expect(await res.json()).toMatchObject({ phoneE164: "+61499111222", pinLength: 6 });
  });

  it("replaces salt, hash and length together when an existing row gets a new PIN", async () => {
    state.existing = EXISTING;
    const res = await PUT(putRequest({ pin: "40271958" }));
    expect(res.status).toBe(200);
    expect(Object.keys(calls.update ?? {}).sort()).toEqual(["pin_hash", "pin_length", "pin_salt"]);
    const { pin_salt: salt, pin_hash: hash, pin_length: length } = calls.update as {
      pin_salt: string;
      pin_hash: string;
      pin_length: number;
    };
    expect(length).toBe(8);
    expect(verifyPin("40271958", salt, hash)).toBe(true);
    expect(await res.json()).toMatchObject({ phoneE164: "+61412345678", pinLength: 8 });
  });

  it("returns the current state without writing when the patch changes nothing", async () => {
    state.existing = EXISTING;
    const res = await PUT(putRequest({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true, phoneE164: "+61412345678", pinLength: 6 });
    expect(calls.upsert).toBeUndefined();
    expect(calls.update).toBeUndefined();
  });

  it("requires phone AND pin on the first save", async () => {
    const noPin = await PUT(putRequest({ phone: "0412 345 678" }));
    expect(noPin.status).toBe(400);
    expect((await noPin.json()).error).toMatch(/PIN/);
    const noPhone = await PUT(putRequest({ pin: PIN }));
    expect(noPhone.status).toBe(400);
    expect((await noPhone.json()).error).toMatch(/mobile number/);
    const neither = await PUT(putRequest({ enabled: false }));
    expect(neither.status).toBe(400);
    expect(calls.upsert).toBeUndefined();
    expect(calls.update).toBeUndefined();
  });

  it("rejects a malformed PIN", async () => {
    for (const pin of ["12", "123456789", "12ab", "１２３４"]) {
      const res = await PUT(putRequest({ phone: "0412 345 678", pin }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(PIN_FORMAT_MESSAGE);
    }
    expect(calls.upsert).toBeUndefined();
  });

  it("rejects a PIN that is not a string — no coercion", async () => {
    for (const pin of [9753, null, ["9753"], { pin: "9753" }]) {
      const res = await PUT(putRequest({ phone: "0412 345 678", pin }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(PIN_FORMAT_MESSAGE);
    }
    expect(calls.upsert).toBeUndefined();
  });

  // Controller ruling: tradie mobiles are public and caller ID can be spoofed,
  // so the commonest PINs are refused before anything is written.
  describe("weak PINs", () => {
    const WEAK = ["1234", "0000", "4321", "121212", "2580", "12345678", "11111111", "5683"];

    it.each(WEAK)("400s %s on the first save and writes nothing", async (pin) => {
      const res = await PUT(putRequest({ phone: "0412 345 678", pin }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: WEAK_PIN_ERROR });
      expect(calls.upsert).toBeUndefined();
      expect(calls.update).toBeUndefined();
    });

    it.each(WEAK)("400s %s on an existing row and leaves it untouched", async (pin) => {
      state.existing = EXISTING;
      const res = await PUT(putRequest({ pin, enabled: false }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: WEAK_PIN_ERROR });
      expect(calls.upsert).toBeUndefined();
      expect(calls.update).toBeUndefined();
    });

    it("checks the format first: a malformed PIN gets the format error, not the weak one", async () => {
      for (const pin of ["111", "123", "111111111"]) {
        const res = await PUT(putRequest({ phone: "0412 345 678", pin }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(PIN_FORMAT_MESSAGE);
      }
      expect(calls.upsert).toBeUndefined();
    });

    it("accepts strong PINs of every length", async () => {
      for (const pin of ["1739", "805214", "40271958"]) {
        const res = await PUT(putRequest({ phone: "0412 345 678", pin }));
        expect(res.status).toBe(200);
        expect(calls.upsert).toMatchObject({ pin_length: pin.length });
      }
    });
  });

  it("rejects a phone that does not normalise for the org country", async () => {
    const res = await PUT(putRequest({ phone: "12", pin: PIN }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Mobile number/);
    expect(calls.upsert).toBeUndefined();
  });

  // The card refuses an entry past PHONE_MAX_LENGTH with its own message; the
  // API holds the same line, measured on the trimmed value because the card
  // sends phone.trim(). The normaliser keeps only the digits, so a pasted
  // sentence around a real number is a valid entry up to the cap.
  describe("phone length cap", () => {
    const padded = (length: number) => "0412 345 678".padEnd(length, ".");

    it("accepts a pasted sentence around a real number", async () => {
      const res = await PUT(putRequest({ phone: "Mobile: 0412 345 678 (personal, not the office)", pin: PIN }));
      expect(res.status).toBe(200);
      expect(calls.upsert).toMatchObject({ phone_e164: "+61412345678" });
    });

    it("accepts an entry of exactly the cap", async () => {
      const res = await PUT(putRequest({ phone: padded(PHONE_MAX_LENGTH), pin: PIN }));
      expect(res.status).toBe(200);
      expect(calls.upsert).toMatchObject({ phone_e164: "+61412345678" });
    });

    it("refuses an entry one character past the cap and writes nothing", async () => {
      const res = await PUT(putRequest({ phone: padded(PHONE_MAX_LENGTH + 1), pin: PIN }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request." });
      expect(calls.upsert).toBeUndefined();
    });

    it("does not count surrounding whitespace toward the cap", async () => {
      const res = await PUT(putRequest({ phone: `  ${padded(PHONE_MAX_LENGTH)}  `, pin: PIN }));
      expect(res.status).toBe(200);
      expect(calls.upsert).toMatchObject({ phone_e164: "+61412345678" });
    });
  });

  it("validates the phone against the org's own country", async () => {
    state.country = "US";
    const ok = await PUT(putRequest({ phone: "415-555-1234", pin: PIN }));
    expect(ok.status).toBe(200);
    expect(calls.upsert).toMatchObject({ phone_e164: "+14155551234" });
    calls.upsert = undefined;
    // An Australian mobile is not a valid US number.
    const bad = await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Mobile number/);
    expect(calls.upsert).toBeUndefined();
  });

  it("500s without writing when the org's country cannot be resolved", async () => {
    state.countryError = { message: "connection reset" };
    const res = await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(res.status).toBe(500);
    expect(calls.upsert).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("never logs a thrown non-Error value — it could carry anything from the request", async () => {
    state.countryThrow = { echoed: PIN };
    const res = await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PIN);
    expect(calls.upsert).toBeUndefined();
  });

  it.each([
    ["non-JSON text", "nope"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON string", '"1234"'],
  ])("rejects %s as the body", async (_label, body) => {
    // Against an existing row, so a body wrongly read as "{}" would be a
    // silent no-op 200 rather than hiding behind the first-save 400.
    state.existing = EXISTING;
    const res = await PUT(new Request("http://localhost/api/v1/owner-access", { method: "PUT", body }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request." });
    expect(calls.upsert).toBeUndefined();
    expect(calls.update).toBeUndefined();
  });

  it("rejects an enabled flag that is not a boolean — no coercion", async () => {
    state.existing = EXISTING;
    for (const enabled of ["false", 0, null]) {
      const res = await PUT(putRequest({ enabled }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request." });
    }
    expect(calls.update).toBeUndefined();
  });

  it("429s with the limiter's headers when the org is over its write cap", async () => {
    state.allowed = false;
    const res = await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(calls.upsert).toBeUndefined();
  });

  it("rate-limits per org under the owner-access key on the auth profile", async () => {
    await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(rateLimitDistributed).toHaveBeenCalledTimes(1);
    expect(rateLimitDistributed).toHaveBeenCalledWith(expect.anything(), "org-1", "owner-access", "auth");
  });

  it("500s when the existing-row read fails (never guesses first-save rules)", async () => {
    state.readError = { code: "57014", message: "timeout" };
    expect((await PUT(putRequest({ enabled: false }))).status).toBe(500);
    expect(calls.upsert).toBeUndefined();
    expect(calls.update).toBeUndefined();
  });

  it("500s when the upsert fails", async () => {
    state.writeError = { code: "23514", message: "check violation" };
    expect((await PUT(putRequest({ phone: "0412 345 678", pin: PIN }))).status).toBe(500);
  });

  it("500s when the update fails", async () => {
    state.existing = EXISTING;
    state.writeError = { code: "57014", message: "timeout" };
    const res = await PUT(putRequest({ enabled: false }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to save your assistant line" });
  });

  // A failed write's Postgres `details` carries the failing row — hash and
  // salt included — and the request body carries the PIN. The log gets the
  // org, the error code and the error message, nothing else.
  it("logs a failed write by org, code and message only — never the PIN, hash, salt or row", async () => {
    state.writeError = { code: "23514", message: "check violation" };
    const res = await PUT(putRequest({ phone: "0412 345 678", pin: PIN }));
    expect(res.status).toBe(500);
    const { pin_salt: salt, pin_hash: hash } = calls.upsert as { pin_salt: string; pin_hash: string };
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("23514");
    expect(logged).toContain("org-1");
    expect(logged).not.toContain(hash);
    expect(logged).not.toContain(salt);
    expect(logged).not.toContain(PIN);
    expect(logged).not.toContain("Failing row");
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(hash);
    expect(body).not.toContain(PIN);
  });
});

describe("DELETE /api/v1/owner-access", () => {
  it("deletes the org's row and returns 204", async () => {
    const res = await DELETE();
    expect(res.status).toBe(204);
    expect(calls.deletedOrg).toBe("org-1");
  });

  it("429s when rate-limited", async () => {
    state.allowed = false;
    expect((await DELETE()).status).toBe(429);
    expect(calls.deletedOrg).toBeUndefined();
  });

  it("500s when the delete fails", async () => {
    state.writeError = { code: "57014", message: "timeout" };
    expect((await DELETE()).status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
  });
});
