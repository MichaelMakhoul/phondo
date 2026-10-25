/**
 * SCRUM-594 simulated calls: the run report, in docs/call-scorecard.md's
 * shape — one row per checkpoint, one column per scenario, one mark per run.
 */
import { CHECKPOINTS, renderDiary, renderToolTrace, renderTranscript, type CallRecord, type CallScore, type Verdict } from "./score";
import type { Scenario } from "./scenarios";

const MARK: Record<Verdict, string> = { pass: "✅", partial: "⚠️", fail: "❌", na: "—" };
/** A verdict the session's grade could still change (CallScore.pending). */
const PENDING = "⏳";

/** One checkpoint's mark: before the session's grade, only a failure is final. */
function mark(score: CallScore, verdict: Verdict): string {
  return score.pending && verdict !== "fail" ? PENDING : MARK[verdict];
}

export type ScoredCall = { record: CallRecord; score: CallScore | null; scoreError?: string };

export function runFileName(rec: CallRecord): string {
  return `${rec.scenario.id}-run${rec.run}.md`;
}

export function renderRun(sc: ScoredCall): string {
  const { record: rec, score } = sc;
  const lines = [
    `# ${rec.scenario.id} run ${rec.run}: ${rec.scenario.title}`,
    "",
    `Ended: ${rec.ending} after ${rec.turns} caller turns. Claude (receptionist): ${rec.llm.calls} requests, median ${rec.llm.medianMs} ms, p90 ${rec.llm.p90Ms} ms. Languages: ${(rec.languages || ["en"]).join(", ")}${rec.finalLanguage && rec.finalLanguage !== "en" ? ` (ended in ${rec.finalLanguage})` : ""}.`,
    rec.error ? `\n**Harness error:** ${rec.error}` : "",
    rec.anomalies.length > 0 ? `\n**Anomalies (the run is not a fair score):**\n${rec.anomalies.map((a) => `- ${a}`).join("\n")}` : "",
    score?.pending
      ? `\n**${PENDING} Judge pending, not a verdict:** grade \`${runFileName(rec).replace(/\.md$/, ".judge-prompt.md")}\` into \`${runFileName(rec).replace(/\.md$/, ".judge.json")}\` (beside this file), then run \`SIM_RESCORE=<run dir>\`. Until then only ❌ is final.`
      : "",
    "",
    "## Verdicts",
    "",
    "| # | Checkpoint | Verdict | Evidence |",
    "|---|---|---|---|",
    ...CHECKPOINTS.filter((c) => c.simulated).map((c) => {
      const r = score?.checkpoints[c.id];
      return `| ${c.id} | ${c.name} | ${r && score ? mark(score, r.verdict) : "?"} | ${r ? `${r.evidence.replace(/\|/g, "/")} (${r.source})` : sc.scoreError ?? ""} |`;
    }),
    "",
    score?.summary ? `**Judge's summary:** ${score.summary}` : "",
    "",
    "## Transcript",
    "",
    "```",
    renderTranscript(rec.transcript),
    "```",
    "",
    "## Tool calls",
    "",
    "```",
    renderToolTrace(rec.toolTrace),
    "```",
    "",
    "## Diary after the call",
    "",
    renderDiary(rec.diary),
    "",
    `Active bookings after each caller turn: ${rec.activeAfterTurn.join(" ")}`,
    "",
    "## Server log (this call)",
    "",
    "```",
    ...rec.logs.map((l) => l.slice(0, 400)),
    "```",
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

export function renderReport(o: {
  label: string;
  scenarios: Scenario[];
  calls: ScoredCall[];
  models: { receptionist: string; caller: string; judge: string };
  noise: string;
  usage: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  startedAt: Date;
  finishedAt: Date;
}): string {
  const header = `| # | Checkpoint | ${o.scenarios.map((s) => `${s.id} ${s.title}`).join(" | ")} | All runs |`;
  const sep = `|---|---|${o.scenarios.map(() => "---").join("|")}|---|`;
  let fullyPassing = 0;
  let exercised = 0;
  const rows: string[] = [];
  for (const cp of CHECKPOINTS) {
    if (!cp.simulated) {
      rows.push(`| ${cp.id} | ${cp.name} | ${o.scenarios.map(() => "audio only").join(" | ")} | — |`);
      continue;
    }
    let pass = 0;
    let n = 0;
    const cells = o.scenarios.map((s) => {
      const marks = o.calls
        .filter((c) => c.record.scenario.id === s.id)
        .sort((a, b) => a.record.run - b.record.run)
        .map((c) => {
          const v = c.score?.checkpoints[cp.id]?.verdict;
          if (!c.score || !v) return "?";
          const m = mark(c.score, v);
          if (v !== "na" && m !== PENDING) {
            n++;
            if (v === "pass") pass++;
          }
          return m;
        });
      return marks.join("");
    });
    if (n > 0) {
      exercised++;
      if (pass === n) fullyPassing++;
    }
    rows.push(`| ${cp.id} | ${cp.name} | ${cells.join(" | ")} | ${n > 0 ? `${pass}/${n}` : "—"} |`);
  }

  const ungraded = o.calls.filter((c) => c.score?.pending).length;
  // Calls without a final score: ungraded, failed or anomalous. While there are any, the report claims no pass count.
  const unfinal = o.calls.filter((c) => !c.score || c.score.pending).length;
  const anomalous = o.calls.filter((c) => c.record.anomalies.length > 0 || c.record.error || c.scoreError);
  const failures = o.calls.flatMap((c) =>
    Object.entries(c.score?.checkpoints || {})
      .filter(([, r]) => r.verdict === "fail" || r.verdict === "partial")
      .map(([id, r]) => `- **${c.record.scenario.id} run ${c.record.run}, #${id}** ${MARK[r.verdict]} ${r.evidence} ([transcript](runs/${runFileName(c.record)}))`),
  );
  const minutes = ((o.finishedAt.getTime() - o.startedAt.getTime()) / 60000).toFixed(1);
  return [
    `# Simulated calls: ${o.label}`,
    "",
    `${o.startedAt.toISOString()} · ${o.calls.length} calls · ${minutes} min · receptionist ${o.models.receptionist} (the demo line's real prompt, guards and booking code) · caller ${o.models.caller} · judge ${o.models.judge} · STT noise "${o.noise}"`,
    "",
    unfinal > 0
      ? `> ${PENDING} **${unfinal}/${o.calls.length} calls have no final score, so this report is not a verdict.**${ungraded > 0 ? ` Grade each \`runs/*.judge-prompt.md\` into its \`runs/*.judge.json\`, then run \`SIM_RESCORE=<this run's directory>\`.` : ""}${unfinal > ungraded ? " Failed or anomalous calls are listed below." : ""} Only ❌ is final.\n`
      : "",
    `One mark per run: ✅ passed · ⚠️ partly passed · ❌ failed · — not exercised · ${PENDING} awaiting the session's grade. Checkpoints 1, 12 and 13 need a real phone line.`,
    "",
    header,
    sep,
    ...rows,
    `| | **Fully passing (every run)** | ${o.scenarios.map(() => " ").join(" | ")} | **${unfinal > 0 ? `${PENDING} ${unfinal}/${o.calls.length} calls without a final score` : `${fullyPassing} / ${exercised}`}** |`,
    "",
    anomalous.length > 0
      ? `## ⚠️ Calls not scored (failed, anomalous or ungraded)\n\n${anomalous.map((c) => `- ${c.record.scenario.id} run ${c.record.run}: ${c.record.error ?? c.scoreError ?? c.record.anomalies[0]}`).join("\n")}\n`
      : "",
    "## What failed",
    "",
    failures.length > 0 ? failures.join("\n") : unfinal > 0 ? "Nothing final yet: not every call has a final score." : "Nothing.",
    "",
    "## Judge's summaries",
    "",
    ...o.calls.map((c) => `- ${c.record.scenario.id} run ${c.record.run} (${c.record.ending}, ${c.record.turns} turns): ${c.score?.summary || c.scoreError || "—"}`),
    "",
    "## Cost",
    "",
    ...Object.entries(o.usage).map(([m, u]) => `- ${m}: ${u.calls} requests, ${u.inputTokens} in / ${u.outputTokens} out tokens`),
    "- The receptionist's own Claude requests are counted per run (see each run file).",
  ].join("\n");
}
