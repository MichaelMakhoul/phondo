import { describe, expect, it, vi } from "vitest";
import { englishInOtherVoice, renderTranscript, scoreCall, voiceLanguage, wrongWeekdayClaims, type CallRecord, type TranscriptLine } from "./score";
import { PERSONA, SCENARIOS } from "./scenarios";

// The judge is an LLM call: these tests score only the deterministic side, so the judge passes everything.
vi.mock("./anthropic", () => ({
  claudeText: async () => JSON.stringify({ checkpoints: Object.fromEntries(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "14", "15"].map((k) => [k, { verdict: "pass", evidence: "judge" }])), summary: "" }),
}));

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

// Phone test F9 (test review): the deterministic checkpoint 15 — the threshold, every voice, the way back.
describe("checkpoint 15: English in another language's voice, and the way back to English", () => {
  const voiced = (text: string, voice?: string): TranscriptLine => ({ who: "ai", text, kind: "reply", voice });
  const S13 = SCENARIOS.find((s) => s.id === "S13")!;
  const call = (o: Partial<CallRecord>): CallRecord => ({
    scenario: S13, persona: PERSONA, run: 1, transcript: [], toolTrace: [], diary: [], activeAfterTurn: [],
    ending: "end_call", anomalies: [], logs: [], llm: { calls: 0, medianMs: 0, p90Ms: 0 }, turns: 1,
    languages: ["en", "es"], finalLanguage: "en", ...o,
  });

  it("three English-only words in another language's voice are English; two are not (curly apostrophes too)", () => {
    expect(englishInOtherVoice([voiced("Thank you for calling.", "aura-2-selena-es")])).toEqual(["Thank you for calling."]);
    expect(englishInOtherVoice([voiced("Thank you, Michael.", "aura-2-selena-es")])).toEqual([]);
    expect(englishInOtherVoice([voiced("It’s fine, I’m sure you’re right.", "aura-2-selena-es")])).toHaveLength(1);
  });

  it("every language voice of the line is tagged with its language", () => {
    for (const [voice, name] of [["aura-2-selena-es", "Spanish"], ["aura-2-agathe-fr", "French"], ["aura-2-elara-de", "German"], ["aura-2-cinzia-it", "Italian"], ["aura-2-daphne-nl", "Dutch"], ["aura-2-uzume-ja", "Japanese"]]) {
      expect(voiceLanguage(voice)).toBe(name);
    }
  });

  it("S13 fails when the line stayed in Spanish after the caller went back to English", async () => {
    const { checkpoints } = await scoreCall(call({ finalLanguage: "es" }), "judge");
    expect(checkpoints[15].verdict).toBe("fail");
    expect(checkpoints[15].evidence).toMatch(/went back to English, the line stayed in es/);
  });

  it("S13 passes when the call ended in English; a scenario that never goes back may end in Spanish", async () => {
    expect((await scoreCall(call({ finalLanguage: "en" }), "judge")).checkpoints[15].verdict).toBe("pass");
    expect((await scoreCall(call({ finalLanguage: undefined }), "judge")).checkpoints[15].verdict).toBe("pass");
    const staysSpanish = { ...S13, expect: { ...S13.expect, endsInEnglish: undefined } };
    expect((await scoreCall(call({ scenario: staysSpanish, finalLanguage: "es" }), "judge")).checkpoints[15].verdict).toBe("pass");
  });

  it("fails English read by the Spanish voice, even when the call ended in English", async () => {
    const { checkpoints } = await scoreCall(call({ transcript: [voiced("Is there anything else I can help you with today?", "aura-2-selena-es")] }), "judge");
    expect(checkpoints[15].verdict).toBe("fail");
    expect(checkpoints[15].evidence).toMatch(/English read by another language's voice/);
  });
});
