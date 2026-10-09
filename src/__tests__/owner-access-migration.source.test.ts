import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/owner-assistant/pin-rules";

// SCRUM-585: migration 00171 is the only thing that keeps pin_hash / pin_salt
// out of an org admin's browser session (the user-bound client reads the table
// through RLS; the column grant is what withholds the secrets), and no database
// is available to run it here, so its security posture is pinned as text — same
// idiom as the other *.source.test.ts files.

const SQL = readFileSync(join(process.cwd(), "supabase/migrations/00171_owner_access.sql"), "utf-8");
const CODE = SQL.replace(/--.*$/gm, ""); // comments can mention pin_hash freely
const SECRET = ["pin_hash", "pin_salt"];

function tableColumns(): string[] {
  const body = CODE.match(/CREATE TABLE IF NOT EXISTS public\.owner_access \(([\s\S]*?)\n\);/);
  expect(body, "CREATE TABLE owner_access not found").not.toBeNull();
  return [...body![1].matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|smallint|boolean|timestamptz)\b/gm)].map((m) => m[1]);
}

describe("00171_owner_access.sql — the PIN hash and salt stay out of every browser session", () => {
  it("enables RLS and revokes the Supabase default grants before granting anything", () => {
    const rls = CODE.indexOf("ALTER TABLE public.owner_access ENABLE ROW LEVEL SECURITY;");
    const revoke = CODE.indexOf("REVOKE ALL ON TABLE public.owner_access FROM PUBLIC, anon, authenticated;");
    const grant = CODE.indexOf("GRANT SELECT (");
    expect(rls).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
  });

  it("grants authenticated column-level SELECT on every column except pin_hash and pin_salt, and nothing else", () => {
    const grants = [...CODE.matchAll(/\bGRANT\b[^;]*;/g)].map((m) => m[0]);
    expect(grants).toHaveLength(1);
    const m = grants[0].match(/^GRANT SELECT \(([^)]*)\)\s+ON public\.owner_access TO authenticated;$/);
    expect(m, `unexpected GRANT shape: ${grants[0]}`).not.toBeNull();
    const granted = m![1].split(",").map((c) => c.trim());
    for (const s of SECRET) expect(granted).not.toContain(s);
    // New non-secret columns must be added to the grant (the file says so); new secret ones must not.
    expect(new Set(granted)).toEqual(new Set(tableColumns().filter((c) => !SECRET.includes(c))));
    expect(granted).toHaveLength(9);
  });

  it("has exactly one policy: SELECT for the org's owners and admins; no client write path", () => {
    const policies = [...CODE.matchAll(/CREATE POLICY[\s\S]*?;/g)].map((m) => m[0]);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatch(/FOR SELECT/);
    expect(policies[0]).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE|ALL)/i);
    expect(policies[0]).toMatch(/role IN \('owner', 'admin'\)/);
    expect(policies[0]).toMatch(/user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it("constrains what the route may store (the DB is the last validator)", () => {
    expect(CODE).toContain("CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$')");
    expect(CODE).toContain("CHECK (pin_hash ~ '^[0-9a-f]{64}$')");
    expect(CODE).toContain("CHECK (pin_salt ~ '^[0-9a-f]{32}$')");
    expect(CODE).toContain("CHECK (pin_length BETWEEN 4 AND 8)");
  });

  it("keeps the pin_length CHECK in step with the PIN length bounds the route and the card enforce", () => {
    // Widening PIN_MAX_LENGTH without a migration would make every longer PIN
    // fail the insert with a 500; narrowing the CHECK would do the same.
    expect(CODE).toContain(`CHECK (pin_length BETWEEN ${PIN_MIN_LENGTH} AND ${PIN_MAX_LENGTH})`);
  });
});
