const { describe, it } = require("node:test");
const assert = require("node:assert");

/**
 * SCRUM-594 gate review: a failed blocked_times or practitioners fetch skips the snapshot, as a failed
 * appointments fetch always did. Built anyway, it listed times nobody can take (a blocked day, a
 * practitioner's day off), and a snapshot without practitioners reads as exact to the prompt.
 */
const failing = new Set();

/** Table-keyed PostgREST fake: every filter returns the chain; awaiting it resolves an empty list, or an error for a failing table. */
function makeChain(table) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    lt: () => chain,
    gt: () => chain,
    then: (resolve, reject) =>
      Promise.resolve(failing.has(table) ? { data: null, error: { message: `${table} unavailable` } } : { data: [], error: null }).then(resolve, reject),
  };
  return chain;
}

const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => ({ from: (table) => makeChain(table) }) },
};

const { loadScheduleSnapshot } = require("../lib/call-context");

const OPEN = { open: "09:00", close: "17:00" };
const ORG = {
  timezone: "Australia/Sydney",
  businessHours: { monday: OPEN, tuesday: OPEN, wednesday: OPEN, thursday: OPEN, friday: OPEN, saturday: OPEN, sunday: OPEN },
  defaultAppointmentDuration: 30,
};

/** loadScheduleSnapshot with `tables` failing, console.error silenced and its calls kept. */
async function snapshotWith(...tables) {
  failing.clear();
  for (const t of tables) failing.add(t);
  const realError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  try {
    return { snapshot: await loadScheduleSnapshot("org-1", ORG, []), errors };
  } finally {
    console.error = realError;
    failing.clear();
  }
}

describe("loadScheduleSnapshot: a failed fetch skips the snapshot (SCRUM-594 gate review)", () => {
  it("builds one when every fetch succeeds (no practitioners: flat days)", async () => {
    const { snapshot, errors } = await snapshotWith();
    assert.ok(snapshot, "a snapshot");
    assert.strictEqual(errors.length, 0);
    const days = Object.values(snapshot.slots);
    assert.ok(days.length > 0 && days.every(Array.isArray), "flat days");
  });

  it("skips it when blocked_times fails: a blocked day would be offered", async () => {
    const { snapshot, errors } = await snapshotWith("blocked_times");
    assert.strictEqual(snapshot, null);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(errors[0][1], { organizationId: "org-1", blockedTimesError: { message: "blocked_times unavailable" }, practitionersError: null });
  });

  it("skips it when practitioners fails: their days off would be offered, from a snapshot that reads as exact", async () => {
    const { snapshot, errors } = await snapshotWith("practitioners");
    assert.strictEqual(snapshot, null);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(errors[0][1], { organizationId: "org-1", blockedTimesError: null, practitionersError: { message: "practitioners unavailable" } });
  });

  it("logs both errors, with the org, when both fail", async () => {
    const { snapshot, errors } = await snapshotWith("blocked_times", "practitioners");
    assert.strictEqual(snapshot, null);
    assert.deepStrictEqual(errors[0][1], { organizationId: "org-1", blockedTimesError: { message: "blocked_times unavailable" }, practitionersError: { message: "practitioners unavailable" } });
  });

  it("skips it when appointments fails, as before", async () => {
    const { snapshot } = await snapshotWith("appointments");
    assert.strictEqual(snapshot, null);
  });
});
