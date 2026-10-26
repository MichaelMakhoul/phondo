"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
process.env.INTERNAL_API_URL = process.env.INTERNAL_API_URL || "http://localhost:3000";
process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "test-secret";
const ot = require("../lib/owner-tools");
const { _test, calendarToolDefinitions, endCallToolDefinition } = require("../services/tool-executor");
const { buildOwnerPrompt } = require("../lib/owner-prompt");

// SCRUM-587 — the owner tool set is PR B's contract, declared verbatim, flat.
describe("owner tool declarations", () => {
  const byName = Object.fromEntries(ot.ownerToolDefinitions.map((d) => [d.function.name, d.function]));
  it("declares exactly the five owner tools with PR B's parameter names", () => {
    assert.deepEqual(Object.keys(byName).sort(), ["owner_call_customer", "owner_cancel_appointment", "owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment"]);
    assert.deepEqual(byName.owner_list_appointments.parameters.properties.range.enum, ["today", "tomorrow", "this_week", "date"]);
    assert.deepEqual(byName.owner_list_appointments.parameters.required, ["range"]);
    assert.deepEqual(Object.keys(byName.owner_list_messages.parameters.properties), []);
    assert.deepEqual(byName.owner_reschedule_appointment.parameters.required, ["appointment_id", "new_datetime"]);
    assert.deepEqual(byName.owner_cancel_appointment.parameters.required, ["appointment_id"]);
    assert.ok(byName.owner_reschedule_appointment.parameters.properties.new_datetime.description.includes("YYYY-MM-DDTHH:mm"));
  });
  it("declares every parameter PR B reads, and nothing it ignores", () => {
    // tool-call/route.ts plucks exactly these from `arguments` — a renamed key
    // would arrive as undefined and the job would never move.
    assert.deepEqual(Object.keys(byName.owner_list_appointments.parameters.properties).sort(), ["date", "range"]);
    assert.deepEqual(Object.keys(byName.owner_reschedule_appointment.parameters.properties).sort(), ["appointment_id", "confirmed", "new_datetime", "notify_customer"]);
    assert.deepEqual(Object.keys(byName.owner_cancel_appointment.parameters.properties).sort(), ["appointment_id", "confirmed", "notify_customer", "reason"]);
    assert.deepEqual(Object.keys(byName.owner_call_customer.parameters.properties).sort(), ["appointment_id", "confirmed", "earliest_date", "latest_date", "purpose", "time_of_day"]);
  });
  it("SCRUM-598: owner_call_customer — two purposes, the same two-call gate, and never a substitute for notify_customer on a change", () => {
    const t = byName.owner_call_customer;
    assert.deepEqual(t.parameters.properties.purpose.enum, ["confirm", "find_new_time"]);
    assert.deepEqual(t.parameters.required, ["appointment_id", "purpose"]);
    assert.equal(t.parameters.properties.confirmed.type, "boolean");
    assert.ok(t.description.includes("WITHOUT changing it"));
    assert.ok(t.description.includes("use notify_customer \"call\" on that change instead"));
    assert.ok(t.description.includes("First call WITHOUT confirmed: nothing happens"));
    assert.ok(t.description.indexOf("WITHOUT confirmed") < t.description.indexOf("confirmed=true"));
    assert.ok(t.description.includes("calling | needs_confirmation | not_available | not_found | external_calendar — only 'calling' means the call is being placed"));
    // Security lens F2: the window is structured — no free-text field reaches the customer call.
    assert.deepEqual(t.parameters.properties.time_of_day.enum, ["morning", "afternoon", "evening", "any"]);
    assert.ok(t.parameters.properties.earliest_date.description.includes("YYYY-MM-DD"));
    assert.ok(!("note" in t.parameters.properties));
    // Clients lens R2-2/R2-3: only days and a time of day reach the call, and a range has an end.
    assert.ok(t.description.includes("only a date range and a time of day reach the call: anything else the owner asks for (a day to skip, \"after 3\", a particular person) can't be passed on — say so in the read-back"));
    assert.ok(t.parameters.properties.latest_date.description.includes("Set it whenever the owner's words have an end (\"next week\" ends next Sunday"));
    assert.ok(t.parameters.properties.latest_date.description.includes("without it the call may book any day from earliest_date on"));
    assert.ok(ot.OWNER_WRITE_TOOL_NAMES.includes("owner_call_customer"), "the confirmation gate guards it");
    assert.ok(!ot.OWNER_CHANGE_TOOL_NAMES.includes("owner_call_customer"), "it changes no booking");
    assert.deepEqual([...ot.OWNER_CHANGE_TOOL_NAMES], ["owner_reschedule_appointment", "owner_cancel_appointment"]);
  });
  it("SCRUM-597: notify_customer is the enum PR B parses (text | call | none), optional, on both writes", () => {
    for (const tool of [byName.owner_reschedule_appointment, byName.owner_cancel_appointment]) {
      const n = tool.parameters.properties.notify_customer;
      assert.equal(n.type, "string");
      assert.deepEqual(n.enum, ["text", "call", "none"]);
      assert.ok(n.description.includes("one of data.contact_options"));
      assert.ok(n.description.includes("Without it nothing changes."));
      assert.ok(!tool.parameters.required.includes("notify_customer"), "the read-back call goes without it");
      assert.ok(tool.description.includes("data.contact_options"));
      assert.ok(tool.description.includes("notify_customer set to their answer"));
      assert.ok(tool.description.includes("data.customer_contact says whether the customer was actually told."));
      assert.ok(!/customer is NOT notified/i.test(tool.description), "the old fixed claim is gone");
    }
  });
  it("new_datetime asks for org-local wall time with no seconds, offset or Z (PR B honours an offset, so a stray Z moves the job)", () => {
    assert.equal(
      byName.owner_reschedule_appointment.parameters.properties.new_datetime.description,
      "The new start in the business's LOCAL time as YYYY-MM-DDTHH:mm — no seconds, no time-zone offset, no trailing Z."
    );
  });
  it("declares confirmed as a JSON boolean (a string 'true' is needs_confirmation at PR B)", () => {
    assert.equal(byName.owner_reschedule_appointment.parameters.properties.confirmed.type, "boolean");
    assert.equal(byName.owner_cancel_appointment.parameters.properties.confirmed.type, "boolean");
  });
  it("uses flat scalars only — the Gemini schema converter drops nesting", () => {
    for (const def of ot.ownerToolDefinitions) {
      for (const [k, v] of Object.entries(def.function.parameters.properties)) {
        assert.ok(["string", "boolean", "number", "integer"].includes(v.type), `${def.function.name}.${k} type ${v.type}`);
        assert.ok(!("properties" in v) && !("items" in v), `${def.function.name}.${k} must be flat`);
      }
    }
  });
  it("tells the model which outcomes mean the change happened", () => {
    assert.ok(byName.owner_reschedule_appointment.description.includes("rescheduled | needs_confirmation | not_found | slot_taken | invalid_time | rate_limited"));
    assert.ok(byName.owner_cancel_appointment.description.includes("cancelled | needs_confirmation | not_found | rate_limited"));
    assert.deepEqual([...ot.OWNER_SUCCESS_OUTCOMES].sort(), ["calling", "cancelled", "rescheduled"]);
  });
  it("each write describes PR B's two-call flow: WITHOUT confirmed first for the read-back (data.from/to, data.when), confirmed=true only after the owner's yes", () => {
    for (const [tool, times] of [["owner_reschedule_appointment", "data.from and data.to"], ["owner_cancel_appointment", "data.when"]]) {
      const d = byName[tool].description;
      assert.ok(d.includes("First call WITHOUT confirmed: nothing changes, and data.outcome is needs_confirmation with the read-back"), tool);
      assert.ok(d.includes(times), `${tool}: ${times}`);
      assert.ok(d.indexOf("WITHOUT confirmed") < d.indexOf("confirmed=true"), `${tool}: the unconfirmed call comes first`);
      assert.ok(d.includes("get a clear yes, THEN call again with confirmed=true"), tool);
    }
  });
  it("lists PR B's external_calendar outcome too — a business non-success, never a success outcome", () => {
    assert.ok(byName.owner_reschedule_appointment.description.includes("external_calendar"));
    assert.ok(byName.owner_cancel_appointment.description.includes("external_calendar"));
    assert.equal(ot.OWNER_SUCCESS_OUTCOMES.has("external_calendar"), false);
  });
});

