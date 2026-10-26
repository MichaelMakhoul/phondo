/**
 * SCRUM-594 simulated calls: a run directory's saved calls, and how each one
 * is scored, for the run itself and for SIM_RESCORE alike.
 */
import fs from "fs";
import path from "path";
import { runFileName, type ScoredCall } from "./report";
import { scoreCall, type CallRecord, type SessionJudgeFiles } from "./score";

/** SIM_JUDGE_MODEL=session: the files a call's judge prompt and the session's grade live in. */
export function sessionJudgeFiles(dir: string, record: CallRecord): SessionJudgeFiles {
  const base = path.join(dir, "runs", runFileName(record).replace(/\.md$/, ""));
  return { prompt: `${base}.judge-prompt.md`, grade: `${base}.judge.json` };
}

/** Throws when `dir` already holds runs: a session grade left there would score a new call of the same name. */
export function assertFreshRunDir(dir: string): void {
  const runs = path.join(dir, "runs");
  if (fs.existsSync(runs) && fs.readdirSync(runs).length > 0) {
    throw new Error(`sim: ${runs} already holds runs (a grade there would score a new call): use a fresh SIM_OUT`);
  }
}

/**
 * A finished run's saved call records (SIM_RESCORE). results.json, written when
 * the run finished, lists every call: without it the run was cut short, and a
 * listed call without its record is missing. The session's grades beside the
 * records are not records.
 */
export function loadRecords(dir: string): CallRecord[] {
  const resultsFile = path.join(dir, "results.json");
  if (!fs.existsSync(resultsFile)) throw new Error(`sim: ${dir} has no results.json: the run didn't finish, so calls may be missing`);
  const listed: unknown = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  if (!Array.isArray(listed)) throw new Error(`sim: ${resultsFile} is not a list of calls`);
  const files = fs.readdirSync(path.join(dir, "runs")).filter((f) => f.endsWith(".json") && !f.endsWith(".judge.json"));
  if (files.length === 0) throw new Error(`no saved records in ${dir}/runs (runs before records were saved can't be re-scored)`);
  const records = files.map((f) => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, "runs", f), "utf8")) as CallRecord;
    if (!record?.scenario || !Array.isArray(record.anomalies)) throw new Error(`sim: runs/${f} is not a call record`);
    return record;
  });
  const saved = new Set(records.map((r) => `${r.scenario.id} run ${r.run}`));
  const missing = (listed as Array<{ scenario?: unknown; run?: unknown }>).map((c) => `${String(c?.scenario)} run ${String(c?.run)}`).filter((c) => !saved.has(c));
  if (missing.length > 0) throw new Error(`sim: results.json lists calls with no saved record: ${missing.join(", ")}`);
  return records;
}

/**
 * One call's score. A failed or anomalous call isn't scored. With
 * `requireGrade` (SIM_RESCORE), a call the session hasn't graded fails, after
 * its judge prompt is (re)written so it can be graded.
 */
export async function scoreRecord(record: CallRecord, judgeModel: string, dir: string, requireGrade: boolean): Promise<ScoredCall> {
  if (record.error) return { record, score: null, scoreError: "not scored: the call failed" };
  if (record.anomalies.length > 0) return { record, score: null, scoreError: "not scored: harness anomalies (see the run file)" };
  const files = sessionJudgeFiles(dir, record);
  try {
    const score = await scoreCall(record, judgeModel, files);
    if (requireGrade && score.pending) return { record, score, scoreError: `not graded: no session grade at ${files.grade}` };
    return { record, score };
  } catch (err) {
    return { record, score: null, scoreError: err instanceof Error ? err.message : String(err) };
  }
}
