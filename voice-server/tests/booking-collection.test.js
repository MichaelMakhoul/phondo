const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bookingNeeds, bookingPathSteps } = require("../lib/booking-collection");

// SCRUM-617: Gemini's booking rules come from THIS business's Caller Data Collection fields.

const COPPERLINE = [
  { id: "first_name", label: "First Name", required: true },
  { id: "last_name", label: "Last Name", required: true },
  { id: "phone_number", label: "Phone Number", required: true },
  { id: "email_address", label: "Email Address", required: false },
  { id: "address", label: "Address", required: true },
  { id: "company_name", label: "Company Name", required: false },
  { id: "reason_for_calling", label: "Reason for Calling", required: true },
];

describe("bookingNeeds", () => {
  it("Copperline's fields: a last name, and the address and reason — the name, number and email have their own parameters", () => {
    assert.deepEqual(bookingNeeds(COPPERLINE), { lastName: true, email: false, others: ["Address", "Reason for Calling"] });
  });

  it("a field's description (its choices) rides with its label, flattened to one line", () => {
    assert.deepEqual(bookingNeeds([{ id: "urgency_level", label: "Urgency\nLevel", required: true, description: "Routine, Urgent, or Emergency" }]).others, ["Urgency Level (Routine, Urgent, or Emergency)"]);
  });

  it("a business without a required last name or with a required email says so; optional fields never count", () => {
    assert.deepEqual(bookingNeeds([{ id: "first_name", required: true }, { id: "last_name", required: false }, { id: "email_address", required: true }, { id: "address", required: false }]), { lastName: false, email: true, others: [] });
  });

  it("no fields saved (a legacy assistant): a last name, as before; malformed entries are skipped", () => {
    assert.deepEqual(bookingNeeds(undefined), { lastName: true, email: false, others: [] });
    assert.deepEqual(bookingNeeds([null, "name", { required: true }, { id: "gate_code", required: true }]).others, ["gate code"]);
  });
});

describe("bookingPathSteps", () => {
  it("the steps follow the business, and the rules after them name the right step numbers", () => {
    const withAll = bookingPathSteps(true, ["Address", "Reason for Calling"]);
    assert.match(withAll, /^ {2}1\. Caller says a time works/);
    assert.match(withAll, / {2}3\. You ask for last name \(if not captured\)\n {2}4\. You collect what this business also needs: Address and Reason for Calling \(what the caller already said counts\) — passed in details\n {2}5\. You say a short filler/);
    assert.match(withAll, /BETWEEN step 5 and step 8, you MUST be SILENT/);
    assert.match(withAll, /BEFORE step 7 \(tool result\) arrives/);
    const nameOnly = bookingPathSteps(false, []);
    assert.ok(!nameOnly.includes("last name"));
    assert.ok(!nameOnly.includes("also needs"));
    assert.match(nameOnly, / {2}3\. You say a short filler in the caller's language/);
    assert.match(nameOnly, /BETWEEN step 3 and step 6/);
    assert.match(nameOnly, /BEFORE step 5 \(tool result\)/);
  });
});

describe("server.js: a refusal is never a booking, and a missing-details refusal is never escalated (SCRUM-617)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const handler = fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "calendar", "tool-handlers.ts"), "utf8");

  it("Gemini's ledger and schedule-cache delta need the handler's success (when it gives one) AND the booking words — Cliniko's 'what type?' is success:true and books nothing", () => {
    assert.match(src, /const handlerSaidBooked = \(typeof result === "object" && result !== null && typeof result\.success === "boolean" \? result\.success === true : true\)\n\s*&& \(message\.includes\("confirmed"\) \|\| message\.includes\("booked"\) \|\| message\.includes\("confirmation"\)\);/);
    // run the expression itself on the cases that matter
    const expr = /const handlerSaidBooked = ([\s\S]*?);\n/.exec(src)[1];
    const booked = new Function("result", "message", `return ${expr};`);
    assert.equal(booked({ success: true }, "You're booked for Thursday at 2 pm. Your confirmation code is 123456."), true);
    assert.equal(booked({ success: true }, "Before I check availability, what type of appointment are you after?"), false, "Cliniko's question");
    assert.equal(booked({ success: false }, "Can't book this yet: this business's bookings also need the address."), false);
    assert.equal(booked({ success: false }, "That practitioner is already booked at this time."), false);
    assert.equal(booked("Booked — confirmation 123456", "Booked — confirmation 123456"), true, "a plain-string result: its words decide, as before");
    assert.equal(booked(undefined, "You're booked in."), true, "no success flag: the words, as before");
    assert.match(src, /if \(session && toolCall\.name === "book_appointment" && handlerSaidBooked\) \{\n\s*if \(!session\.confirmedBookings\)/);
    assert.match(src, /if \(toolCall\.name === "book_appointment" && handlerSaidBooked\) \{\n\s*scheduleCache\.applyDelta\(session\.organizationId, "book"/);
    assert.equal((src.match(/toolCall\.name === "book_appointment" && \(message\.includes\("confirmed"\)/g) || []).length, 0, "no booking check reads the words alone any more");
  });

  it("classic needs the handler's success (when it gives one) and the words too", () => {
    assert.match(src, /const bookedOk = session\.bookingGuards\n\s*\? toolResult\?\.success === true && bookedWords\n\s*: \(typeof toolResult\?\.success === "boolean" \? toolResult\.success === true : true\) && bookedWords;/);
  });

  it("the loop cap skips the handler's missing-details refusal — matched by its exact opening — and pages at the third", () => {
    const prefix = "Can't book this yet: this business's bookings also need ";
    assert.ok(handler.includes("`" + prefix), "the handler's refusal opens with it");
    assert.ok(src.includes(`/^Can't book this yet: this business's bookings also need /.test(message)`));
    assert.match(src, /if \(missingDetails && \+\+session\.missingDetailsRefusals === 3\) \{\n\s*console\.error\(`\[ALERT:error\] \[BookingFields\]/);
    assert.match(src, /if \(session && toolCall\.name === "book_appointment" && !missingDetails\) \{/);
    // from the third, the model is told the way out: "none", or a callback
    assert.match(src, /if \(missingDetails && session\.missingDetailsRefusals >= 3\) \{\n\s*bookLoopDirective = ` \(SYSTEM — booking attempt \$\{session\.missingDetailsRefusals\} refused for missing details\. Don't keep asking the same thing: if the caller has none of something, pass "none" for it; if they can't or won't give it, offer to take their details for a callback with schedule_callback instead\.\)`;/);
  });
});