describe("owner check_availability declaration", () => {
  const customer = calendarToolDefinitions.find((t) => t.function.name === "check_availability").function;
  const owner = ot.buildOwnerTools().find((t) => t.function.name === "check_availability").function;

  it("is worded for the owner — not the receptionist's caller wording or its PRACTITIONERS ON STAFF list", () => {
    assert.notEqual(owner, customer, "the owner session must not reuse the customer declaration object");
    const text = [owner.description, ...Object.values(owner.parameters.properties).map((p) => p.description)].join(" ");
    assert.match(owner.description, /\bowner\b/);
    assert.doesNotMatch(text, /caller/i);
    assert.doesNotMatch(text, /PRACTITIONERS ON STAFF/);
  });
  it("points service_type_id at the SERVICE TYPES list the owner prompt actually prints, and keeps practitioner_id optional", () => {
    assert.match(owner.parameters.properties.service_type_id.description, /SERVICE TYPES/);
    const prompt = buildOwnerPrompt({ orgName: "Copperline Plumbing", timezone: "Australia/Sydney", todayStr: "2026-10-12", serviceTypes: [{ id: "st-1", name: "Blocked drain", duration_minutes: 60 }] });
    assert.ok(prompt.includes("SERVICE TYPES"), "the label the declaration names must exist in the owner prompt");
    assert.ok(!owner.parameters.required.includes("practitioner_id"));
    assert.equal(owner.parameters.properties.practitioner_id.description, "Optional. Leave this out to see free times across all staff. Never put a name here.");
  });
  it("keeps the customer parameter schema exactly, so tool-executor's handler and PR B's route are unchanged", () => {
    const shape = (fn) => Object.fromEntries(Object.entries(fn.parameters.properties).map(([k, v]) => [k, { type: v.type, enum: v.enum }]));
    assert.deepEqual(shape(owner), shape(customer));
    assert.deepEqual(owner.parameters.required, customer.parameters.required);
    assert.equal(owner.parameters.type, "object");
  });
  it("leaves the customer declaration untouched", () => {
    assert.match(customer.description, /caller/);
    assert.match(customer.parameters.properties.practitioner_id.description, /PRACTITIONERS ON STAFF/);
  });
});

