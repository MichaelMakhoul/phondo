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
  { id: 15, name: "Speaks the caller's language when it can; says so plainly when it can't", simulated: true },
];

/** One line of the call as the scorer sees it. */
export type TranscriptLine =
  | { who: "ai"; text: string; kind: SpokenLine["kind"]; voice?: string }
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
  /** SCRUM-594 F5: when the call happened (ISO) — the judge checks stated dates and weekdays against it. */
  callTime?: string;
  /** SCRUM-594 F5: the business's opening hours, as the judge reads them ("monday 09:00–17:00; …; sunday closed"). */
  businessHours?: string;
  /** SCRUM-594 F5: every language the call used (session.languagesUsed): the caller's, or the AI's own sentences'. */
  languages?: string[];
  /** Phone test F9: the language the call ended in (session.fastLanguage). */
  finalLanguage?: string;
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

/** A letter outside Latin script: words the fast path's voices can't say (Japanese aside). */
const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u;
/** …in the Japanese voice, which reads kana and kanji. */
const NON_LATIN_NON_JAPANESE_LETTER = /(?=\p{L})(?![\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}])\P{Script=Latin}/u;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The language of an Aura voice other than English, by its name's suffix ("aura-2-selena-es"). */
const VOICE_LANGUAGES: Record<string, string> = { es: "Spanish", fr: "French", de: "German", it: "Italian", nl: "Dutch", ja: "Japanese" };
/** @returns the voice's language when it isn't English, else null */
export function voiceLanguage(voice: string | undefined): string | null {
  const suffix = /-([a-z]{2})$/.exec(voice || "")?.[1];
  return suffix && Object.hasOwn(VOICE_LANGUAGES, suffix) ? VOICE_LANGUAGES[suffix] : null;
}
/** Everyday English words that are no word in the line's other languages ("is", "we" and "help" are Dutch, so they aren't here). */
const ENGLISH_ONLY = new Set(["the", "you", "your", "what", "can", "there", "anything", "else", "with", "today", "would", "like", "have", "please", "thanks", "thank", "and", "for", "this", "that", "our", "it's", "i'm", "you're"]);

/**
 * Phone test F9: AI lines another language's voice read out in English ("Is there anything
 * else I can help you with today?" in the Spanish voice). English means three or more
 * everyday English words.
 */
