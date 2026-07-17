const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { calendarToolDefinitions } = require("../services/tool-executor");

// SCRUM-377: the atomic reschedule_appointment tool must be offered to the LLM
// (it's in calendarToolDefinitions, so every scheduling-enabled assistant gets it
// across all pipelines — Gemini, classic, and ConversationRelay).
describe("reschedule_appointment tool definition (SCRUM-377)", () => {
  const def = calendarToolDefinitions.find((t) => t.function?.name === "reschedule_appointment");

  it("is registered as a calendar tool", () => {
    assert.ok(def, "reschedule_appointment must be in calendarToolDefinitions");
    assert.equal(def.type, "function");
  });

  it("requires new_datetime and exposes the identify-the-existing-appointment params", () => {
    const params = def.function.parameters;
    assert.deepEqual(params.required, ["new_datetime"]);
    for (const key of ["phone", "confirmation_code", "current_datetime", "current_date", "new_datetime"]) {
      assert.ok(params.properties[key], `expected param "${key}"`);
    }
  });

  it("description steers the model away from cancel+book (the duplicate-causing pattern)", () => {
    assert.match(def.function.description, /reschedule|move/i);
    assert.match(
      def.function.description,
      /NEVER reschedule or change an appointment by calling cancel_appointment and book_appointment separately/i
    );
  });

  // SCRUM-561: a real call improvised cancel+rebook to change the doctor;
  // round-robin re-assigned the SAME practitioner twice. The machinery
  // (handler → route → resolveRescheduledBooking) already supported
  // practitioner changes — only the model was never told. These pins keep the
  // tool the declared path for practitioner changes.
  it("declares practitioner changes as this tool's job (SCRUM-561)", () => {
    assert.match(def.function.description, /changing the PRACTITIONER/i, "description must cover practitioner changes");
    assert.match(
      def.function.description,
      /To change ONLY the practitioner, pass practitioner_id and set new_datetime to the appointment's CURRENT time/,
      "same-time practitioner-only change instruction missing"
    );
    const prac = def.function.parameters.properties.practitioner_id;
    assert.ok(prac, "practitioner_id param must be declared");
    assert.match(prac.description, /REQUIRED when the caller asks to change the practitioner/i);
    assert.match(prac.description, /PRACTITIONERS ON STAFF/, "must point the model at the staff list for IDs");
    assert.match(prac.description, /Omit to keep the current practitioner/i, "carry-over default must be stated");
  });
});
