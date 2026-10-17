/**
 * SCRUM-594 simulated calls: scoring one call against docs/call-scorecard.md.
 *
 * Deterministic checks read the diary and the tool trace; an LLM judge reads
 * the transcript for the checkpoints only a reader can score. Where both
 * apply, the deterministic verdict is authoritative (2, 6) or the worse of the
 * two wins (7, 11, 14). Checkpoints 1, 12 and 13 need real audio and are never
 * scored here.
 */
import { claudeText } from "./anthropic";
import type { Persona } from "./caller";
import type { Scenario } from "./scenarios";
import type { SpokenLine, ToolEvent } from "./voice";

export type Verdict = "pass" | "partial" | "fail" | "na";
export type CheckpointResult = { verdict: Verdict; evidence: string; source: "det" | "judge" | "both" };

export const CHECKPOINTS: Array<{ id: number; name: string; simulated: boolean }> = [
  { id: 1, name: "Hears the caller correctly", simulated: false },
  { id: 2, name: "Gets the surname right", simulated: true },
  { id: 3, name: "Confirms the spelling before booking", simulated: true },
  { id: 4, name: "Books only after the caller agrees to a time", simulated: true },
  { id: 5, name: "Books the time the caller asked for", simulated: true },
  { id: 6, name: "Moves a booking when asked", simulated: true },
  { id: 7, name: "Cancels with at most 2 confirmations", simulated: true },
  { id: 8, name: "Never says anything false about bookings", simulated: true },
  { id: 9, name: "Remembers what it did earlier in the call", simulated: true },
  { id: 10, name: "Answers \"Sorry?\" (interruptions need audio)", simulated: true },
  { id: 11, name: "Short replies, no repeating itself", simulated: true },
  { id: 12, name: "Speaks spelled names clearly", simulated: false },
  { id: 13, name: "Speed (median gap ≤ 1.5 s)", simulated: false },
  { id: 14, name: "Ends properly (goodbye → hangs up; never over an objection)", simulated: true },
];

/** One line of the call as the scorer sees it. */
export type TranscriptLine =
  | { who: "ai"; text: string; kind: SpokenLine["kind"] }
  | { who: "caller"; said: string; heard: string };

export type DiaryEntry = {
  id: string;
  local: string;
  status: string;
  attendeeName: string;
  lastName: string | null;
  madeThisCall: boolean;
  rescheduledFromId: string | null;
};

export type CallRecord = {
  scenario: Scenario;
  persona: Persona;
  run: number;
  transcript: TranscriptLine[];
  toolTrace: ToolEvent[];
  diary: DiaryEntry[];
  /** Active appointments this caller held after each caller turn. */
  activeAfterTurn: number[];
  ending: "end_call" | "caller-hangup" | "max-turns" | "error";
  anomalies: string[];
  logs: string[];
  llm: { calls: number; medianMs: number; p90Ms: number };
  turns: number;
  error?: string;
};

const RANK: Record<Verdict, number> = { fail: 0, partial: 1, pass: 2, na: 3 };
const worse = (a: Verdict, b: Verdict): Verdict => (a === "na" ? b : b === "na" ? a : RANK[a] <= RANK[b] ? a : b);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** The AI's reply words per turn (fillers excluded). */
export function replyWordCounts(t: TranscriptLine[]): number[] {
  const counts: number[] = [];
  let current = 0;
  let inAi = false;
  for (const line of t) {
    if (line.who === "ai") {
      if (line.kind === "reply") current += line.text.split(/\s+/).filter(Boolean).length;
      inAi = true;
    } else {
      if (inAi && current > 0) counts.push(current);
      current = 0;
      inAi = false;
    }
  }
  if (inAi && current > 0) counts.push(current);
  return counts;
}

