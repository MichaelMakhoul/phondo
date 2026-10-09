// voice-server/tests/owner-context.test.js
"use strict";
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// What getSupabase() hands out when no client is injected. Installed BEFORE
// owner-context loads so its `getSupabase` binding is this one (the same
// require.cache pattern as answer-mode-sentry.test.js).
const defaultClient = { client: null, error: null, calls: 0 };
const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    getSupabase: () => {
      defaultClient.calls += 1;
      if (defaultClient.error) throw defaultClient.error;
      return defaultClient.client;
    },
  },
};

const { loadOwnerFirstName } = require("../lib/owner-context");

// SCRUM-587 — greeting name lookup is fail-SOFT: any miss → null → "Hi there".
function fakeSupabase({ member, memberError, profile, profileError, throwOn } = {}) {
  const calls = [];
  const selects = [];
  const limits = [];
  return {
    calls,
    selects,
    limits,
    from: (table) => {
      const chain = {
        _filters: [],
        select: (cols) => { selects.push({ table, cols }); return chain; },
        eq: (col, val) => { chain._filters.push([col, val]); return chain; },
        limit: (n) => { limits.push({ table, n }); return chain; },
        maybeSingle: async () => {
          calls.push({ table, filters: chain._filters });
          if (throwOn === table) throw new Error(`${table} exploded`);
          if (table === "org_members") return { data: member ?? null, error: memberError ?? null };
          if (table === "user_profiles") return { data: profile ?? null, error: profileError ?? null };
          return { data: null, error: { message: "unknown table" } };
        },
      };
      return chain;
    },
  };
}

