import { describe, it, expect } from "vitest";
import { serviceTypeQuestion, isServiceTypeQuestion } from "../service-type-question";

// SCRUM-586: the "which type?" reply both availability paths (built-in and Cliniko)
// give when no appointment type was chosen. One builder, so the owner assistant can
// tell this clarification apart from a list of times.

describe("serviceTypeQuestion", () => {
  it("asks for the type, lists the org's types and tells the model to ask the caller (wording pinned)", () => {
    expect(serviceTypeQuestion("- Check-up (30 min)\n- Filling (45 min)")).toBe(
      "Before I check availability, what type of appointment would you like to book?\n\n" +
        "Available appointment types:\n- Check-up (30 min)\n- Filling (45 min)\n\n" +
        "Please ask the caller which type they'd like to book."
    );
  });
});

describe("isServiceTypeQuestion", () => {
  it("recognises the clarification and nothing else", () => {
    expect(isServiceTypeQuestion(serviceTypeQuestion("- Check-up (30 min)"))).toBe(true);
    expect(isServiceTypeQuestion("On Friday, October 16, I have 2 available slots — 1:00 PM and 3:00 PM.")).toBe(false);
    expect(isServiceTypeQuestion("I don't have any openings on Saturday, October 17.")).toBe(false);
    expect(isServiceTypeQuestion("")).toBe(false);
  });
});
