import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTACT_METHODS, contactOutcomeSentence, type CustomerContactResult } from "../customer-contact";

// SCRUM-597 (types lens F6): the "let them know?" contract lives on both sides — the
// website's handlers write it, the voice server declares it to the model and reads it
// back. Each side's own tests check only their own copy, so this keep-in-sync guard
// require()s the voice server's modules and checks them against the TS ones.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const vs = (rel: string) => require(path.join(here, "../../../../voice-server/lib", rel));
const ownerTools = vs("owner-tools.js") as { ownerToolDefinitions: Array<{ function: { name: string; parameters: { properties: Record<string, any> } } }> };
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

  it("the voice server's call summary cuts every customer sentence the handlers write, and takes the outcome from data", () => {
    const change = "Cancelled Dr. J. Smith's job on Friday, October 16 at 3:00 PM.";
    const results: Array<[CustomerContactResult, string]> = [
      [{ method: "text", status: "sent" }, " — customer texted"],
      [{ method: "text", status: "not_sent", reason: "texts_paused" }, " — customer not texted"],
      [{ method: "text", status: "not_sent", reason: "rate_limited" }, " — customer not texted"],
      [{ method: "call", status: "not_available", reason: "calls_unavailable" }, " — customer not told"],
      [{ method: "none", status: "not_requested" }, " — customer not told"],
    ];
    for (const [result, tail] of results) {
      const message = change + contactOutcomeSentence(result, "Dr. J. Smith");
      const data = { outcome: "cancelled", customer_contact: result };
      expect(runner.describeOwnerToolCall("owner_cancel_appointment", {}, message, true, data), JSON.stringify(result)).toBe(
        change.replace(/\.$/, "") + tail
      );
    }
  });
});
