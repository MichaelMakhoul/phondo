const { describe, it } = require("node:test");
const assert = require("node:assert");

/**
 * SCRUM-599 (code lens G1): the schedule snapshot loads every blocked time that OVERLAPS
 * its window, as the website reads them. It used to load only blocks wholly inside the
 * window, so a block already under way, a week off, or a whole day ending at the next
 * midnight dropped out — and the receptionist offered times nobody could take. The fake
 * applies the snapshot's own filters to the rows, so the query is tested by what it keeps.
 */
let blockRows = [];
let blockFilters = [];

/** A PostgREST fake whose blocked_times chain keeps only the rows its range filters let through. */
function makeChain(table) {
  const filters = [];
  const record = (op) => (col, val) => {
    filters.push([op, col, val]);
    return chain;
  };
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gte: record("gte"),
    lte: record("lte"),
    lt: record("lt"),
    gt: record("gt"),
    then: (resolve, reject) => {
      let data = [];
      if (table === "blocked_times") {
        blockFilters = filters;
        const pass = (row, [op, col, val]) => {
          const a = new Date(row[col]).getTime();
          const b = new Date(val).getTime();
          return op === "gte" ? a >= b : op === "lte" ? a <= b : op === "lt" ? a < b : a > b;
        };
        data = blockRows.filter((row) => filters.every((f) => pass(row, f)));
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
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

const { loadScheduleSnapshot, _test } = require("../lib/call-context");

const TZ = "Australia/Sydney";
const OPEN = { open: "09:00", close: "17:00" };
const ORG = {
  timezone: TZ,
  businessHours: { monday: OPEN, tuesday: OPEN, wednesday: OPEN, thursday: OPEN, friday: OPEN, saturday: OPEN, sunday: OPEN },
  defaultAppointmentDuration: 30,
};
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function snapshotWithBlocks(rows) {
  blockRows = rows;
  return loadScheduleSnapshot("org-1", ORG, []);
}

describe("loadScheduleSnapshot: blocks that overlap the window close the times inside it (SCRUM-599)", () => {
  it("asks for every block that overlaps the window — starts before its end, ends after its start", async () => {
    await snapshotWithBlocks([]);
    assert.deepStrictEqual(blockFilters.map(([op, col]) => [op, col]), [["lt", "start_time"], ["gt", "end_time"]]);
  });

  it("a block already under way that runs past the window (two weeks off) closes every day in it", async () => {
    const open = await snapshotWithBlocks([]);
    const dates = Object.keys(open.slots);
    assert.ok(dates.length > 1 && dates.every((d) => open.slots[d].length > 0 || d === dates[0]), "open days have slots");
    const block = { id: "b1", start_time: new Date(Date.now() - DAY).toISOString(), end_time: new Date(Date.now() + 20 * DAY).toISOString(), practitioner_id: null };
    const closed = await snapshotWithBlocks([block]);
    for (const d of dates) assert.deepStrictEqual(closed.slots[d], [], `${d} is blocked`);
  });

  it("a whole day ending at the next midnight, on the window's last day, closes that day and only that day", async () => {
    const open = await snapshotWithBlocks([]);
    const dates = Object.keys(open.slots);
    const last = dates[dates.length - 1];
    const block = {
      id: "b2",
      start_time: _test.localToUtcIso(`${last}T00:00:00`, TZ),
      end_time: _test.localToUtcIso(`${addDays(last, 1)}T00:00:00`, TZ),
      practitioner_id: null,
    };
    const closed = await snapshotWithBlocks([block]);
    assert.deepStrictEqual(closed.slots[last], [], "the last day is blocked");
    assert.deepStrictEqual(closed.slots[dates[dates.length - 2]], open.slots[dates[dates.length - 2]], "the day before is untouched");
  });

  it("a block wholly outside the window is still left out", async () => {
    const open = await snapshotWithBlocks([]);
    const later = { id: "b3", start_time: new Date(Date.now() + 40 * DAY).toISOString(), end_time: new Date(Date.now() + 41 * DAY).toISOString(), practitioner_id: null };
    const snap = await snapshotWithBlocks([later]);
    assert.deepStrictEqual(snap.blockedTimes, []);
    assert.deepStrictEqual(snap.slots, open.slots);
  });
});
