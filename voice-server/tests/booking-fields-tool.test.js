const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { calendarToolDefinitions } = require("../services/tool-executor");
const { buildSystemPrompt } = require("../lib/prompt-builder");

// SCRUM-617: what a booking needs is each business's own setting (Assistants → Caller Data
// Collection). On 28 Oct the owner turned on Address and Reason for Calling, then rang the
// demo line: the receptionist asked for a first and last name and booked — the tool said
// "Collect first name, last name, and datetime BEFORE calling" and "do NOT ask the caller
// for a phone number" for EVERY business, and had nowhere to put anything else. The booking
// handler now enforces the business's fields (src/lib/calendar/booking-fields.ts); this
// pins what the model is told, on every pipeline (the definitions are shared).

const book = calendarToolDefinitions.find((t) => t.function.name === "book_appointment").function;

describe("book_appointment follows the business's own fields (SCRUM-617)", () => {
  it("no fixed list for every business: what DATA COLLECTION requires for THIS one, the rest in details", () => {
    assert.ok(book.description.includes("BEFORE calling, have the datetime and everything DATA COLLECTION marks as required for THIS business — it differs per business"));
    assert.ok(book.description.includes("pass the other items in details. If this tool answers that something is still missing, ask for exactly that and call again."));
    assert.ok(!book.description.includes("Collect first name, last name, and datetime BEFORE calling"));
  });

  it("a required phone number is the caller's own, read back — never asked for unless the business requires one", () => {
    assert.ok(book.description.includes("when DATA COLLECTION requires a phone number, read that number back and ask if it's the best one to reach them (pass a different one if they give it); otherwise do NOT ask for a phone number."));
    assert.ok(!book.description.includes("do NOT ask the caller for a phone number unless they want to be reached on a DIFFERENT number"));
  });

  it("details is a parameter, and only the datetime and first name are schema-required (a last name is the business's setting)", () => {
    assert.equal(book.parameters.properties.details.type, "string");
    assert.match(book.parameters.properties.details.description, /"Label: value; Label: value" with the labels from DATA COLLECTION/);
    assert.deepEqual(book.parameters.required, ["datetime", "first_name"]);
  });
});

describe("DATA COLLECTION says what a booking needs (SCRUM-617)", () => {
  const organization = { name: "Copperline Plumbing", industry: "home_services", timezone: "Australia/Sydney", businessHours: {}, defaultAppointmentDuration: 60, country: "AU" };
  const prompt = (fields) => buildSystemPrompt({ language: "en", promptConfig: { tone: "friendly", fields, behaviors: {} } }, organization, "", {});
  const RULE = "Before you book, have every required item above — use what the caller already told you (like why they're calling) instead of asking again. book_appointment takes the name in first_name and last_name and every other item in details.";
  const PHONE = "Phone Number: the number they're calling from counts — read it back and ask if it's the best one to reach them; take a different one if they give it.";

  it("the rule follows the field list; a required phone number gets its caller-ID line", () => {
    const p = prompt([
      { id: "first_name", label: "First Name", required: true, verification: "repeat-confirm" },
      { id: "phone_number", label: "Phone Number", required: true, verification: "read-back-digits" },
      { id: "address", label: "Address", required: true, verification: "repeat-confirm" },
      { id: "reason_for_calling", label: "Reason for Calling", required: true, verification: "none" },
    ]);
    assert.ok(p.includes("- Address\n"));
    assert.ok(p.includes("- Reason for Calling\n"));
    assert.ok(p.includes(RULE));
    assert.ok(p.includes(PHONE));
    assert.ok(p.indexOf(RULE) > p.indexOf("- Reason for Calling"), "the rule comes after the fields it's about");
  });

  it("an optional phone number gets no read-back line; no fields at all, no rule", () => {
    const optionalPhone = prompt([{ id: "first_name", label: "First Name", required: true }, { id: "phone_number", label: "Phone Number", required: false }]);
    assert.ok(optionalPhone.includes(RULE));
    assert.ok(!optionalPhone.includes("the number they're calling from counts"));
    assert.ok(!prompt([]).includes("Before you book, have every required item above"));
  });
});
