import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTACT_METHODS, contactOutcomeSentence, type CustomerContactResult } from "../customer-contact";
import { CALL_PURPOSES, VOICE_CALL_BLOCK_REASONS } from "../customer-call";
import { OWNER_TOOL_NAMES } from "../tool-handlers";

// SCRUM-597 (types lens F6): the "let them know?" contract lives on both sides — the
// website's handlers write it, the voice server declares it to the model and reads it
// back. Each side's own tests check only their own copy, so this keep-in-sync guard
// require()s the voice server's modules and checks them against the TS ones.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vs = (rel: string) => require(path.join(here, "../../../../voice-server/lib", rel));
const ownerTools = vs("owner-tools.js") as {
  ownerToolDefinitions: Array<{ function: { name: string; parameters: { properties: Record<string, any>; required: string[] } } }>;
  OWNER_TOOL_NAMES: readonly string[];
};
const customerCall = vs("customer-call.js") as { CALL_BLOCK_REASONS: readonly string[]; NOTIFY_PURPOSES: readonly string[] };
const runner = vs("owner-tool-runner.js") as {
  describeOwnerToolCall: (name: string, args: object, message: string, successful: boolean, data?: unknown) => string | null;
};

const writeTool = (name: string) => ownerTools.ownerToolDefinitions.find((d) => d.function.name === name)!.function;

describe("website ↔ voice server: the customer-contact contract", () => {
  it("the model is offered exactly the notify_customer values the handlers parse", () => {
    for (const name of ["owner_reschedule_appointment", "owner_cancel_appointment"]) {
      expect(writeTool(name).parameters.properties.notify_customer.enum).toEqual([...CONTACT_METHODS]);
    }
  });

  // Keyed by status: a new status (SCRUM-598's "calling") fails to compile here until
  // its sample and the voice server's wording for it are added (types lens round 2).
  const SAMPLES: { [S in CustomerContactResult["status"]]: Array<[Extract<CustomerContactResult, { status: S }>, string]> } = {
    sent: [[{ method: "text", status: "sent" }, " — customer texted"]],
    not_sent: [
      [{ method: "text", status: "not_sent", reason: "texts_paused" }, " — customer not texted"],
      [{ method: "text", status: "not_sent", reason: "rate_limited" }, " — customer not texted"],
    ],
    calling: [[{ method: "call", status: "calling", callId: "c-1" }, " — calling the customer"]],
    not_placed: [
      [{ method: "call", status: "not_placed", reason: "calls_disabled" }, " — customer not called"],
      [{ method: "call", status: "not_placed", reason: "outside_hours" }, " — customer not called"],
      [{ method: "call", status: "not_placed", reason: "place_unconfirmed" }, " — customer not called"],
    ],
    not_requested: [[{ method: "none", status: "not_requested" }, " — customer not told"]],
  };

  it("the voice server's call summary cuts every customer sentence the handlers write, and takes the outcome from data", () => {
    const change = "Cancelled Dr. J. Smith's job on Friday, October 16 at 3:00 PM.";
    const results = Object.values(SAMPLES).flat() as Array<[CustomerContactResult, string]>;
    for (const [result, tail] of results) {
      const message = change + contactOutcomeSentence(result, "Dr. J. Smith");
      const data = { outcome: "cancelled", customer_contact: result };
      expect(runner.describeOwnerToolCall("owner_cancel_appointment", {}, message, true, data), JSON.stringify(result)).toBe(
        change.replace(/\.$/, "") + tail
      );
    }
  });

  // SCRUM-598: the call's own contract — the voice server's refusals and purposes are
  // the ones the website words, and owner_call_customer is declared with what the route plucks.
  it("both sides know the same call refusals and purposes", () => {
    expect([...VOICE_CALL_BLOCK_REASONS]).toEqual([...customerCall.CALL_BLOCK_REASONS]);
    expect([...CALL_PURPOSES]).toEqual([...customerCall.NOTIFY_PURPOSES]);
  });
  it("the owner tool names match, and owner_call_customer declares exactly the arguments the route reads", () => {
    expect([...OWNER_TOOL_NAMES]).toEqual([...ownerTools.OWNER_TOOL_NAMES]);
    const call = writeTool("owner_call_customer");
    expect(Object.keys(call.parameters.properties).sort()).toEqual(["appointment_id", "confirmed", "note", "purpose"]);
    expect(call.parameters.properties.purpose.enum).toEqual(["confirm", "find_new_time"]);
  });
});