describe("buildOwnerTools", () => {
  it("returns the owner tools plus the three shared read/end tools, nothing customer-facing", () => {
    const names = ot.buildOwnerTools().map((t) => t.function.name);
    assert.deepEqual(names, ["owner_list_appointments", "owner_list_messages", "owner_reschedule_appointment", "owner_cancel_appointment", "owner_call_customer", "get_current_datetime", "check_availability", "end_call"]);
    for (const banned of ["book_appointment", "cancel_appointment", "reschedule_appointment", "transfer_call", "schedule_callback", "lookup_appointment", "update_appointment"]) assert.ok(!names.includes(banned), banned);
    assert.deepEqual([...ot.OWNER_ALLOWED_TOOL_NAMES].sort(), [...names].sort());
  });
  it("reuses the shared get_current_datetime and end_call declarations", () => {
    const tools = ot.buildOwnerTools();
    assert.equal(tools.find((t) => t.function.name === "get_current_datetime"), calendarToolDefinitions.find((t) => t.function.name === "get_current_datetime"));
    assert.equal(tools.find((t) => t.function.name === "end_call"), endCallToolDefinition);
  });
  it("every declaration is an OpenAI-style function with flat scalar parameters", () => {
    for (const t of ot.buildOwnerTools()) {
      assert.equal(t.type, "function");
      assert.equal(typeof t.function.description, "string");
      assert.equal(t.function.parameters.type, "object");
      assert.ok(Array.isArray(t.function.parameters.required), `${t.function.name} required[]`);
      for (const [k, v] of Object.entries(t.function.parameters.properties)) {
        assert.ok(["string", "boolean", "number", "integer"].includes(v.type), `${t.function.name}.${k} type ${v.type}`);
        assert.ok(!("properties" in v) && !("items" in v), `${t.function.name}.${k} must be flat`);
      }
    }
  });
  it("owner names are routable calendar functions and the writes are simulated in test mode", () => {
    for (const n of ot.OWNER_TOOL_NAMES) assert.ok(_test.CALENDAR_FUNCTIONS.includes(n), n);
    for (const n of ot.OWNER_WRITE_TOOL_NAMES) assert.ok(_test.CALENDAR_WRITE_FUNCTIONS.includes(n), n);
    assert.ok(!_test.CALENDAR_WRITE_FUNCTIONS.includes("owner_list_appointments"));
    assert.ok(!_test.CALENDAR_WRITE_FUNCTIONS.includes("owner_list_messages"));
  });
  it("name sets are consistent: writes ⊂ owner tools, shared ∩ owner = ∅", () => {
    for (const n of ot.OWNER_WRITE_TOOL_NAMES) assert.ok(ot.OWNER_TOOL_NAMES.includes(n), n);
    for (const n of ot.OWNER_SHARED_TOOL_NAMES) assert.ok(!ot.OWNER_TOOL_NAMES.includes(n), n);
    assert.deepEqual([...ot.OWNER_SHARED_TOOL_NAMES], ["get_current_datetime", "check_availability", "end_call"]);
  });
});
