import { describe, expect, it } from "vitest";
import { englishInOtherVoice, renderTranscript, voiceLanguage, wrongWeekdayClaims, type TranscriptLine } from "./score";

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

// Phone test F9: back in English, the caller heard the Spanish voice read English.
describe("englishInOtherVoice and the voice tags", () => {
  const voiced = (text: string, voice?: string): TranscriptLine => ({ who: "ai", text, kind: "reply", voice });

  it("flags English read by another language's voice", () => {
    expect(englishInOtherVoice([voiced("Is there anything else I can help you with today?", "aura-2-selena-es")])).toEqual(["Is there anything else I can help you with today?"]);
  });

  it("passes the language's own words, English in the English voice, and short lines", () => {
    expect(englishInOtherVoice([
      voiced("¿Hay algo más en lo que pueda ayudarle hoy?", "aura-2-selena-es"),
      voiced("Is there anything else I can help you with today?", "aura-2-theia-en"),
      voiced("Is there anything else I can help you with today?"),
      voiced("Sure, Michael.", "aura-2-selena-es"),
      voiced("Is het mogelijk om morgen te komen?", "aura-2-daphne-nl"),
      voiced("We help u graag met de afspraak van morgen.", "aura-2-daphne-nl"), // "we" and "help" are Dutch too
    ])).toEqual([]);
  });

  it("tags a line with the voice's language, never the English voice", () => {
    expect(voiceLanguage("aura-2-selena-es")).toBe("Spanish");
    expect(voiceLanguage("aura-2-uzume-ja")).toBe("Japanese");
    expect(voiceLanguage("aura-2-theia-en")).toBe(null);
    expect(voiceLanguage(undefined)).toBe(null);
    expect(renderTranscript([voiced("Claro.", "aura-2-selena-es"), voiced("Sure.", "aura-2-theia-en")])).toBe("  1 AI [Spanish voice]: Claro.\n  2 AI: Sure.");
  });
});
