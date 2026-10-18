/**
 * SCRUM-594 simulated calls: the scripted callers. Each scenario exercises the
 * checkpoints of docs/call-scorecard.md that real test calls kept failing; its
 * `expect` block is what the deterministic scorer checks against the diary.
 */
import type { Persona } from "./caller";

export type Scenario = {
  id: string;
  title: string;
  goal: string;
  maxTurns: number;
  /** Bookings the caller made on an EARLIER call: the nth business day after today, at a local time. */
  earlierBookings?: Array<{ businessDay: number; time: string }>;
  expect: {
    /** The caller ends up booked (S1, S2, S4, S5) — checkpoint 2 applies. */
    books: boolean;
    /** Active appointments this caller holds when the call ends. */
    finalActive: number;
    /** The caller asks to MOVE the booking (checkpoint 6). */
    moves?: boolean;
    /** The caller asks to CANCEL the booking (checkpoint 7). */
    cancels?: boolean;
    /** SCRUM-594 F5 (checkpoint 15): the caller wants a language — one the line speaks ("es"), or one it can't ("unsupported"). */
    language?: "es" | "fr" | "de" | "it" | "nl" | "ja" | "unsupported";
  };
  /** SCRUM-594 F5: the time the call happens (ISO); run such scenarios on their own (one clock per run). */
  clock?: string;
};

export const PERSONA: Persona = {
  firstName: "Sami",
  lastName: "Khoury",
  spelled: "K-H-O-U-R-Y",
  mishearings: ["Curry", "Corey"],
  phone: "+61412555013",
  suburb: "Marrickville",
};

