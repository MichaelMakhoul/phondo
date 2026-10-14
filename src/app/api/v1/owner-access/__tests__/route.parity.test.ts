import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Settings card and PUT /api/v1/owner-access must accept and refuse exactly
 * the same first-save entries. They share parsePhoneToE164, PIN_REGEX, isWeakPin
 * and PHONE_MAX_LENGTH, but the API also has its own zod schema and the card its
 * own checks, and nothing else proves the two stay in step:
 *   - an entry the card accepts and the API refuses is a Save button that cannot
 *     work (found here: a pasted "Mobile: 0412 345 678 (personal, not the
 *     office)" passed the card and got a generic 400 from a 32-character cap);
 *   - an entry the card refuses and the API accepts is a number or PIN the owner
 *     cannot register from the UI.
 *
 * Every phone is tried with every PIN on a first save, through the card's real
 * validateOwnerLineForm and buildSaveBody and the route's real PUT. The admin
 * client is an in-memory owner_access table that enforces the migration's
 * NOT NULL and CHECK constraints, so an entry the normaliser lets through but
 * the table would refuse shows up as a 500, not a 200.
 */

const E164 = /^\+[1-9][0-9]{7,14}$/;

// What the migration would reject on insert (NOT NULL, then the CHECKs).
function checkRow(r: Record<string, any>) {
  for (const c of ["organization_id", "phone_e164", "pin_hash", "pin_salt", "pin_length"]) {
    if (r[c] === undefined || r[c] === null) return { code: "23502", message: `null value in column "${c}"` };
  }
  if (!E164.test(r.phone_e164)) return { code: "23514", message: "phone check" };
  if (!/^[0-9a-f]{64}$/.test(r.pin_hash)) return { code: "23514", message: "pin_hash check" };
  if (!/^[0-9a-f]{32}$/.test(r.pin_salt)) return { code: "23514", message: "pin_salt check" };
  if (!(r.pin_length >= 4 && r.pin_length <= 8)) return { code: "23514", message: "pin_length check" };
  return null;
}

vi.mock("@/lib/feature-flags", () => ({ isOwnerAssistantUiEnabled: () => true }));
vi.mock("@/lib/security/rate-limiter", () => ({
  rateLimitDistributed: vi.fn(async () => ({ allowed: true, headers: {} })),
}));
vi.mock("@/lib/auth/membership", () => ({
  getPrimaryMembership: vi.fn(async () => ({ organization_id: "org-1", role: "owner" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner-1" } } }) },
    // organizations.country: an Australian org
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { country: "AU" }, error: null }) }),
      }),
    }),
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let upsertRow: Record<string, any> = {};
      const b: any = {
        select: () => b,
        eq: () => b,
        // Every call is a first save: the table is empty.
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: (row: Record<string, any>) => {
          upsertRow = row;
          return b;
        },
        single: async () => {
          const bad = checkRow(upsertRow);
          if (bad) return { data: null, error: bad };
          return {
            data: {
              phone_e164: upsertRow.phone_e164,
              pin_length: upsertRow.pin_length,
              enabled: upsertRow.enabled ?? true,
              last_verified_at: null,
              updated_at: "now",
            },
            error: null,
          };
        },
      };
      return b;
    },
  }),
}));

import { PUT } from "@/app/api/v1/owner-access/route";
import {
  PHONE_MAX_LENGTH,
  buildSaveBody,
  validateOwnerLineForm,
} from "@/lib/owner-assistant/line-form";

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/v1/owner-access", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const AT_CAP = "0412 345 678".padEnd(PHONE_MAX_LENGTH, ".");

const PHONES = [
  "0412 345 678", "0412345678", "+61412345678", " +61412345678 ", "61412345678", "412345678",
  "04", "abc", "+44 7911 123456", "+447911123456", "(02) 9555 1234", "0412-345-678 ext 5",
  "0412 345 678" + " ".repeat(40),
  "Mobile: 0412 345 678 (personal, not the office)", // 47 chars: the normaliser strips the letters
  "+61 4 1 2 3 4 5 6 7 8 .................................",
  // The cap itself, measured on the trimmed value the card sends: both sides accept
  // an entry of exactly PHONE_MAX_LENGTH (also with whitespace around it) and refuse one more.
  AT_CAP,
  `  ${AT_CAP}  `,
  AT_CAP + ".",
];
const PINS = [
  "9753", "805214", "40271958", "1234", "0000", "12", "123456789", "97 53", " 9753", "9753\n",
  "٩٧٥٣", // Arabic-Indic digits
  "９７５３", // full-width digits
  "97.53",
  "9753​", // trailing zero-width space
];

describe("card and API accept and refuse the same first-save entries", () => {
  it.each(PHONES)("phone %j", async (phone) => {
    for (const pin of PINS) {
      const clientOk =
        Object.keys(validateOwnerLineForm({ phone, pin, pinConfirm: pin }, { country: "AU", configured: false })).length === 0;
      const res = await put(buildSaveBody({ phone, pin, enabled: true })); // the body the card really sends
      expect(
        res.status === 200,
        `pin ${JSON.stringify(pin)}: card ${clientOk ? "accepts" : "refuses"}, API answered ${res.status} ${JSON.stringify(
          await res.json().catch(() => null),
        )}`,
      ).toBe(clientOk);
    }
  });
});
