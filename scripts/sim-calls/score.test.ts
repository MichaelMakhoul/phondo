import { describe, expect, it } from "vitest";
import { wrongWeekdayClaims, type TranscriptLine } from "./score";

// SCRUM-594 F5: the simulator's weekday check. The call is Sunday 18 Oct 2026, 2:32 PM Sydney.
const callTime = "2026-10-18T03:32:00.000Z";
const ai = (text: string): TranscriptLine => ({ who: "ai", text, kind: "reply" });
const said = (text: string) => wrongWeekdayClaims({ callTime, transcript: [ai(text)] });

describe("wrongWeekdayClaims", () => {
  it("flags a wrong weekday given for today or tomorrow", () => {
    expect(said("Today's Monday the 18th.")).toEqual(["Today's Monday"]);
    expect(said("Tomorrow is Tuesday, so that works.")).toEqual(["Tomorrow is Tuesday"]);
  });

  it("passes the right weekday", () => {
    expect(said("Today is Sunday, and tomorrow's Monday.")).toEqual([]);
  });

  it("needs \"today is\" or \"today's\": a day named after \"today,\" is not a claim (confirmation review)", () => {
    expect(said("We're closed today, Monday at 9 is free.")).toEqual([]);
    expect(said("Not today, but tomorrow, Monday, works.")).toEqual([]);
  });

  it("reads only the AI's lines, and needs the call's time", () => {
    expect(wrongWeekdayClaims({ callTime, transcript: [{ who: "caller", said: "Today's Monday, right?", heard: "Today's Monday, right?" }] })).toEqual([]);
    expect(wrongWeekdayClaims({ transcript: [ai("Today's Monday.")] })).toEqual([]);
  });
});
