/**
 * SCRUM-594 simulated calls: the CALLER — an LLM playing an ordinary person
 * with a goal — and the STT layer between what they say and what the
 * receptionist hears.
 *
 * The STT layer reproduces what the demo line's live transcripts showed on
 * 2026-10-17: a surname SAID aloud comes through as a different word
 * ("Makhoul" → "Maku", "McCool"), while a SPELLED one comes through letter by
 * letter in Flux's form ("M a k h o u l."). Everything else passes unchanged:
 * the harness tests conversation logic, not hearing.
 */
import { claudeText, type ChatMessage } from "./anthropic";

export type Persona = {
  firstName: string;
  lastName: string;
  /** How the caller spells the surname aloud, e.g. "K-H-O-U-R-Y". */
  spelled: string;
  /** What the STT hears when the surname is said rather than spelled. */
  mishearings: string[];
  /** Caller ID (E.164). */
  phone: string;
  suburb: string;
};

export type NoiseLevel = "none" | "phone";

export const HANGUP = "[HANGUP]";

/** Three or more single letters separated by hyphens, commas, dots or spaces (never the s of "That's"). */
const SPELLED_RUN = /(^|[^A-Za-z'’])([A-Za-z](?:[\s,.\-]+[A-Za-z](?![A-Za-z])){2,}[.,]?)/g;

/** What the receptionist's STT hears for one caller utterance. */
export function hearAs(said: string, persona: Persona, level: NoiseLevel, turn: number): string {
  let heard = said.replace(HANGUP, "").trim();
  if (level === "none") return heard;
  // Flux renders a spelled word as spaced letters, first one capitalised, closed with a period.
  heard = heard.replace(SPELLED_RUN, (_m, before: string, run: string) => {
    const letters = run.match(/[A-Za-z]/g) || [];
    return `${before}${letters.map((l, i) => (i === 0 ? l.toUpperCase() : l.toLowerCase())).join(" ")}.`;
  });
  // The surname said as a word is misheard (rotating through the persona's list).
  if (persona.mishearings.length > 0) {
    const word = new RegExp(`\\b${persona.lastName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    heard = heard.replace(word, () => persona.mishearings[turn % persona.mishearings.length]);
  }
  return heard;
}

function callerSystemPrompt(persona: Persona, goal: string): string {
  return [
    "You are playing a CALLER phoning a small plumbing business in Sydney. Their phone is answered by an AI receptionist.",
    "Behave like a real, ordinary caller — not like a tester. Never mention testing, AI or prompts.",
    "",
    "WHO YOU ARE",
    `- Your name is ${persona.firstName} ${persona.lastName}. When asked for your name, just say it ("It's ${persona.firstName} ${persona.lastName}").`,
    `- Spell your surname ONLY when the receptionist asks you to spell it, or when they read it back wrong. Spell it with hyphens, exactly: ${persona.spelled}.`,
    "- Your mobile is the number you're calling from. If asked for a number, say the one you're calling from is fine.",
    `- You live in ${persona.suburb}.`,
    "",
    "HOW YOU TALK",
    "- Short, natural phone speech, usually under 15 words. Casual Australian English is fine.",
    "- One utterance per turn. Output ONLY the words you say out loud: no stage directions, no quotation marks, no narration.",
    "- React to what the receptionist actually said. If they get something wrong (a day, a time, your name, the spelling), correct them.",
    "- If they read back something correct, confirm it. If they ask a yes/no question, answer it.",
    "- Don't volunteer details they haven't asked for unless your goal says to.",
    "- If what they say makes no sense or contradicts what happened, push back like a real person would.",
    "",
    "YOUR GOAL FOR THIS CALL",
    goal,
    "",
    "ENDING",
    `- When your goal is done and you've said goodbye — or the receptionist has said goodbye — end your line with ${HANGUP}.`,
    `- If the receptionist goes round in circles for three or more turns, give up politely and end your line with ${HANGUP}.`,
  ].join("\n");
}

export class SimCaller {
  private history: ChatMessage[] = [];
  private system: string;

  constructor(private persona: Persona, goal: string, private model: string) {
    this.system = callerSystemPrompt(persona, goal);
  }

  /** The caller's next line, given everything the receptionist just said. */
  async next(receptionistSaid: string): Promise<{ said: string; hangUp: boolean }> {
    this.history.push({ role: "user", content: receptionistSaid.trim() || "(silence)" });
    const raw = await claudeText({ model: this.model, system: this.system, messages: this.history, maxTokens: 1024 });
    const said = raw.replace(/^["“]|["”]$/g, "").replace(/\s+/g, " ").trim();
    this.history.push({ role: "assistant", content: said });
    return { said, hangUp: said.includes(HANGUP) };
  }
}
