"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { fetchBookedNames, preferBookedName, cleanBookedName } = require("../lib/booked-names");

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
  it("reads this call's appointments in this org, oldest first", async () => {
    const supabase = fakeSupabase({ data: [{ attendee_name: "Michael Dunn" }] });
    assert.deepEqual(await fetchBookedNames(supabase, "call-1", "org-1"), ["Michael Dunn"]);
    assert.deepEqual(supabase.calls, [
      ["from", "appointments"],
      ["select", "attendee_name"],
      ["eq", "call_id", "call-1"],
      ["eq", "organization_id", "org-1"],
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

  it("a failed lookup throws, so the caller can say so (and go without names)", async () => {
    await assert.rejects(fetchBookedNames(fakeSupabase({ error: { message: "permission denied" } }), "call-1", "org-1"), /appointments lookup failed: permission denied/);
    await assert.rejects(fetchBookedNames(fakeSupabase({ throws: new TypeError("fetch failed") }), "call-1", "org-1"), /fetch failed/);
  });
});

describe("preferBookedName", () => {
  it("F10: a misheard surname gives way to the booking's spelling", () => {
    assert.equal(preferBookedName("Michael Gunn", ["Michael Dunn"]), "Michael Dunn");
  });

  it("first names match whatever their case", () => {
    assert.equal(preferBookedName("MICHAEL gunn", ["Michael Dunn"]), "Michael Dunn");
  });

  it("two letters off is still a near miss; three is another surname", () => {
    assert.equal(preferBookedName("Michael Gun", ["Michael Dunn"]), "Michael Dunn");
    assert.equal(preferBookedName("Michael Dunne", ["Michael Dunn"]), "Michael Dunn");
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
  });

  it("with two or more booked names there's no telling which one is the caller", () => {
    assert.equal(preferBookedName("Michael Gunn", ["Michael Dunn", "Sarah Dunn"]), "Michael Gunn");
  });

  it("a one-word booked name never replaces a fuller name", () => {
    assert.equal(preferBookedName("Michael Gunn", ["Michael"]), "Michael Gunn");
    assert.equal(preferBookedName("Michael Li", ["Michael"]), "Michael Li", "a short surname is not 'near' a missing one");
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
