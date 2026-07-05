const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { CallSession } = require("../call-session");

// SCRUM-506: per-call carry-forward of the caller's OWN identity/verification
// details, reused for the rest of the call so the AI never re-asks. PRIVACY
// CONTRACT (asserted below): in-memory + per-call, wiped at call end, and NEVER
// shared across calls.

describe("SCRUM-506: CallSession.rememberDetails / getCollectedDetails", () => {
  it("accumulates name/phone/email/date_of_birth from lookup_appointment args", () => {
    const s = new CallSession("c1");
    s.rememberDetails("lookup_appointment", {
      name: "Michael Makhoul", phone: "+61400000000",
      email: "m@example.com", date_of_birth: "1990-01-01",
    });
    assert.deepEqual(s.getCollectedDetails(), {
      name: "Michael Makhoul", phone: "+61400000000",
      email: "m@example.com", date_of_birth: "1990-01-01",
    });
  });

  it("last-non-empty wins; an empty/whitespace/absent later value never clears a stored one", () => {
    const s = new CallSession("c2");
    s.rememberDetails("lookup_appointment", { name: "Jon" });
    s.rememberDetails("reschedule_appointment", { name: "John" }); // a correction propagates
    s.rememberDetails("cancel_appointment", { name: "   " });      // whitespace: ignored
    s.rememberDetails("cancel_appointment", {});                   // absent: ignored
    assert.equal(s.getCollectedDetails().name, "John");
  });

  it("trims stored values", () => {
    const s = new CallSession("c3");
    s.rememberDetails("lookup_appointment", { name: "  Jane Roe  " });
    assert.equal(s.getCollectedDetails().name, "Jane Roe");
  });

  it("does NOT populate from book_appointment (attendee may be a THIRD PARTY)", () => {
    const s = new CallSession("c4");
    s.rememberDetails("book_appointment", {
      first_name: "Child", last_name: "Patient", phone: "+61400000000", email: "p@x.com",
    });
    assert.deepEqual(s.getCollectedDetails(), {});
  });

  it("ignores a reschedule's first_name/last_name (the NEW attendee for a rename), keeps the caller's own name", () => {
    const s = new CallSession("c5");
    s.rememberDetails("reschedule_appointment", {
      name: "Caller Name", first_name: "New", last_name: "Attendee",
    });
    const d = s.getCollectedDetails();
    assert.equal(d.name, "Caller Name");
    assert.ok(!("first_name" in d) && !("last_name" in d));
  });

  it("ignores unknown tools and non-object args (no throw)", () => {
    const s = new CallSession("c5b");
    s.rememberDetails("schedule_callback", { caller_name: "Third Party" }); // not in the allowlist
    s.rememberDetails("lookup_appointment", null);
    s.rememberDetails("lookup_appointment", undefined);
    assert.deepEqual(s.getCollectedDetails(), {});
  });

  it("getCollectedDetails returns a COPY (mutating it can't corrupt the live store)", () => {
    const s = new CallSession("c6");
    s.rememberDetails("lookup_appointment", { name: "Ann" });
    const copy = s.getCollectedDetails();
    copy.name = "Mallory";
    assert.equal(s.getCollectedDetails().name, "Ann");
  });

  it("destroy() wipes the store (privacy: nothing survives call end)", () => {
    const s = new CallSession("c7");
    s.rememberDetails("lookup_appointment", { name: "Sam", email: "s@x.com" });
    s.destroy();
    assert.deepEqual(s.getCollectedDetails(), {});
  });

  it("PRIVACY: two separate calls never share details", () => {
    const a = new CallSession("call-A");
    const b = new CallSession("call-B");
    a.rememberDetails("lookup_appointment", { name: "Alice", phone: "+61400000001" });
    // b never collected anything — must be empty, proving per-call isolation.
    assert.deepEqual(b.getCollectedDetails(), {});
    b.rememberDetails("lookup_appointment", { name: "Bob" });
    assert.equal(a.getCollectedDetails().name, "Alice");
    assert.equal(b.getCollectedDetails().name, "Bob");
  });

  it("does NOT restore collectedDetails across a transfer reconnect (restoreFrom ignores it)", () => {
    const s = new CallSession("call-x2");
    // Even if a transfer payload smuggled collectedDetails, restoreFrom never reads it.
    s.restoreFrom({ messages: [], collectedDetails: { name: "Smuggled" } });
    assert.deepEqual(s.getCollectedDetails(), {});
  });
});