export const SCENARIOS: Scenario[] = [
  {
    id: "S1",
    title: "Book with a spelled surname",
    goal: [
      "Your kitchen tap has been dripping for a week. It isn't urgent; you want Dave to come and fix it.",
      "Book the earliest weekday MORNING visit they offer — accept the first morning time they suggest.",
      "Give your details when asked. If they ask for a photo, say you'll take one.",
      "When the booking is done and they've read it back correctly, say thanks and goodbye.",
    ].join("\n"),
    maxTurns: 30,
    expect: { books: true, finalActive: 1 },
  },
  {
    id: "S2",
    title: "Book, then move it",
    goal: [
      "Your toilet keeps running after flushing. Not urgent.",
      "Book the first visit time they offer.",
      "Once they've told you it's booked, change your mind, the way people do on the phone: \"Actually, how about Tuesday?\" (If the booking is already on a Tuesday, say Wednesday instead.) When they ask what time, say around 10.",
      "You want ONE appointment, moved — not two. If they suggest keeping both or booking another, say no, you only need the one, moved.",
      "When it's sorted and read back correctly, say goodbye.",
    ].join("\n"),
    maxTurns: 34,
    expect: { books: true, finalActive: 1, moves: true },
  },
  {
    id: "S3",
    title: "Book, then cancel it",
    goal: [
      "Your hot water has been lukewarm for two days. Not urgent.",
      "Book the first visit time they offer.",
      "As soon as they tell you it's booked — even if they ask whether everything is correct — say your partner has already got someone else coming, so please cancel that booking. You want it cancelled on this call.",
      "If they ask you to confirm the cancellation, confirm it. If they ask for your phone number, say it's the number you're calling from — and sound a bit annoyed if they ask for it again.",
      "When it's cancelled, say goodbye.",
    ].join("\n"),
    maxTurns: 34,
    expect: { books: true, finalActive: 0, cancels: true },
  },
  {
    id: "S4",
    title: "Long call, then ask what was booked",
    goal: [
      "Your bathroom drain is blocked and draining slowly. Not urgent.",
      "Book the first visit time they offer.",
      "AFTER it's booked, keep chatting. Ask these one at a time, each as its own turn, and wait for each answer:",
      "what the call-out fee is; whether that covers parts; whether they do hot water systems; whether they come out to Parramatta;",
      "what happens if it gets worse after hours; whether Dave is licensed; how long a drain clear usually takes; whether you need to be home;",
      "whether they take card; whether Dave needs parking; whether they can send a reminder; what to do if it overflows before then.",
      "Then ask: \"Sorry, remind me — what day and time did you book me for, and how did you spell my surname?\"",
      "Check their answer against what was actually booked and your real spelling. If anything is wrong, say so.",
      "Then say goodbye.",
    ].join("\n"),
    maxTurns: 44,
    expect: { books: true, finalActive: 1 },
  },
  {
    id: "S5",
    title: "\"Sorry?\" mid-booking",
    goal: [
      "Your shower mixer is leaking. Not urgent.",
      "The FIRST time the receptionist offers you appointment times, reply ONLY with \"Sorry?\" — as if you didn't hear.",
      "After they repeat themselves, pick the first time they offered.",
      "Later, once they've read your booking back to you, say \"Sorry, say that again?\" once.",
      "Then confirm it and say goodbye.",
    ].join("\n"),
    maxTurns: 30,
    expect: { books: true, finalActive: 1 },
  },
  {
    id: "S7",
    title: "Look up and cancel an earlier booking",
    goal: [
      "You booked a plumber visit with them on an EARLIER call, for a leaking tap, and you're not sure which day it was.",
      "Ask them to check what you've got booked. Give your name when asked (spell the surname if they ask you to).",
      "When they tell you what they found, say your partner already fixed the tap, so please cancel that booking.",
      "If they ask you to confirm the cancellation, confirm it. Don't book anything new.",
      "When it's cancelled, say \"That's all, thanks — bye.\"",
    ].join("\n"),
    maxTurns: 24,
    earlierBookings: [{ businessDay: 1, time: "10:00" }],
    expect: { books: false, finalActive: 0, cancels: true },
  },
  {
    id: "S8",
    title: "Sunday afternoon: this week, then today",
    goal: [
      "You want a plumber to install a new kitchen sink.",
      "First ask: \"Can I see if there is any available appointment this week?\"",
      "Whatever they say, then say: \"Today is fine.\"",
      "Then take the earliest time they offer. Give your name when asked (spell the surname if they ask you to).",
      "When it's booked, say \"That's all, thanks — bye.\"",
    ].join("\n"),
    maxTurns: 24,
    clock: "2026-10-18T03:32:00Z", // Sunday 18 Oct 2026, 2:32 PM in Sydney — phone test F5
    expect: { books: true, finalActive: 1 },
  },
  {
    id: "S9",
    title: "Spanish speaker",
    goal: [
      "You'd rather speak Spanish. Start by asking, in English: \"Do you speak Spanish?\"",
      "If they say yes, speak only Spanish from then on.",
      "You want someone to fix a dripping kitchen tap. Take the first time they offer on the next business day.",
      "Give your name when asked, and spell the surname (K-H-O-U-R-Y) if they ask you to.",
      "When it's booked, say goodbye in Spanish.",
    ].join("\n"),
    maxTurns: 24,
    expect: { books: true, finalActive: 1, language: "es" },
  },
  {
    id: "S10",
    title: "Asks for Arabic",
    goal: [
      "Start by asking: \"Can you speak Arabic?\"",
      "If they say they can't, say \"No worries, English is fine\" and carry on in English.",
      "You want someone to unblock a bathroom drain. Take the first time they offer on the next business day.",
      "Give your name when asked (spell the surname if they ask you to).",
      "When it's booked, say \"That's all, thanks — bye.\"",
    ].join("\n"),
    maxTurns: 24,
    expect: { books: true, finalActive: 1, language: "unsupported" },
  },
  {
    id: "S11",
    title: "French speaker: book, then cancel",
    goal: [
      "You'd rather speak French. Start by saying, in French: \"Bonjour, vous parlez français ?\"",
      "Speak only French for the whole call.",
      "Your hot water has been lukewarm for two days. Not urgent. Book the first visit time they offer.",
      "Give your name when asked, and spell the surname (K-H-O-U-R-Y) if they ask you to.",
      "As soon as they tell you it's booked, say your partner has already found someone else, so please cancel that booking. If they ask you to confirm the cancellation, confirm it.",
      "When it's cancelled, say goodbye in French.",
    ].join("\n"),
    maxTurns: 34,
    expect: { books: true, finalActive: 0, cancels: true, language: "fr" },
  },
  {
    id: "S12",
    title: "Japanese speaker",
    goal: [
      "You'd rather speak Japanese. Start by asking, in English: \"Do you speak Japanese?\"",
      "If they say yes, speak only polite Japanese from then on.",
      "You want someone to fix a toilet that keeps running. Take the first time they offer on the next business day.",
      "Give your name when asked. Your surname is written K-H-O-U-R-Y in English letters: spell it that way if they ask.",
      "When it's booked, say goodbye in Japanese.",
    ].join("\n"),
    maxTurns: 24,
    expect: { books: true, finalActive: 1, language: "ja" },
  },
  {
    id: "S6",
    title: "Message for Dave, then goodbye",
    goal: [
      "There's a small leak under your laundry sink; it's under control.",
      "You do NOT want to book a visit today. You want Dave to ring you back to talk about a quote for a new laundry tub.",
      "First ask what the call-out fee is. Then ask them to get Dave to call you. Give your details when asked.",
      "When they've taken the message, say \"That's all, thanks — bye.\"",
    ].join("\n"),
    maxTurns: 24,
    expect: { books: false, finalActive: 0 },
  },
];
