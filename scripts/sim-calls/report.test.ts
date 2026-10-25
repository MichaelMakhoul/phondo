import { describe, expect, it } from "vitest";
import { renderReport, renderRun, type ScoredCall } from "./report";
import { CHECKPOINTS, type CallRecord, type CallScore, type Verdict } from "./score";
import { PERSONA, SCENARIOS } from "./scenarios";

// SCRUM-594: a call the Claude Code session hasn't graded yet (SIM_JUDGE_MODEL=session) must never read as a pass.
const S2 = SCENARIOS.find((s) => s.id === "S2")!;
const record = (run: number): CallRecord => ({
  scenario: S2, persona: PERSONA, run, transcript: [], toolTrace: [], diary: [], activeAfterTurn: [],
  ending: "end_call", anomalies: [], logs: [], llm: { calls: 0, medianMs: 0, p90Ms: 0 }, turns: 1,
});
/** Every simulated checkpoint passes unless `verdicts` says otherwise. */
const score = (pending: boolean, verdicts: Record<number, Verdict> = {}): CallScore => ({
  checkpoints: Object.fromEntries(CHECKPOINTS.filter((c) => c.simulated).map((c) => [c.id, { verdict: verdicts[c.id] ?? "pass", evidence: `e${c.id}`, source: "det" as const }])),
  summary: pending ? "awaiting the session's grade" : "fine",
  pending,
});
const report = (calls: ScoredCall[]) =>
  renderReport({ label: "t", scenarios: [S2], calls, models: { receptionist: "r", caller: "c", judge: "session" }, noise: "phone", usage: {}, startedAt: new Date(0), finishedAt: new Date(60_000) });
/** A checkpoint's row, from its marks to the end: "| <marks> | <tally> |". */
const cells = (md: string, id: number) => md.split("\n").find((l) => l.startsWith(`| ${id} |`))?.replace(/^\| \d+ \| [^|]+ /, "");

describe("the run report before the session's grade", () => {
  it("marks every verdict the grade could still change ⏳ and counts only failures", () => {
    const md = report([{ record: record(1), score: score(true, { 3: "na", 7: "fail", 8: "partial" }) }]);
    expect(cells(md, 2)).toBe("| ⏳ | — |");
    expect(cells(md, 3)).toBe("| ⏳ | — |");
    expect(cells(md, 7)).toBe("| ❌ | 0/1 |");
    expect(cells(md, 8)).toBe("| ⏳ | — |");
  });

  it("says it is not a verdict and how to grade, and claims no fully-passing count", () => {
    const md = report([{ record: record(1), score: score(true) }]);
    expect(md).toContain("1/1 calls have no final score, so this report is not a verdict.** Grade each `runs/*.judge-prompt.md`");
    expect(md).toContain("**⏳ 1/1 calls without a final score**");
    expect(md).toContain("Nothing final yet: not every call has a final score.");
    expect(md).not.toMatch(/\*\*\d+ \/ \d+\*\*/);
  });

  it("still lists a failure already found", () => {
    const md = report([{ record: record(1), score: score(true, { 7: "fail" }) }]);
    expect(md).toMatch(/- \*\*S2 run 1, #7\*\* ❌ e7/);
  });

  it("counts the graded runs beside an ungraded one", () => {
    const md = report([
      { record: record(1), score: score(false) },
      { record: record(2), score: score(true, { 7: "fail" }) },
    ]);
    expect(cells(md, 2)).toBe("| ✅⏳ | 1/1 |");
    expect(cells(md, 7)).toBe("| ✅❌ | 1/2 |");
    expect(md).toContain("1/2 calls have no final score");
  });

  it("claims no pass count beside a call that failed to run", () => {
    const md = report([
      { record: record(1), score: score(false) },
      { record: record(2), score: null, scoreError: "not scored: the call failed" },
    ]);
    expect(md).not.toMatch(/\*\*\d+ \/ \d+\*\*/);
    expect(md).toContain("1/2 calls have no final score, so this report is not a verdict.** Failed or anomalous calls are listed below.");
    expect(md).not.toContain("Grade each");
    expect(md).toContain("- S2 run 2: not scored: the call failed");
  });

  it("lists a re-scored call that still has no grade, and says how to grade it", () => {
    const md = report([
      { record: record(1), score: score(false) },
      { record: record(2), score: score(true), scoreError: "not graded: no session grade at runs/S2-run2.judge.json" },
    ]);
    expect(md).not.toMatch(/\*\*\d+ \/ \d+\*\*/);
    expect(md).toContain("Grade each `runs/*.judge-prompt.md`");
    expect(md).toContain("- S2 run 2: not graded: no session grade at runs/S2-run2.judge.json");
  });

  it("is a plain report once every call is graded", () => {
    const md = report([{ record: record(1), score: score(false, { 3: "na", 7: "fail" }) }]);
    expect(cells(md, 2)).toBe("| ✅ | 1/1 |");
    expect(cells(md, 3)).toBe("| — | — |");
    expect(cells(md, 7)).toBe("| ❌ | 0/1 |");
    expect(md).toContain("**10 / 11**");
    expect(md).not.toContain("not a verdict");
  });
});

describe("a call's own file before the session's grade", () => {
  it("names the files to grade and marks only failures as final", () => {
    const md = renderRun({ record: record(2), score: score(true, { 7: "fail" }) });
    expect(md).toContain("grade `S2-run2.judge-prompt.md` into `S2-run2.judge.json` (beside this file)");
    expect(md).toMatch(/\n\| 2 \| [^|]+ \| ⏳ \|/);
    expect(md).toMatch(/\n\| 7 \| [^|]+ \| ❌ \|/);
  });

  it("is a plain verdict once graded", () => {
    const md = renderRun({ record: record(2), score: score(false) });
    expect(md).not.toContain("Judge pending");
    expect(md).toMatch(/\n\| 2 \| [^|]+ \| ✅ \|/);
  });
});