describe("loadOwnerFirstName", () => {
  // The soft-fail paths log on purpose. Every console method is stubbed so the
  // test output stays clean, and so the tests can assert what was (not) logged.
  let spies;
  const logged = () => Object.values(spies).reduce((n, spy) => n + spy.mock.callCount(), 0);
  beforeEach(() => {
    defaultClient.client = null;
    defaultClient.error = null;
    defaultClient.calls = 0;
    spies = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((m) => [m, mock.method(console, m, () => {})]));
  });
  afterEach(() => mock.restoreAll());

  it("returns the first token of the owner's full_name", async () => {
    const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "  Dave   Smith " } });
    assert.equal(await loadOwnerFirstName("org-1", { supabase: sb }), "Dave");
    assert.deepEqual(sb.calls[0], { table: "org_members", filters: [["organization_id", "org-1"], ["role", "owner"]] });
    assert.deepEqual(sb.calls[1], { table: "user_profiles", filters: [["id", "u1"]] });
    assert.equal(sb.calls.length, 2);
  });
  it("takes at most one owner row (maybeSingle errors on several rows)", async () => {
    const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "Dave Smith" } });
    await loadOwnerFirstName("org-1", { supabase: sb });
    assert.deepEqual(sb.limits, [{ table: "org_members", n: 1 }]);
  });
  it("reads only the columns it needs (no email or other profile fields)", async () => {
    const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "Dave Smith" } });
    await loadOwnerFirstName("org-1", { supabase: sb });
    assert.deepEqual(sb.selects, [{ table: "org_members", cols: "user_id" }, { table: "user_profiles", cols: "full_name" }]);
  });
  it("handles a first name that is not ASCII", async () => {
    const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "محمد علي" } });
    assert.equal(await loadOwnerFirstName("org-1", { supabase: sb }), "محمد");
  });
  it("caps absurdly long names", async () => {
    const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "A".repeat(80) } });
    assert.equal((await loadOwnerFirstName("org-1", { supabase: sb })).length, 40);
  });
  it("returns null when there is no owner member, no profile, an empty name, an error or a throw", async () => {
    assert.equal(await loadOwnerFirstName("o", { supabase: fakeSupabase({}) }), null);
    assert.equal(await loadOwnerFirstName("o", { supabase: fakeSupabase({ member: { user_id: "u1" } }) }), null);
    assert.equal(await loadOwnerFirstName("o", { supabase: fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "   " } }) }), null);
    assert.equal(await loadOwnerFirstName("o", { supabase: fakeSupabase({ memberError: { message: "x" } }) }), null);
    assert.equal(await loadOwnerFirstName("o", { supabase: fakeSupabase({ member: { user_id: "u1" }, throwOn: "user_profiles" }) }), null);
  });
  it("returns null for a profile whose name is NULL or not text (full_name is a nullable column)", async () => {
    for (const full_name of [null, 42, {}]) {
      const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name } });
      assert.equal(await loadOwnerFirstName("o", { supabase: sb }), null, JSON.stringify(full_name));
    }
    // A miss, not an exception: if the type guard went, .trim() would throw into the catch, still return null, and warn.
    assert.equal(logged(), 0);
  });
  it("stops after the member lookup when there is no owner or no user_id (user_profiles is never queried)", async () => {
    for (const member of [undefined, {}, { user_id: null }, { user_id: "" }]) {
      const sb = fakeSupabase({ member, profile: { full_name: "Dave Smith" } });
      assert.equal(await loadOwnerFirstName("o", { supabase: sb }), null, JSON.stringify(member));
      assert.deepEqual(sb.calls.map((c) => c.table), ["org_members"]);
    }
  });

  describe("titles", () => {
    const nameOf = (full_name) => loadOwnerFirstName("org-1", { supabase: fakeSupabase({ member: { user_id: "u1" }, profile: { full_name } }) });

    it("skips a leading title and returns the next word", async () => {
      assert.equal(await nameOf("Dr Sarah Jones"), "Sarah");
      assert.equal(await nameOf("Mrs. Brown"), "Brown");
      assert.equal(await nameOf("  Prof   Higgins "), "Higgins");
    });
    it("matches every title case-insensitively, with or without the dot, and keeps the name's own casing", async () => {
      assert.equal(await nameOf("dr. sarah"), "sarah");
      for (const t of ["Dr", "Mr", "Mrs", "Ms", "Miss", "Prof"]) {
        for (const form of [t, `${t}.`, t.toUpperCase(), `${t.toLowerCase()}.`]) assert.equal(await nameOf(`${form} Sarah`), "Sarah", form);
      }
    });
    it("skips stacked titles", async () => {
      assert.equal(await nameOf("Prof Dr Jane Doe"), "Jane");
    });
    it("returns null when only a title is left, so the greeting says 'Hi there'", async () => {
      for (const t of ["Prof", "Dr", "dr.", "MRS", "Ms.", "Miss", "Dr Mr", "  Prof  "]) assert.equal(await nameOf(t), null, t);
    });
    it("keeps a first name that merely starts or ends like a title", async () => {
      assert.equal(await nameOf("Drew Smith"), "Drew");
      // "Amr" is a common Arabic first name; it ends in "mr", so an unanchored title pattern would swallow it.
      for (const n of ["Drake", "Missy", "Mister", "Professor", "Msgr", "Mrs.Smith", "Amr", "Adams", "Williams"]) assert.equal(await nameOf(`${n} Jones`), n, n);
    });
    it("still caps the word after a title at 40 characters", async () => {
      assert.equal(await nameOf(`Dr ${"A".repeat(80)}`), "A".repeat(40));
    });
    it("treats a title with nothing after it as a plain miss: nothing is logged", async () => {
      assert.equal(await nameOf("Prof"), null);
      assert.equal(logged(), 0);
    });
    it("agrees with the owner greeting about what a title is", async () => {
      // The loader and lib/owner-prompt.js each carry the title list; this fails if they drift apart.
      const { buildOwnerGreeting } = require("../lib/owner-prompt");
      const candidates = ["Dr", "Mr", "Mrs", "Ms", "Miss", "Prof", "Mx", "Sir", "Dame", "Rev", "Hon", "Doctor", "Professor", "Mister", "Drew", "Missy", "Amr", "Adams", "Williams"];
      for (const w of candidates) {
        for (const form of [w, `${w}.`, w.toUpperCase(), w.toLowerCase()]) {
          const loaderSkips = (await nameOf(`${form} Sarah`)) === "Sarah";
          const greetingSkips = buildOwnerGreeting(`${form} Sarah`) === "Hi Sarah, what do you need?";
          assert.equal(loaderSkips, greetingSkips, `${form}: the loader and the greeting must agree`);
        }
      }
    });
  });

  describe("logging", () => {
    it("logs nothing on success — the name is personal data", async () => {
      const sb = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "Dave Smith" } });
      assert.equal(await loadOwnerFirstName("org-1", { supabase: sb }), "Dave");
      assert.equal(logged(), 0);
    });
    it("logs nothing for a plain miss (no owner row, no profile, a blank name)", async () => {
      await loadOwnerFirstName("o", { supabase: fakeSupabase({}) });
      await loadOwnerFirstName("o", { supabase: fakeSupabase({ member: { user_id: "u1" } }) });
      await loadOwnerFirstName("o", { supabase: fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "   " } }) });
      assert.equal(logged(), 0);
    });
    it("warns once on an org_members error, with the error message only", async () => {
      const sb = fakeSupabase({ memberError: { message: "permission denied for table org_members", details: "row details" } });
      assert.equal(await loadOwnerFirstName("org-1", { supabase: sb }), null);
      assert.equal(logged(), 1);
      assert.deepEqual(spies.warn.mock.calls[0].arguments, ["[OwnerContext] org_members lookup failed (non-fatal):", "permission denied for table org_members"]);
    });
    it("warns once on a user_profiles error, with the error message only", async () => {
      const sb = fakeSupabase({ member: { user_id: "u1" }, profileError: { message: "permission denied for table user_profiles", details: "row details" } });
      assert.equal(await loadOwnerFirstName("org-1", { supabase: sb }), null);
      assert.equal(logged(), 1);
      assert.deepEqual(spies.warn.mock.calls[0].arguments, ["[OwnerContext] user_profiles lookup failed (non-fatal):", "permission denied for table user_profiles"]);
    });
    it("warns once on a throw, with the error message only", async () => {
      const sb = fakeSupabase({ member: { user_id: "u1" }, throwOn: "user_profiles" });
      assert.equal(await loadOwnerFirstName("org-1", { supabase: sb }), null);
      assert.equal(logged(), 1);
      assert.deepEqual(spies.warn.mock.calls[0].arguments, ["[OwnerContext] loadOwnerFirstName failed (non-fatal):", "user_profiles exploded"]);
    });
  });

  describe("without an injected client", () => {
    it("reads through getSupabase() (the service-role client)", async () => {
      defaultClient.client = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "Dave Smith" } });
      assert.equal(await loadOwnerFirstName("org-1"), "Dave");
      assert.equal(defaultClient.calls, 1);
      assert.deepEqual(defaultClient.client.calls.map((c) => c.table), ["org_members", "user_profiles"]);
    });
    it("prefers an injected client over getSupabase()", async () => {
      defaultClient.client = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "Wrong Client" } });
      const injected = fakeSupabase({ member: { user_id: "u1" }, profile: { full_name: "Dave Smith" } });
      assert.equal(await loadOwnerFirstName("org-1", { supabase: injected }), "Dave");
      assert.equal(defaultClient.calls, 0);
    });
    it("returns null, never throws, when getSupabase() cannot build a client (missing env)", async () => {
      defaultClient.error = new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      assert.equal(await loadOwnerFirstName("org-1"), null);
      assert.equal(logged(), 1);
      assert.deepEqual(spies.warn.mock.calls[0].arguments, ["[OwnerContext] loadOwnerFirstName failed (non-fatal):", "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"]);
    });
  });
});
