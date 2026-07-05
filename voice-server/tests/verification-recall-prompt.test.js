const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildSchedulingSection } = require("../lib/prompt-builder");

// SCRUM-511: on the Gemini pipeline, after reschedule_appointment returned the
// "confirm the name on the booking for security" prompt, the model asked the
// caller for the name and then FAILED to re-call the tool — it drifted to
// end_call (blocked by the hallucination guard) and the reschedule never
// happened. Grok handled the identical flow. The scheduling section (which
// carries the verification instructions) must now spell out that the security
// reply means "call the tool again WITH the detail", not "task finished".

const ORG = {
  timezone: "Australia/Sydney",
  businessHours: { friday: { open: "09:00", close: "17:00" } },
  appointment_verification_fields: { fields: ["name", "phone"], method: "details_only" },
};

function section() {
  return buildSchedulingSection(
    "Australia/Sydney",
    ORG.businessHours,
    30, // defaultAppointmentDuration
    true, // calendarEnabled
    [], // serviceTypes
    {}, // options
    ORG,
  );
}

describe("SCRUM-511: verification re-call directive", () => {
  it("tells the model the security reply means re-call the tool, not task-done", () => {
    const s = section();
    assert.match(s, /COMPLETING A CHANGE AFTER A SECURITY CHECK/);
    assert.match(s, /CALL THE SAME TOOL AGAIN/);
    // reschedule_appointment appears ONLY in this directive (the SCHEDULING
    // TOOLS list omits it), so it uniquely anchors the directive's presence.
    assert.match(s, /reschedule_appointment/);
    // Must block ending the call before the tool confirms success.
    assert.match(s, /do NOT call end_call until the tool returns a message confirming/i);
    // Give-up path (review MEDIUM): a "details DON'T match" REFUSAL must route to
    // a callback, NOT another re-call loop — the exact hard-name (STT) dead-end.
    assert.match(s, /details DON'T match/i);
    assert.match(s, /do NOT keep re-calling/i);
    assert.match(s, /schedule_callback/);
  });

  it("still forbids revealing details before verification (no regression)", () => {
    assert.match(section(), /NEVER reveal appointment details until verification succeeds/);
  });

  it("does not emit the directive when scheduling is off (gated on hasScheduling)", () => {
    // calendarEnabled=false + no serviceTypes → the message-taking branch, which
    // must NOT leak the whole verification/change block.
    const noSched = buildSchedulingSection("Australia/Sydney", ORG.businessHours, 30, false, [], {}, ORG);
    assert.doesNotMatch(noSched, /COMPLETING A CHANGE AFTER A SECURITY CHECK/);
  });
});
