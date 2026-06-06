const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectPhantomAction,
  mostRecentWrite,
  PRIMARY_TOOLS,
  CROSS_TOOLS,
  SCHEDULING_WRITE_TOOLS,
  PRIMARY_TOOL,
  BOOKING_BACKING_TOOLS,
} = require("../lib/action-claim-detector");

const ok = (name) => [{ name, successful: true }];
// Audit entry stamped at a given epoch ms.
const okAt = (name, at) => ({ name, successful: true, at });

describe("detectPhantomAction — booking claims", () => {
  it("flags 'I've booked you in' with no successful tool", () => {
    const r = detectPhantomAction("Great, I've booked you in for Tuesday.", []);
    assert.equal(r?.action, "booking");
    assert.equal(r?.primaryTool, "book_appointment");
  });

  it("clears 'you're all set' when book_appointment succeeded", () => {
    assert.equal(detectPhantomAction("You're all set!", ok("book_appointment")), null);
  });

  it("does NOT count a FAILED book_appointment as backing", () => {
    const r = detectPhantomAction("You're all set!", [{ name: "book_appointment", successful: false }]);
    assert.equal(r?.action, "booking");
  });
});

describe("detectPhantomAction — reschedule claims (SCRUM-381 new detection)", () => {
  it("flags 'I've rescheduled your appointment' with no tool", () => {
    const r = detectPhantomAction("I've rescheduled your appointment to 11am.", []);
    assert.equal(r?.action, "reschedule");
    assert.equal(r?.primaryTool, "reschedule_appointment");
  });

  it("flags 'I've rebooked you' with no tool — the exact reported bug", () => {
    const r = detectPhantomAction("No problem, I've rebooked you for 11.", []);
    assert.equal(r?.action, "reschedule");
  });

  it("flags 'moved your appointment' / 'changed the appointment'", () => {
    assert.equal(detectPhantomAction("I've moved your appointment to Friday.", [])?.action, "reschedule");
    assert.equal(detectPhantomAction("Done — changed the appointment to 2pm.", [])?.action, "reschedule");
  });

  it("flags 'your appointment has been moved' with no tool", () => {
    assert.equal(detectPhantomAction("Your appointment has been moved to Friday.", [])?.action, "reschedule");
  });

  it("clears a reschedule claim when reschedule_appointment succeeded", () => {
    assert.equal(
      detectPhantomAction("I've rescheduled your appointment to 11am.", ok("reschedule_appointment")),
      null
    );
  });

  it("clears a reschedule claim accomplished the legacy way (book_appointment)", () => {
    assert.equal(detectPhantomAction("I've rebooked you for 11.", ok("book_appointment")), null);
  });
});

describe("detectPhantomAction — atomic reschedule must NOT false-positive (the thrash bug)", () => {
  it("'you're all set' after a successful reschedule is CLEAN (no phantom booking)", () => {
    // The core SCRUM-381 false positive: audit has reschedule_appointment, the AI
    // says "you're all set" — the old detector saw no book_appointment and wrongly
    // told the model to re-book → duplicate. Must now be clean.
    assert.equal(detectPhantomAction("You're all set for 11am!", ok("reschedule_appointment")), null);
  });

  it("'I've cancelled the old one and booked the new' is CLEAN after a reschedule", () => {
    assert.equal(
      detectPhantomAction("I've cancelled the old one and booked the new time for you.", ok("reschedule_appointment")),
      null
    );
  });
});

describe("detectPhantomAction — most-recent-write cross satisfaction (SCRUM-381 P1)", () => {
  const NOW = 1_700_000_000_000;
  const min = (n) => NOW - n * 60_000;

  it("an end-of-call recap of a reschedule is CLEAN at ANY elapsed time (no recap false positive)", () => {
    // The reschedule is still the latest write, so "you're all set" said minutes
    // later (end-of-call recap) is backed — NOT flagged. This is the regression a
    // fixed time window would have caused: a 60s window would re-trigger the
    // re-book thrash on a normal reschedule call's closing recap.
    assert.equal(detectPhantomAction("So you're all set for Friday at 11, anything else?", [okAt("reschedule_appointment", min(10))]), null);
  });

  it("a reschedule backs a same-turn 'you're all set'", () => {
    assert.equal(detectPhantomAction("You're all set for 11am!", [okAt("reschedule_appointment", min(0))]), null);
  });

  it("a NEWER successful write supersedes the reschedule → a later unbacked booking claim IS flagged", () => {
    // Reschedule A, then a REAL cancel of a different appointment, then the AI
    // claims a booking that never ran book_appointment. The cancel is now the
    // latest write, so the stale reschedule no longer excuses the booking claim.
    const audit = [okAt("reschedule_appointment", min(5)), okAt("cancel_appointment", min(2))];
    assert.equal(detectPhantomAction("Great, I've booked you a new appointment for Friday.", audit)?.action, "booking");
  });

  it("a NEWER successful write supersedes the reschedule → a later unbacked cancellation claim IS flagged", () => {
    const audit = [okAt("reschedule_appointment", min(5)), okAt("book_appointment", min(1))];
    assert.equal(detectPhantomAction("That's cancelled for you.", audit)?.action, "cancellation");
  });

  it("a PRIMARY tool is untimed — an early real booking still backs a late 'you're all set'", () => {
    // Even after a later reschedule of a different appointment, the real booking
    // means the caller genuinely has an appointment, so the recap is clean.
    const audit = [okAt("book_appointment", min(10)), okAt("reschedule_appointment", min(1))];
    assert.equal(detectPhantomAction("You're all set!", audit), null);
  });

  it("KNOWN RESIDUAL (tracked): a reschedule that is still the latest write excuses an immediate booking claim", () => {
    // A phantom NEW booking right after a reschedule (no intervening write) is
    // indistinguishable from a legit reschedule recap by claim text alone, so it
    // is treated as backed. Accepted trade-off to kill the common recap false
    // positive; the rare true-phantom case is on the follow-up ticket. Asserted
    // so this behaviour is intentional and visible, not an accident.
    assert.equal(detectPhantomAction("I've booked you a new appointment.", [okAt("reschedule_appointment", min(0))]), null);
  });
});

