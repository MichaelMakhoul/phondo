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
  expect: {
    /** The caller ends up booked (S1, S2, S4, S5) — checkpoint 2 applies. */
    books: boolean;
    /** Active appointments this caller holds when the call ends. */
    finalActive: number;
    /** The caller asks to MOVE the booking (checkpoint 6). */
    moves?: boolean;
    /** The caller asks to CANCEL the booking (checkpoint 7). */
    cancels?: boolean;
  };
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
