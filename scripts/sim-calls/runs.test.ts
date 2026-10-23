import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { assertFreshRunDir, loadRecords, scoreRecord, sessionJudgeFiles } from "./runs";
import { SESSION_JUDGE, type CallRecord } from "./score";
import { PERSONA, SCENARIOS } from "./scenarios";

// SCRUM-594: a run directory's saved calls, and how each one is scored (the run, and SIM_RESCORE).
const S2 = SCENARIOS.find((s) => s.id === "S2")!;
const record = (run: number, extra: Partial<CallRecord> = {}): CallRecord => ({
  scenario: S2, persona: PERSONA, run, transcript: [{ who: "ai", text: "Hi, you've reached the plumber.", kind: "reply" }], toolTrace: [], diary: [], activeAfterTurn: [],
  ending: "end_call", anomalies: [], logs: [], llm: { calls: 0, medianMs: 0, p90Ms: 0 }, turns: 1, ...extra,
});
const runDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-runs-"));
  fs.mkdirSync(path.join(dir, "runs"));
  return dir;
};
const grade = (verdict: string) =>
  JSON.stringify({ checkpoints: Object.fromEntries(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "14", "15"].map((k) => [k, { verdict, evidence: "L1" }])), summary: "graded" });

describe("assertFreshRunDir", () => {
  it("accepts a new directory, or one whose runs/ is empty", () => {
    expect(() => assertFreshRunDir(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sim-runs-")), "new"))).not.toThrow();
    expect(() => assertFreshRunDir(runDir())).not.toThrow();
  });

  it("refuses a directory that already holds runs: an old grade would score a new call", () => {
    const dir = runDir();
    fs.writeFileSync(path.join(dir, "runs", "S2-run1.judge.json"), grade("pass"));
    expect(() => assertFreshRunDir(dir)).toThrow(/already holds runs/);
  });
});

describe("loadRecords", () => {
  it("reads the call records and skips the session's grades beside them", () => {
    const dir = runDir();
    fs.writeFileSync(path.join(dir, "runs", "S2-run1.json"), JSON.stringify(record(1)));
    fs.writeFileSync(path.join(dir, "runs", "S2-run1.judge.json"), grade("pass"));
    fs.writeFileSync(path.join(dir, "runs", "S2-run1.md"), "# S2 run 1");
    expect(loadRecords(dir).map((r) => `${r.scenario.id} ${r.run}`)).toEqual(["S2 1"]);
  });

  it("refuses a file that isn't a call record, and a directory with no records", () => {
    const dir = runDir();
    fs.writeFileSync(path.join(dir, "runs", "notes.json"), JSON.stringify({ checkpoints: {} }));
    expect(() => loadRecords(dir)).toThrow("sim: runs/notes.json is not a call record");
    expect(() => loadRecords(runDir())).toThrow(/no saved records/);
  });
});

describe("scoreRecord", () => {
  it("doesn't score a failed or anomalous call", async () => {
    const dir = runDir();
    expect(await scoreRecord(record(1, { error: "boom" }), SESSION_JUDGE, dir, true)).toMatchObject({ score: null, scoreError: "not scored: the call failed" });
    expect(await scoreRecord(record(1, { anomalies: ["[Pipeline] unknown error"] }), SESSION_JUDGE, dir, true)).toMatchObject({ score: null, scoreError: "not scored: harness anomalies (see the run file)" });
  });

  it("in the run: an ungraded call is pending, not an error, and its prompt is written", async () => {
    const dir = runDir();
    const out = await scoreRecord(record(1), SESSION_JUDGE, dir, false);
    expect(out.score?.pending).toBe(true);
    expect(out.scoreError).toBeUndefined();
    expect(fs.readFileSync(sessionJudgeFiles(dir, record(1)).prompt, "utf8")).toMatch(/^# Judge this call/);
  });

  it("in a re-score: an ungraded call fails, after its prompt is written so it can be graded", async () => {
    const dir = runDir();
    const files = sessionJudgeFiles(dir, record(1));
    const out = await scoreRecord(record(1), SESSION_JUDGE, dir, true);
    expect(out.scoreError).toBe(`not graded: no session grade at ${files.grade}`);
    expect(out.score?.pending).toBe(true);
    expect(fs.readFileSync(files.prompt, "utf8")).toMatch(/^# Judge this call/);
  });

  it("in a re-score: a graded call is scored from its grade", async () => {
    const dir = runDir();
    fs.writeFileSync(sessionJudgeFiles(dir, record(1)).grade, grade("fail"));
    const out = await scoreRecord(record(1), SESSION_JUDGE, dir, true);
    expect(out.scoreError).toBeUndefined();
    expect(out.score?.pending).toBe(false);
    expect(out.score?.checkpoints[3].verdict).toBe("fail");
  });

  it("names a broken grade instead of scoring it", async () => {
    const dir = runDir();
    fs.writeFileSync(sessionJudgeFiles(dir, record(1)).grade, '{"checkpoints": {"2": {"verdict": "great"}}}');
    const out = await scoreRecord(record(1), SESSION_JUDGE, dir, true);
    expect(out.score).toBeNull();
    expect(out.scoreError).toMatch(/invalid verdict "great"/);
  });

  it("keeps a call's files in its run directory", () => {
    expect(sessionJudgeFiles("/runs-here", record(3))).toEqual({ prompt: "/runs-here/runs/S2-run3.judge-prompt.md", grade: "/runs-here/runs/S2-run3.judge.json" });
  });
});