function deterministic(rec: CallRecord): Partial<Record<number, CheckpointResult>> {
  const out: Partial<Record<number, CheckpointResult>> = {};
  const made = rec.diary.filter((d) => d.madeThisCall);
  const active = rec.diary.filter((d) => d.status === "confirmed" || d.status === "pending");

  if (made.length > 0) {
    const wrong = made.filter((d) => (d.lastName || "").toLowerCase() !== rec.persona.lastName.toLowerCase());
    out[2] = wrong.length === 0
      ? { verdict: "pass", evidence: `every booking made says "${rec.persona.lastName}"`, source: "det" }
      : { verdict: "fail", evidence: `saved as ${wrong.map((d) => `"${d.lastName ?? d.attendeeName}"`).join(", ")}`, source: "det" };
  }

  if (rec.scenario.expect.moves) {
    const moved = rec.toolTrace.some((t) => t.name === "reschedule_appointment" && /moved|rescheduled|you'?re now booked|all set/i.test(t.result || ""));
    const maxHeld = Math.max(0, ...rec.activeAfterTurn);
    const ok = active.length === 1 && maxHeld <= 1;
    out[6] = ok
      ? { verdict: "pass", evidence: `${moved ? "rescheduled" : "moved"}; never held more than one booking`, source: "det" }
      : { verdict: "fail", evidence: `held up to ${maxHeld} bookings at once; ${active.length} active at the end`, source: "det" };
  }

  if (rec.scenario.expect.cancels) {
    const holds = rec.toolTrace.filter((t) => t.name === "cancel_appointment" && /^DO NOT CANCEL YET/.test(t.result || "")).length;
    out[7] = active.length === 0
      ? { verdict: holds <= 1 ? "pass" : "partial", evidence: `cancelled; ${holds} confirmation hold(s) from the cancel guard`, source: "det" }
      : { verdict: "fail", evidence: `${active.length} booking(s) still active at the end`, source: "det" };
  }

  const words = replyWordCounts(rec.transcript);
  const p90 = percentile(words, 0.9);
  const max = Math.max(0, ...words);
  out[11] = p90 > 40 || max > 60
    ? { verdict: "fail", evidence: `reply length p90 ${p90} words, max ${max}`, source: "det" }
    : { verdict: "pass", evidence: `reply length median ${percentile(words, 0.5)}, p90 ${p90}, max ${max} words`, source: "det" };

  {
    out[14] = rec.ending === "end_call"
      ? { verdict: "pass", evidence: "the AI ended the call", source: "det" }
      : rec.ending === "caller-hangup"
        ? { verdict: "partial", evidence: "the caller had to hang up", source: "det" }
        : { verdict: "fail", evidence: `the call ended by ${rec.ending}`, source: "det" };
  }
  return out;
}

export function renderTranscript(t: TranscriptLine[]): string {
  return t
    .map((line, i) => {
      const n = String(i + 1).padStart(3, " ");
      if (line.who === "ai") return `${n} AI${line.kind === "filler" ? " [filler]" : ""}: ${line.text}`;
      return line.said === line.heard
        ? `${n} CALLER: ${line.said}`
        : `${n} CALLER: ${line.said}    [the receptionist's speech-to-text heard: "${line.heard}"]`;
    })
    .join("\n");
}

export function renderToolTrace(trace: ToolEvent[]): string {
  if (trace.length === 0) return "(no tool calls)";
  return trace
    .map((t, i) => `${i + 1}. ${t.name}(${JSON.stringify(t.args)}) → ${(t.result ?? "(no result recorded)").replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

export function renderDiary(diary: DiaryEntry[]): string {
  if (diary.length === 0) return "(no appointments)";
  return diary
    .map((d) => `- ${d.local} — ${d.status} — name "${d.attendeeName}" (last name field "${d.lastName ?? ""}")${d.madeThisCall ? " — made on this call" : ""}${d.rescheduledFromId ? " — moved from another appointment" : ""}`)
    .join("\n");
}

const JUDGE_RUBRIC = `Score the call on each checkpoint below. Verdicts: "pass", "partial", "fail", or "na" (not exercised in this call).

2. Gets the surname right — na if nothing was booked. pass: every booking made or changed carries the caller's real surname spelling. fail otherwise.
3. Confirms the spelling before booking — na if nothing was booked. pass: BEFORE the first successful book_appointment, the AI read the surname back letter by letter (or had the caller spell it and then read that spelling back) and the caller confirmed it. partial: it had the caller spell it but never read the spelling back for a yes, or read it back only after booking. fail: no spelling step before booking.
4. Books only after the caller agrees to a time — na if nothing was booked. pass: every book_appointment / reschedule_appointment call came after the caller clearly agreed to that exact day and time. fail: a booking or move for a time the caller had not agreed to.
5. Books the time the caller asked for — na if nothing was booked. pass: the bookings the caller holds at the end are at the day and time they last asked for or agreed to. fail otherwise.
6. Moves a booking when asked — na unless the caller asked to move or change a booking. pass: the existing booking was moved (not a second one booked), and the caller ends with one booking at the new time. fail otherwise.
7. Cancels with at most 2 confirmations — na unless the caller asked to cancel. pass: cancelled after at most two confirmation questions from the AI after the request, without re-asking for details it already had (name, phone). partial: cancelled, but it took three confirmations or it re-asked for a detail it had. fail: not cancelled, or four or more confirmations.
8. Never says anything false about bookings — pass: nothing the AI said about bookings contradicts the tool results and the final diary (e.g. "you're booked" before any booking succeeded; "nothing was booked" when something was; a wrong day or time; "I can't see it" about a booking it made). Fillers such as "Let me book that" are fine. fail: any such statement.
9. Remembers what it did earlier in the call — na if the caller never asked about earlier parts of the call. pass: questions about earlier events (what was booked, how a name was spelled, what it did) were answered correctly. fail: a wrong answer, or claiming not to know or not to have done something it did.
10. Answers "Sorry?" — na unless the caller said "Sorry?" or asked it to say something again. pass: the AI repeated or rephrased what it had just said, and did not treat "Sorry?" as an answer. fail otherwise.
11. Short replies, no repeating itself — pass: replies are short (mostly one or two sentences) and it never asks a question the caller already answered, nor repeats the same offer three or more times. partial: one such repeat. fail: two or more, or long multi-question replies.
14. Ends properly — every call is scored (never na). pass: the AI said goodbye and ended the call only after the caller had said goodbye or that they needed nothing else. partial: the caller had to hang up themselves after saying goodbye, or the AI ended the call before the caller had said goodbye or that they were done (for example straight after "yes, that's correct, thanks"). fail: the AI hung up while the caller was objecting or still had something to ask, or the call never ended properly.`;

async function judge(rec: CallRecord, model: string): Promise<{ checkpoints: Record<string, { verdict: Verdict; evidence: string }>; summary: string }> {
  const system = [
    "You audit phone calls handled by an AI receptionist for a plumbing business. A scripted caller (who knows the truth) talked to it.",
    "You get the transcript (with what the receptionist's speech-to-text heard), every tool call the receptionist made with the result it got back, and the business diary after the call.",
    "Judge strictly from this evidence. Quote line numbers in your evidence.",
    "",
    JUDGE_RUBRIC,
    "",
    'Reply with JSON only: {"checkpoints": {"2": {"verdict": "...", "evidence": "≤ 30 words"}, ... one entry for each of 2,3,4,5,6,7,8,9,10,11,14}, "summary": "≤ 2 sentences: what went wrong, if anything"}',
  ].join("\n");
  const user = [
    `CALLER (truth): ${rec.persona.firstName} ${rec.persona.lastName}, surname spelled ${rec.persona.spelled}, calling from ${rec.persona.phone}.`,
    `CALLER'S SCRIPT:\n${rec.scenario.goal}`,
    "",
    `TRANSCRIPT:\n${renderTranscript(rec.transcript)}`,
    "",
    `TOOL CALLS (in order, with the result the receptionist got):\n${renderToolTrace(rec.toolTrace)}`,
    "",
    `DIARY AFTER THE CALL (Sydney time):\n${renderDiary(rec.diary)}`,
    "",
    `HOW THE CALL ENDED: ${rec.ending === "end_call" ? "the AI ended the call (end_call)" : rec.ending === "caller-hangup" ? "the caller hung up" : rec.ending}`,
  ].join("\n");
  const raw = await claudeText({ model, system, messages: [{ role: "user", content: user }], maxTokens: 8000 });
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as { checkpoints?: Record<string, { verdict?: string; evidence?: string }>; summary?: string };
  const checkpoints: Record<string, { verdict: Verdict; evidence: string }> = {};
  for (const [k, v] of Object.entries(parsed.checkpoints || {})) {
    const verdict = (["pass", "partial", "fail", "na"] as const).find((x) => x === v?.verdict);
    if (!verdict) throw new Error(`sim: judge gave checkpoint ${k} an invalid verdict ${JSON.stringify(v?.verdict)}`);
    checkpoints[k] = { verdict, evidence: String(v?.evidence || "") };
  }
  return { checkpoints, summary: String(parsed.summary || "") };
}

export type CallScore = { checkpoints: Record<number, CheckpointResult>; summary: string };

export async function scoreCall(rec: CallRecord, judgeModel: string): Promise<CallScore> {
  const det = deterministic(rec);
  const j = await judge(rec, judgeModel);
  const checkpoints: Record<number, CheckpointResult> = {};
  for (const cp of CHECKPOINTS) {
    if (!cp.simulated) continue;
    const d = det[cp.id];
    const jj = j.checkpoints[String(cp.id)];
    if (!jj) throw new Error(`sim: the judge skipped checkpoint ${cp.id}`);
    if (cp.id === 2 || cp.id === 6) {
      checkpoints[cp.id] = d ?? { verdict: jj.verdict, evidence: jj.evidence, source: "judge" };
    } else if ((cp.id === 7 || cp.id === 11 || cp.id === 14) && d) {
      const v = worse(d.verdict, jj.verdict);
      checkpoints[cp.id] = { verdict: v, evidence: `${d.evidence}; judge: ${jj.evidence}`, source: "both" };
    } else {
      checkpoints[cp.id] = { verdict: jj.verdict, evidence: jj.evidence, source: "judge" };
    }
  }
  return { checkpoints, summary: j.summary };
}

export function llmStats(ms: number[], calls: number): CallRecord["llm"] {
  return { calls, medianMs: percentile(ms, 0.5), p90Ms: percentile(ms, 0.9) };
}
