"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fetchBookedNames, bookedNamesForAnalysis, preferBookedName, cleanBookedName } = require("../lib/booked-names");
const { Sentry } = require("../lib/sentry");

// SCRUM-594 (phone test F10): the booking said "Michael Dunn", spelled back and
// confirmed on the call, but the call log said "Michael Gunn". The re-analysis of
// the recording's transcript had heard the spelled "D" as "G".

describe("cleanBookedName", () => {
  it("keeps a plain name; trims and collapses whitespace", () => {
    assert.equal(cleanBookedName("Michael Dunn"), "Michael Dunn");
    assert.equal(cleanBookedName("  Michael \t  Dunn "), "Michael Dunn");
  });

  it("drops control characters and double quotes, so a name can't break out of its prompt line", () => {
    assert.equal(cleanBookedName('Michael "Mick"\nDunn'), "Michael Mick Dunn");
    assert.equal(cleanBookedName("Ann\u0000\u001fLee\u007f"), "Ann Lee");
  });

  it("caps the length at 80 characters, never splitting one in two", () => {
    assert.equal(cleanBookedName("A".repeat(200)), "A".repeat(80));
    assert.equal(cleanBookedName(`${"A".repeat(79)} B`), "A".repeat(79), "no trailing space after the cut");
    const cut = cleanBookedName(`${"A".repeat(79)}😀😀`);
    assert.equal(cut, `${"A".repeat(79)}😀`, "an emoji is one character, kept whole");
    assert.equal(cut.isWellFormed(), true, "half an emoji would fail the JSON a request carries");
  });

  it("anything but a string, or nothing left after cleaning, is empty", () => {
    for (const v of [undefined, null, 42, {}, ["Michael"], '""', "\n\t "]) assert.equal(cleanBookedName(v), "", JSON.stringify(v));
  });
});

/** A Supabase client that answers one appointments query and records it. */
function fakeSupabase({ data = [], error = null, throws = null } = {}) {
  const calls = [];
  const query = {
    select(cols) { calls.push(["select", cols]); return query; },
    eq(col, val) { calls.push(["eq", col, val]); return query; },
    in(col, vals) { calls.push(["in", col, vals]); return query; },
    order(col, opts) { calls.push(["order", col, opts]); return query; },
    limit(n) { calls.push(["limit", n]); return query; },
    then(resolve, reject) {
      if (throws) return Promise.reject(throws).then(resolve, reject);
      return Promise.resolve({ data, error }).then(resolve, reject);
    },
  };
  return {
    calls,
    from(table) { calls.push(["from", table]); return query; },
  };
}

describe("fetchBookedNames (the appointments this call made)", () => {
  it("reads this call's live appointments in this org, oldest first", async () => {
    const supabase = fakeSupabase({ data: [{ attendee_name: "Michael Dunn" }] });
    assert.deepEqual(await fetchBookedNames(supabase, "call-1", "org-1"), ["Michael Dunn"]);
    assert.deepEqual(supabase.calls, [
      ["from", "appointments"],
      ["select", "attendee_name"],
      ["eq", "call_id", "call-1"],
      ["eq", "organization_id", "org-1"],
      ["in", "status", ["confirmed", "pending"]], // a cancelled or moved booking's name is not the caller's final one
      ["order", "created_at", { ascending: true }],
      ["limit", 20],
    ]);
  });

  it("names cleaned, one per name whatever its case (the first spelling stays), unusable ones skipped", async () => {
    const supabase = fakeSupabase({
      data: [
        { attendee_name: "Michael  Dunn" },
        { attendee_name: "michael DUNN" },
        { attendee_name: "" },
        { attendee_name: null },
        null,
        { attendee_name: "Sarah Dunn" },
      ],
    });
    assert.deepEqual(await fetchBookedNames(supabase, "call-1", "org-1"), ["Michael Dunn", "Sarah Dunn"]);
  });

  it("at most 5 names", async () => {
    const supabase = fakeSupabase({ data: Array.from({ length: 8 }, (_, i) => ({ attendee_name: `Person ${i}` })) });
    assert.deepEqual(await fetchBookedNames(supabase, "call-1", "org-1"), ["Person 0", "Person 1", "Person 2", "Person 3", "Person 4"]);
  });

  it("no appointments: no names", async () => {
    assert.deepEqual(await fetchBookedNames(fakeSupabase({ data: [] }), "call-1", "org-1"), []);
    assert.deepEqual(await fetchBookedNames(fakeSupabase({ data: null }), "call-1", "org-1"), []);
  });

  it("without a call id or an org id it asks nothing", async () => {
    for (const [callId, orgId] of [[null, "org-1"], ["call-1", null], [undefined, undefined]]) {
      const supabase = fakeSupabase({ data: [{ attendee_name: "Michael Dunn" }] });
      assert.deepEqual(await fetchBookedNames(supabase, callId, orgId), []);
      assert.equal(supabase.calls.length, 0);
    }
  });

  it("a failed lookup throws, keeping a PostgREST rejection's code", async () => {
    await assert.rejects(fetchBookedNames(fakeSupabase({ error: { message: "permission denied", code: "42501" } }), "call-1", "org-1"), (err) => {
      assert.match(err.message, /appointments lookup failed: permission denied/);
      assert.equal(err.code, "42501");
      return true;
    });
    await assert.rejects(fetchBookedNames(fakeSupabase({ error: { message: "timeout", code: "" } }), "call-1", "org-1"), (err) => !("code" in err));
    await assert.rejects(fetchBookedNames(fakeSupabase({ throws: new TypeError("fetch failed") }), "call-1", "org-1"), /fetch failed/);
  });
});

