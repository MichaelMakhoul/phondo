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
    assert.match(def.function.description, /NEVER reschedule by calling cancel_appointment and book_appointment separately/i);
  });
});
