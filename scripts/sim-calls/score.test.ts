import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { englishInOtherVoice, otherInEnglishVoice, renderTranscript, scoreCall, SESSION_JUDGE, voiceLanguage, wrongWeekdayClaims, type CallRecord, type TranscriptLine } from "./score";
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
    scenario: S13, persona: PERSONA, run: 1, transcript: [voiced("Sí, hablo español.", "aura-2-selena-es")], toolTrace: [], diary: [], activeAfterTurn: [],
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

  it("phone test F9: fails another language read by the English voice (Spanish, Japanese), and passes English or short lines there", async () => {
    expect(otherInEnglishVoice([voiced("Sí, puedo hablar español con usted.", "aura-2-theia-en")])).toHaveLength(1);
    expect(otherInEnglishVoice([voiced("はい、日本語で大丈夫です。")])).toHaveLength(1);
    expect(otherInEnglishVoice([voiced("Is there anything else I can help you with today?", "aura-2-theia-en"), voiced("Gracias, Michael."), voiced("Sí, puedo hablar español.", "aura-2-selena-es")])).toEqual([]);
    const { checkpoints } = await scoreCall(call({ transcript: [voiced("Sí, hablo español.", "aura-2-selena-es"), voiced("¿Necesita algo más para su cita de hoy?", "aura-2-theia-en")] }), "judge");
    expect(checkpoints[15].verdict).toBe("fail");
    expect(checkpoints[15].evidence).toMatch(/another language read by the English voice/);
  });

  it("a supported language passes only when the AI spoke it in its voice; Japanese may write kana in the Japanese voice", async () => {
    const english = await scoreCall(call({ transcript: [voiced("Sure, I can help you with that today.", "aura-2-theia-en")] }), "judge");
    expect(english.checkpoints[15].verdict).toBe("fail");
    expect(english.checkpoints[15].evidence).toMatch(/^never spoke Spanish \(voices: English\)/);
    const S12 = SCENARIOS.find((s) => s.id === "S12")!;
    const japanese = await scoreCall(call({ scenario: S12, finalLanguage: "ja", transcript: [voiced("はい、日本語で大丈夫です。", "aura-2-uzume-ja")] }), "judge");
    expect(japanese.checkpoints[15].verdict).toBe("pass");
    expect(japanese.checkpoints[15].evidence).toMatch(/^spoke Japanese, in its own voice/);
    const kanaInEnglish = await scoreCall(call({ scenario: S12, transcript: [voiced("はい、日本語で大丈夫です。", "aura-2-uzume-ja"), voiced("ありがとう", "aura-2-theia-en")] }), "judge");
    expect(kanaInEnglish.checkpoints[15].verdict).toBe("fail");
  });
});

// The owner can't top up the API credit: the judge (~40% of a simulated call's cost) is graded in the Claude Code session.
describe("SIM_JUDGE_MODEL=session: the judge's prompt is written out and its grade read back, with no API call", () => {
  const voiced = (text: string, voice?: string): TranscriptLine => ({ who: "ai", text, kind: "reply", voice });
  const S13 = SCENARIOS.find((s) => s.id === "S13")!;
  const record = (): CallRecord => ({
    scenario: S13, persona: PERSONA, run: 1, transcript: [voiced("Sí, hablo español.", "aura-2-selena-es")], toolTrace: [], diary: [], activeAfterTurn: [],
    ending: "end_call", anomalies: [], logs: [], llm: { calls: 0, medianMs: 0, p90Ms: 0 }, turns: 1, languages: ["en", "es"], finalLanguage: "en",
  });
  const files = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-session-judge-"));
    return { dir, prompt: path.join(dir, "S13-run1.judge-prompt.md"), grade: path.join(dir, "S13-run1.judge.json") };
  };

  it("with no grade yet: the prompt is written, the judge's checkpoints wait as na, the deterministic ones stand", async () => {
    const f = files();
    const { checkpoints, summary, pending } = await scoreCall(record(), SESSION_JUDGE, f);
    expect(fs.readFileSync(f.prompt, "utf8")).toMatch(/^# Judge this call[\s\S]*Reply with JSON only[\s\S]*TRANSCRIPT:/);
    expect(checkpoints[3]).toMatchObject({ verdict: "na", evidence: "awaiting the session's grade" });
    expect(checkpoints[15].verdict).toBe("pass");
    expect(summary).toBe("awaiting the session's grade");
    expect(pending).toBe(true);
  });

  const hashIn = (promptFile: string) => /"promptHash": "([0-9a-f]{16})"/.exec(fs.readFileSync(promptFile, "utf8"))?.[1];
  const verdicts = (v: (k: string) => string) => Object.fromEntries(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "14", "15"].map((k) => [k, { verdict: v(k), evidence: "L4" }]));

  it("refuses a grade made against another prompt, or one that names none", async () => {
    const f = files();
    fs.writeFileSync(f.grade, JSON.stringify({ promptHash: "0123456789abcdef", checkpoints: verdicts(() => "pass"), summary: "" }));
    await expect(scoreCall(record(), SESSION_JUDGE, f)).rejects.toThrow(/grades another prompt \(the rubric or the call changed since\)/);
    fs.writeFileSync(f.grade, JSON.stringify({ checkpoints: verdicts(() => "pass"), summary: "" }));
    await expect(scoreCall(record(), SESSION_JUDGE, f)).rejects.toThrow(/grades another prompt/);
  });

  it("names a prompt by its content: the same call alike wherever it is written, a changed call differently", async () => {
    const [a, b, c] = [files(), files(), files()];
    await scoreCall(record(), SESSION_JUDGE, a);
    await scoreCall(record(), SESSION_JUDGE, b);
    await scoreCall({ ...record(), transcript: [voiced("Sí, hablo español. ¿Algo más?", "aura-2-selena-es")] }, SESSION_JUDGE, c);
    expect(hashIn(a.prompt)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashIn(b.prompt)).toBe(hashIn(a.prompt));
    expect(hashIn(c.prompt)).not.toBe(hashIn(a.prompt));
  });

  it("hashes the rubric as well as the call: a rubric change needs new grades", async () => {
    const f = files();
    await scoreCall(record(), SESSION_JUDGE, f);
    const prompt = fs.readFileSync(f.prompt, "utf8");
    const system = prompt.slice(prompt.indexOf("## System\n\n") + "## System\n\n".length, prompt.indexOf("\n\n## Call\n\n"));
    const user = prompt.slice(prompt.indexOf("## Call\n\n") + "## Call\n\n".length).replace(/\n$/, "");
    expect(system).toContain("Score the call on each checkpoint below.");
    expect(hashIn(f.prompt)).toBe(crypto.createHash("sha256").update(`${system}\n${user}`).digest("hex").slice(0, 16));
  });

  it("with the session's grade: read back through the same merge rules", async () => {
    const f = files();
    await scoreCall(record(), SESSION_JUDGE, f); // writes the prompt the grade names
    const grade = { promptHash: hashIn(f.prompt), checkpoints: verdicts((k) => (k === "3" ? "fail" : "pass")), summary: "graded here" };
    fs.writeFileSync(f.grade, JSON.stringify(grade));
    const { checkpoints, summary, pending } = await scoreCall(record(), SESSION_JUDGE, f);
    expect(checkpoints[3]).toMatchObject({ verdict: "fail", source: "judge" });
    expect(summary).toBe("graded here");
    expect(pending).toBe(false);
  });

  it("an API judge is never pending", async () => {
    expect((await scoreCall(record(), "judge")).pending).toBe(false);
  });
});