describe("bookedNamesForAnalysis (never throws; the analysis goes on without names)", () => {
  it("passes the names through", async () => {
    const supabase = fakeSupabase({ data: [{ attendee_name: "Michael Dunn" }] });
    assert.deepEqual(await bookedNamesForAnalysis(() => supabase, "call-1", "org-1", "PostCall"), ["Michael Dunn"]);
  });

  it("a PostgREST rejection fails for every call: it pages at error level with its own reason, and returns no names", async (t) => {
    const captured = [];
    t.mock.method(Sentry, "captureMessage", (msg, level) => captured.push({ msg, level }));
    const tags = {};
    t.mock.method(Sentry, "withScope", (fn) => fn({ setTag: (k, v) => { tags[k] = v; }, setExtras() {}, setLevel() {} }));
    const warned = [];
    t.mock.method(console, "warn", (...a) => warned.push(a.join(" ")));
    const names = await bookedNamesForAnalysis(() => fakeSupabase({ error: { message: 'column "attendee_name" does not exist', code: "42703" } }), "call-1", "org-1", "Retranscribe");
    assert.deepEqual(names, []);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].level, "error");
    assert.match(captured[0].msg, /^\[Retranscribe\] booked-names lookup REJECTED \(42703\): appointments lookup failed: column "attendee_name" does not exist — every call's post-call analysis goes without names$/);
    assert.equal(tags.reason, "booked-names-lookup-rejected");
    assert.equal(tags.service, "voice-server");
    assert.deepEqual(warned, []);
  });

  it("a database that is down, busy or slow, a dropped connection or missing Supabase env is only a warning", async (t) => {
    const captured = [];
    t.mock.method(Sentry, "captureMessage", (...a) => captured.push(a));
    const warned = [];
    t.mock.method(console, "warn", (...a) => warned.push(a.join(" ")));
    // The codes PostgREST and Postgres give a passing failure: a statement timeout, no
    // database or pool connection, the connection and resource classes, a retryable clash.
    const transient = ["57014", "57P01", "PGRST000", "PGRST001", "PGRST002", "PGRST003", "08006", "53300", "40001", "40P01"];
    for (const code of transient) {
      const names = await bookedNamesForAnalysis(() => fakeSupabase({ error: { message: "try again", code } }), "call-1", "org-1", "PostCall");
      assert.deepEqual(names, [], code);
    }
    await bookedNamesForAnalysis(() => fakeSupabase({ throws: new TypeError("fetch failed") }), "call-1", "org-1", "PostCall");
    await bookedNamesForAnalysis(() => { throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); }, "call-1", "org-1", "PostCall");
    assert.deepEqual(captured, [], "nothing pages");
    assert.equal(warned.length, transient.length + 2);
    assert.equal(warned[0], "[PostCall] Booked names unavailable — analysing without them (callId=call-1, code=57014): appointments lookup failed: try again");
    assert.equal(warned.at(-2), "[PostCall] Booked names unavailable — analysing without them (callId=call-1): fetch failed");
    assert.match(warned.at(-1), /\(callId=call-1\): Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY$/);
  });

  it("every other code is a rejection that fails the same way for every call, and pages", async (t) => {
    const levels = [];
    t.mock.method(Sentry, "captureMessage", (_msg, level) => levels.push(level));
    t.mock.method(console, "warn", () => assert.fail("a rejection must not be just a warning"));
    for (const code of ["42703", "42501", "42P01", "22P02", "PGRST204", "PGRST301", "PGRST100"]) {
      assert.deepEqual(await bookedNamesForAnalysis(() => fakeSupabase({ error: { message: "rejected", code } }), "call-1", "org-1", "PostCall"), [], code);
    }
    assert.deepEqual(levels, Array(7).fill("error"));
  });
});