describe("mostRecentWrite", () => {
  const NOW = 1_700_000_000_000;
  it("returns null when there is no successful write", () => {
    assert.equal(mostRecentWrite([]), null);
    assert.equal(mostRecentWrite([{ name: "check_availability", successful: true }]), null);
    assert.equal(mostRecentWrite([{ name: "book_appointment", successful: false }]), null);
  });
  it("returns the write with the latest timestamp", () => {
    const audit = [okAt("reschedule_appointment", NOW - 5000), okAt("cancel_appointment", NOW - 1000)];
    assert.equal(mostRecentWrite(audit), "cancel_appointment");
  });
  it("falls back to array order when timestamps are absent", () => {
    assert.equal(mostRecentWrite([{ name: "book_appointment", successful: true }, { name: "reschedule_appointment", successful: true }]), "reschedule_appointment");
  });
  it("ignores non-write and failed tools", () => {
    const audit = [okAt("reschedule_appointment", NOW - 5000), { name: "cancel_appointment_held", successful: false, at: NOW }, { name: "schedule_callback", successful: true, at: NOW }];
    assert.equal(mostRecentWrite(audit), "reschedule_appointment");
  });
});

describe("detectPhantomAction — cancellation & callback", () => {
  it("flags a cancellation claim with no tool", () => {
    assert.equal(detectPhantomAction("That's cancelled for you.", [])?.action, "cancellation");
  });

  it("clears a cancellation backed by cancel_appointment", () => {
    assert.equal(detectPhantomAction("That's cancelled for you.", ok("cancel_appointment")), null);
  });

  it("flags a callback claim with no tool", () => {
    assert.equal(detectPhantomAction("Someone will call you back shortly.", [])?.action, "callback");
  });

  it("clears a callback backed by schedule_callback", () => {
    assert.equal(detectPhantomAction("Someone will call you back shortly.", ok("schedule_callback")), null);
  });
});

describe("detectPhantomAction — ordering, no-claim, and guards", () => {
  it("returns the FIRST unbacked claim when a turn makes several", () => {
    // reschedule is checked first; if it is unbacked it should win.
    const r = detectPhantomAction("I've rescheduled you and you're all set.", []);
    assert.equal(r?.action, "reschedule");
  });

  it("a backed reschedule + backed booking in one turn is clean", () => {
    assert.equal(
      detectPhantomAction("I've rescheduled you and you're all set.", ok("reschedule_appointment")),
      null
    );
  });

  it("returns null for plain conversation that claims nothing", () => {
    assert.equal(detectPhantomAction("Sure, what day works best for you?", []), null);
    assert.equal(detectPhantomAction("Let me check that for you.", []), null);
  });

  it("does not treat a future-tense offer as a completed action", () => {
    assert.equal(detectPhantomAction("I can move your appointment if you'd like.", []), null);
    assert.equal(detectPhantomAction("Would you like me to book that?", []), null);
  });

  it("is null-safe on bad inputs", () => {
    assert.equal(detectPhantomAction("", []), null);
    assert.equal(detectPhantomAction(null, []), null);
    assert.equal(detectPhantomAction(undefined, []), null);
    // A missing/invalid audit is treated as "no successful tools" → claim is unbacked.
    assert.equal(detectPhantomAction("I've booked you in.", null)?.action, "booking");
    assert.equal(detectPhantomAction("I've booked you in.", undefined)?.action, "booking");
  });
});

describe("invariants", () => {
  it("every action's named primary tool is in its PRIMARY_TOOLS set", () => {
    for (const action of Object.keys(PRIMARY_TOOL)) {
      assert.ok(
        PRIMARY_TOOLS[action].includes(PRIMARY_TOOL[action]),
        `${action}: primary tool ${PRIMARY_TOOL[action]} must be in its PRIMARY_TOOLS set`
      );
    }
  });

  it("an atomic reschedule is the cross tool for booking & cancellation", () => {
    for (const action of ["booking", "cancellation"]) {
      assert.ok(
        CROSS_TOOLS[action].includes("reschedule_appointment"),
        `${action} should be cross-satisfiable by a most-recent reschedule_appointment`
      );
    }
  });

  it("primary and cross tool sets never overlap for an action", () => {
    for (const action of Object.keys(PRIMARY_TOOLS)) {
      const overlap = PRIMARY_TOOLS[action].filter((t) => CROSS_TOOLS[action].includes(t));
      assert.deepEqual(overlap, [], `${action}: a tool must be either primary OR cross, not both`);
    }
  });

  it("every cross tool is itself a scheduling write (so it can be a most-recent write)", () => {
    for (const action of Object.keys(CROSS_TOOLS)) {
      for (const tool of CROSS_TOOLS[action]) {
        assert.ok(
          SCHEDULING_WRITE_TOOLS.includes(tool),
          `${action} cross tool ${tool} must be a SCHEDULING_WRITE_TOOL`
        );
      }
    }
  });

  it("BOOKING_BACKING_TOOLS includes both book and reschedule", () => {
    assert.ok(BOOKING_BACKING_TOOLS.includes("book_appointment"));
    assert.ok(BOOKING_BACKING_TOOLS.includes("reschedule_appointment"));
  });
});