export function englishInOtherVoice(t: TranscriptLine[]): string[] {
  const out: string[] = [];
  for (const line of t) {
    if (line.who !== "ai" || !voiceLanguage(line.voice)) continue;
    const words = new Set(line.text.toLowerCase().replace(/’/g, "'").match(/[a-z']+/g) || []);
    if ([...words].filter((w) => ENGLISH_ONLY.has(w)).length >= 3) out.push(line.text);
  }
  return out;
}

/**
 * Everyday words of the line's other languages that are no English words: this scorer's own
 * lists, never the voice server's (it would only grade itself).
 */
const OTHER_ONLY: Record<string, Set<string>> = {
  Spanish: new Set(["el", "los", "las", "usted", "gracias", "hola", "puedo", "puede", "cita", "mañana", "hoy", "también", "ahora", "qué", "cómo", "está", "muy", "más", "pero", "sí", "español", "ayudarle", "para", "por", "una", "que"]),
  French: new Set(["je", "vous", "nous", "est", "et", "pour", "avec", "merci", "bonjour", "oui", "votre", "demain", "rendez", "c'est", "très", "pas", "une"]),
  German: new Set(["ich", "sie", "und", "ist", "nicht", "mit", "für", "danke", "bitte", "termin", "heute", "uhr", "können", "gerne", "ein", "eine"]),
  Italian: new Set(["il", "che", "è", "sono", "grazie", "buongiorno", "appuntamento", "oggi", "domani", "posso", "vorrei", "perfetto", "una"]),
  Dutch: new Set(["het", "een", "ik", "niet", "uw", "graag", "dank", "afspraak", "vandaag", "kunt", "wilt", "voor", "wat"]),
};
const KANA = /[\p{sc=Hiragana}\p{sc=Katakana}]/gu;

/**
 * Phone test F9's other half: AI lines the English voice read out in another language ("Sí,
 * puedo hablar español" before the line had switched). Another language means two kana, or
 * three or more of its everyday words and more of them than English ones.
 */
export function otherInEnglishVoice(t: TranscriptLine[]): string[] {
  const out: string[] = [];
  for (const line of t) {
    if (line.who !== "ai" || voiceLanguage(line.voice)) continue;
    if ((line.text.match(KANA) || []).length >= 2) {
      out.push(line.text);
      continue;
    }
    const words = new Set(line.text.toLowerCase().replace(/’/g, "'").match(/[\p{L}']+/gu) || []);
    const english = [...words].filter((w) => ENGLISH_ONLY.has(w)).length;
    const other = Math.max(...Object.values(OTHER_ONLY).map((set) => [...words].filter((w) => set.has(w)).length));
    if (other >= 3 && other > english) out.push(line.text);
  }
  return out;
}

/**
 * SCRUM-594 F5: "today's Monday" / "tomorrow is Tuesday" lines whose weekday isn't the call's
 * (Sydney time). The verb is required: "closed today, Monday at 9 is free" names two days.
 */
export function wrongWeekdayClaims(rec: Pick<CallRecord, "transcript" | "callTime">): string[] {
  if (!rec.callTime) return [];
  const at = new Date(rec.callTime);
  const dayIn = (ms: number) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "Australia/Sydney" }).format(new Date(ms)).toLowerCase();
  const actual: Record<string, string> = { today: dayIn(at.getTime()), tomorrow: dayIn(at.getTime() + 24 * 3600 * 1000) };
  const claims: string[] = [];
  const re = new RegExp(`\\b(today|tomorrow)(?:['’]s|\\s+is)\\s+(?:a\\s+)?(${WEEKDAYS.join("|")})\\b`, "gi");
  for (const line of rec.transcript) {
    if (line.who !== "ai") continue;
    for (const m of line.text.matchAll(re)) {
      if (m[2].toLowerCase() !== actual[m[1].toLowerCase()]) claims.push(m[0]);
    }
  }
  return claims;
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

  // SCRUM-594 F5: a weekday the AI gives for today or tomorrow that isn't the call's (phone test F5:
  // "Today's Monday the 18th" on a Sunday).
  const wrongDays = wrongWeekdayClaims(rec);
  if (wrongDays.length > 0) out[8] = { verdict: "fail", evidence: `wrong weekday: ${wrongDays.slice(0, 2).map((w) => `"${w}"`).join(", ")}`, source: "det" };

  // SCRUM-594 F5: languages. Words in a script the voice can't say always fail; a supported
  // language must be spoken in its own voice; an unsupported one must never be claimed (the judge
  // reads that). Phone test F9: every line in the voice of its own language, both ways.
  const aiLines = rec.transcript.filter((l): l is Extract<TranscriptLine, { who: "ai" }> => l.who === "ai");
  const foreign = aiLines.filter((l) => (voiceLanguage(l.voice) === "Japanese" ? NON_LATIN_NON_JAPANESE_LETTER : NON_LATIN_LETTER).test(l.text)).map((l) => l.text);
  const misvoiced = englishInOtherVoice(rec.transcript);
  const unvoiced = otherInEnglishVoice(rec.transcript);
  const spokeIn = [...new Set(aiLines.map((l) => voiceLanguage(l.voice)).filter((v): v is string => v !== null))];
  if (foreign.length > 0) {
    out[15] = { verdict: "fail", evidence: `wrote words the voice can't say: "${foreign[0].slice(0, 60)}"`, source: "det" };
  } else if (misvoiced.length > 0) {
    out[15] = { verdict: "fail", evidence: `English read by another language's voice: "${misvoiced[0].slice(0, 60)}"`, source: "det" };
  } else if (unvoiced.length > 0) {
    out[15] = { verdict: "fail", evidence: `another language read by the English voice: "${unvoiced[0].slice(0, 60)}"`, source: "det" };
  } else if (rec.scenario.expect.endsInEnglish && (rec.finalLanguage || "en") !== "en") {
    out[15] = { verdict: "fail", evidence: `the caller went back to English, the line stayed in ${rec.finalLanguage}`, source: "det" };
  } else if (rec.scenario.expect.language && rec.scenario.expect.language !== "unsupported") {
    const wanted = VOICE_LANGUAGES[rec.scenario.expect.language];
    out[15] = spokeIn.includes(wanted)
      ? { verdict: "pass", evidence: `spoke ${wanted}, in its own voice`, source: "det" }
      : { verdict: "fail", evidence: `never spoke ${wanted} (voices: English${spokeIn.length > 0 ? `, ${spokeIn.join(", ")}` : ""})`, source: "det" };
  } else if (rec.scenario.expect.language === "unsupported") {
    out[15] = spokeIn.length > 0
      ? { verdict: "fail", evidence: `spoke ${spokeIn.join(", ")} instead of saying it can't`, source: "det" }
      : { verdict: "pass", evidence: "no words in a language the line can't speak; English only", source: "det" };
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
      if (line.who === "ai") {
        const voice = voiceLanguage(line.voice);
        return `${n} AI${line.kind === "filler" ? " [filler]" : ""}${voice ? ` [${voice} voice]` : ""}: ${line.text}`;
      }
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
8. Never says anything false about bookings — pass: nothing the AI said about bookings, dates or availability contradicts the tool results, the final diary or the CALL TIME (e.g. "you're booked" before any booking succeeded; "nothing was booked" when something was; a wrong day or time; a wrong weekday for today or tomorrow; a made-up reason why a day is unavailable; "I can't see it" about a booking it made). Fillers such as "Let me book that" are fine. The AI's prompt already lists today's and tomorrow's free times (BUSINESS HOURS minus booked ones), so availability for those days that fits BUSINESS HOURS and the diary is true without a tool call. fail: any such statement.
9. Remembers what it did earlier in the call — na if the caller never asked about earlier parts of the call. pass: questions about earlier events (what was booked, how a name was spelled, what it did) were answered correctly. fail: a wrong answer, or claiming not to know or not to have done something it did.
10. Answers "Sorry?" — na unless the caller said "Sorry?" or asked it to say something again. pass: the AI repeated or rephrased what it had just said, and did not treat "Sorry?" as an answer. fail otherwise.
11. Short replies, no repeating itself — pass: replies are short (mostly one or two sentences) and it never asks a question the caller already answered, nor repeats the same offer three or more times. partial: one such repeat. fail: two or more, or long multi-question replies.
15. Speaks the caller's language when it can — na unless the caller asked for or spoke a language other than English. This line can speak English, Spanish, French, German, Italian, Dutch and Japanese only. AI lines tagged "[Spanish voice]" (and so on) were spoken by that language's voice; untagged lines by the English voice (each sentence is said in the voice of its own language). pass: for one of those it answered in the caller's language (or the one they asked for) and carried on in it until the caller changed language (when the caller went back to English, it answered in English; a short answer in English such as a name or "okay, thanks" is no change of language), every line in the voice of its own language; for any other language it said plainly, in English, that this line can't speak it (offering a call-back is a plus) and never claimed to speak it or wrote words in it. fail: it claimed a language it can't speak, wrote words in it, ignored the request, mixed two languages in one reply, or a line was read by another language's voice (for example English in the Spanish voice).
14. Ends properly — every call is scored (never na). pass: the AI said goodbye and ended the call only after the caller had said goodbye or that they needed nothing else. partial: the caller had to hang up themselves after saying goodbye, or the AI ended the call before the caller had said goodbye or that they were done (for example straight after "yes, that's correct, thanks"). fail: the AI hung up while the caller was objecting or still had something to ask, or the call never ended properly.`;

async function judge(rec: CallRecord, model: string): Promise<{ checkpoints: Record<string, { verdict: Verdict; evidence: string }>; summary: string }> {
  const system = [
    "You audit phone calls handled by an AI receptionist for a plumbing business. A scripted caller (who knows the truth) talked to it.",
    "You get the transcript (with what the receptionist's speech-to-text heard), every tool call the receptionist made with the result it got back, and the business diary after the call.",
    "Judge strictly from this evidence. Quote line numbers in your evidence.",
    "",
    JUDGE_RUBRIC,
    "",
    'Reply with JSON only: {"checkpoints": {"2": {"verdict": "...", "evidence": "≤ 30 words"}, ... one entry for each of 2,3,4,5,6,7,8,9,10,11,14,15}, "summary": "≤ 2 sentences: what went wrong, if anything"}',
  ].join("\n");
  const user = [
    `CALLER (truth): ${rec.persona.firstName} ${rec.persona.lastName}, surname spelled ${rec.persona.spelled}, calling from ${rec.persona.phone}.`,
    `CALL TIME: ${rec.callTime ? new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" }).format(new Date(rec.callTime)) : "unknown"} (Sydney). BUSINESS HOURS: ${rec.businessHours || "unknown"}. Today's times are offered only at least 30 minutes ahead (the line's rule), so "no time left today" is true once only later-than-that times are left. LANGUAGES USED: ${(rec.languages || ["en"]).join(", ")}.`,
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
    } else if ((cp.id === 7 || cp.id === 8 || cp.id === 11 || cp.id === 14 || cp.id === 15) && d) {
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