describe("preferBookedName", () => {
  it("F10: a misheard surname gives way to the booking's spelling", () => {
    assert.equal(preferBookedName("Michael Gunn", ["Michael Dunn"]), "Michael Dunn");
  });

  it("first names match whatever their case", () => {
    assert.equal(preferBookedName("MICHAEL gunn", ["Michael Dunn"]), "Michael Dunn");
  });

  it("a near miss is 1 letter off when either surname has 4 letters or fewer", () => {
    assert.equal(preferBookedName("Michael Dune", ["Michael Dunn"]), "Michael Dunn");
    assert.equal(preferBookedName("Michael Gun", ["Michael Dunn"]), "Michael Gun", "2 letters off a 4-letter surname");
    assert.equal(preferBookedName("Michael Gunt", ["Michael Dunn"]), "Michael Gunt", "2 letters off, both 4 letters");
    assert.equal(preferBookedName("Jenny Lee", ["Jenny Lam"]), "Jenny Lee");
    assert.equal(preferBookedName("Michael Li", ["Michael Wu"]), "Michael Li");
    assert.equal(preferBookedName("Jenny Leeds", ["Jenny Lee"]), "Jenny Leeds", "2 off, and one of them is short");
    assert.equal(preferBookedName("Michael Dunne", ["Michael Dunn"]), "Michael Dunn", "1 off still matches");
  });

  it("and 2 letters off when both are longer; 3 is another surname", () => {
    assert.equal(preferBookedName("Tom Jonse", ["Tom Jones"]), "Tom Jones", "5 letters, 2 off");
    assert.equal(preferBookedName("Michael Makool", ["Michael Makhoul"]), "Michael Makhoul", "7 letters, 2 off");
    assert.equal(preferBookedName("Maria Lopez", ["Maria Garcia"]), "Maria Lopez", "a booking for someone else with her first name");
    assert.equal(preferBookedName("Michael Gonzo", ["Michael Dunn"]), "Michael Gonzo");
    assert.equal(preferBookedName("Michael Bunnet", ["Michael Dunn"]), "Michael Bunnet", "exactly 3 letters off");
  });

  it("a first name alone is completed from the booking", () => {
    assert.equal(preferBookedName("Michael", ["Michael Dunn"]), "Michael Dunn");
  });

  it("a different first name is left alone: the booking may be for someone else", () => {
    assert.equal(preferBookedName("Sarah Dunn", ["Michael Dunn"]), "Sarah Dunn");
    assert.equal(preferBookedName("Mike Dunn", ["Michael Dunn"]), "Mike Dunn");
    assert.equal(preferBookedName("Dan Dunn", ["Daniel Dunn"]), "Dan Dunn", "a first name is matched whole, not as a prefix");
  });

  it("with two or more booked names there's no telling which one is the caller", () => {
    assert.equal(preferBookedName("Michael Gunn", ["Michael Dunn", "Sarah Dunn"]), "Michael Gunn");
  });

  it("a one-word booked name never replaces a fuller name", () => {
    assert.equal(preferBookedName("Michael Gunn", ["Michael"]), "Michael Gunn");
    assert.equal(preferBookedName("Michael Li", ["Michael"]), "Michael Li", "a short surname is not 'near' a missing one");
    assert.equal(preferBookedName("Michael J", ["Michael"]), "Michael J", "nor is an initial");
  });

  it("no booked name, or no name from the analysis: unchanged", () => {
    assert.equal(preferBookedName("Michael Gunn", []), "Michael Gunn");
    assert.equal(preferBookedName("Michael Gunn", undefined), "Michael Gunn");
    assert.equal(preferBookedName("Michael Gunn", "Michael Dunn"), "Michael Gunn", "a string is not a list of names");
    assert.equal(preferBookedName(null, ["Michael Dunn"]), null);
    assert.equal(preferBookedName("  ", ["Michael Dunn"]), "  ");
  });

  it("booked names are cleaned before they count", () => {
    assert.equal(preferBookedName("Michael Gunn", ["  Michael\nDunn "]), "Michael Dunn");
    assert.equal(preferBookedName("Michael Gunn", [42, "Michael Dunn", ""]), "Michael Dunn", "only one usable name");
  });

  it("the same name already: unchanged", () => {
    assert.equal(preferBookedName("Michael Dunn", ["Michael Dunn"]), "Michael Dunn");
  });
});
