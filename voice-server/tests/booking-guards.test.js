"use strict";

// SCRUM-594 PHASE 2 (B2–B4): the fast path's booking guards. The simulated-call
// baseline (scripts/sim-calls, 2026-10-17) reproduced every phone-test failure:
// a surname booked as the STT heard it ("Curry" for "Khoury") in 9 of 15 calls
// and never spelled back in any, and cancels that took four confirmations.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  spelledRuns,
  spellableLetters,
  isAffirmative,
  surnameSpellingConfirmed,
  spellingHoldMessage,
  declinesCancel,
  fastCancelGate,
  forgetCancelledBooking,
  checkBookingGuards,
  SPELLING_HOLD_CAP,
} = require("../lib/booking-guards");
const { CallSession } = require("../call-session");
const { bookingKey } = require("../lib/booking-key");

const ai = (content) => ({ role: "assistant", content });
const caller = (content) => ({ role: "user", content });

describe("spelledRuns", () => {
  it("reads hyphenated, comma, dotted and spaced spellings", () => {
    assert.deepEqual(spelledRuns("That's K-H-O-U-R-Y, right?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("So K, H, O, U, R, Y?"), ["KHOURY"]);
    assert.deepEqual(spelledRuns("K h o u r y."), ["KHOURY"]);
    assert.deepEqual(spelledRuns("It's M. A. K. H. O. U. L."), ["MAKHOUL"]);
  });

  it("never swallows the s of an apostrophe or a word's last letter", () => {
    assert.deepEqual(spelledRuns("That's K-H-O-U-R-Y."), ["KHOURY"]);
    assert.deepEqual(spelledRuns("Sami's surname is S-M-I-T-H"), ["SMITH"]);
  });

  it("finds nothing in plain speech, and needs at least two letters", () => {
    assert.deepEqual(spelledRuns("I booked you in for Monday at 9 a.m."), []);
    assert.deepEqual(spelledRuns("Plan B is fine"), []);
    assert.deepEqual(spelledRuns(""), []);
    assert.deepEqual(spelledRuns(undefined), []);
  });

  it("a run ends before a following word: \"…R-Y. I'll pop that in\" is KHOURY", () => {
    assert.deepEqual(spelledRuns("That's K-H-O-U-R-Y. I'll pop that in."), ["KHOURY"]);
  });

  it("reads several spellings in one message", () => {
    assert.deepEqual(spelledRuns("Is it C-U-R-R-Y or K-H-O-U-R-Y?"), ["CURRY", "KHOURY"]);
  });
});

describe("spellableLetters", () => {
  it("keeps A–Z only, folding accents and dropping hyphens and apostrophes", () => {
    assert.equal(spellableLetters("Khoury"), "KHOURY");
    assert.equal(spellableLetters("O'Brien"), "OBRIEN");
    assert.equal(spellableLetters("Nguyen-Okafor"), "NGUYENOKAFOR");
    assert.equal(spellableLetters("Müller"), "MULLER");
  });

  it("is empty for a surname in another script (it can't be spelled back in letters)", () => {
    assert.equal(spellableLetters("خوري"), "");
    assert.equal(spellableLetters(""), "");
    assert.equal(spellableLetters(undefined), "");
  });
});

describe("isAffirmative", () => {
  for (const yes of ["Yes", "Yep, that's right.", "Yeah, correct", "That's it", "Spot on, thanks", "Sure", "Mm-hmm", "Yes please, book it"]) {
    it(`"${yes}" is a yes`, () => assert.equal(isAffirmative(yes), true));
  }
  for (const no of ["No, it's K-H-O-U-R-I", "Nope", "Not quite", "That's wrong", "Wait, hang on", "Yeah nah", "", "The one I'm calling from"]) {
    it(`"${no}" is not a yes`, () => assert.equal(isAffirmative(no), false));
  }
  it("a yes that mentions what it isn't is still a yes", () => {
    assert.equal(isAffirmative("Yes, Khoury, not Curry"), true);
  });
});

describe("surnameSpellingConfirmed", () => {
  it("confirmed: the AI spelled it back and the caller said yes", () => {
    const t = [ai("Can I get your name?"), caller("Sami Curry"), ai("That's K-H-O-U-R-Y?"), caller("Yes.")];
    assert.deepEqual(surnameSpellingConfirmed(t, "Khoury"), { confirmed: true, reason: "confirmed" });
  });

  it("not confirmed: never spelled back (the baseline's every booking)", () => {
    const t = [ai("Can I get your name?"), caller("It's Sami Curry."), ai("Thanks, Sami. Want me to book Monday at 9?"), caller("Yes please.")];
    assert.equal(surnameSpellingConfirmed(t, "Curry").confirmed, false);
    assert.equal(surnameSpellingConfirmed(t, "Curry").reason, "not-read-back");
  });

  it("not confirmed: the caller spelled it but the AI never read it back", () => {
    const t = [ai("Could you spell that?"), caller("K h o u r y."), ai("Thanks! Monday at 9 suit you?"), caller("Yep.")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").reason, "not-read-back");
  });

  it("not confirmed: the spelling read back is a different name from the one being booked", () => {
    const t = [ai("That's C-U-R-R-Y?"), caller("Yes.")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").confirmed, false);
  });

  it("not confirmed: the caller corrected the spelling read back", () => {
    assert.deepEqual(surnameSpellingConfirmed([ai("That's C-U-R-R-Y?"), caller("No, K-H-O-U-R-Y.")], "Curry"), { confirmed: false, reason: "caller-respelled" });
    assert.deepEqual(surnameSpellingConfirmed([ai("That's C-U-R-R-Y?"), caller("No, that's wrong.")], "Curry"), { confirmed: false, reason: "not-affirmed" });
  });

  it("not confirmed: the caller re-spelled it differently while saying yes", () => {
    const t = [ai("That's K-H-O-U-R-Y?"), caller("Yes, K-H-O-U-R-I.")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").reason, "caller-respelled");
  });

  it("not confirmed: the read-back is still waiting for an answer", () => {
    const t = [caller("It's Sami Curry"), ai("That's K-H-O-U-R-Y?")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").reason, "awaiting-reply");
  });

  it("the latest read-back decides: a wrong one corrected, then the right one confirmed", () => {
    const t = [ai("That's C-U-R-R-Y?"), caller("No, K-H-O-U-R-Y."), ai("Sorry! K-H-O-U-R-Y?"), caller("Yes.")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").confirmed, true);
  });

  it("a read-back with a one-letter word run into it still counts (\"…R-Y, a lovely name\")", () => {
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Y, a lovely name. Is that right?"), caller("Yes.")], "Khoury").confirmed, true);
    assert.equal(surnameSpellingConfirmed([ai("Is it a K-H-O-U-R-Y?"), caller("Yes.")], "Khoury").confirmed, true);
  });

  it("a confirmation stays good later in the call", () => {
    const t = [ai("That's K-H-O-U-R-Y?"), caller("Yep."), ai("And your number?"), caller("This one."), ai("Monday at 9 okay?"), caller("Yes.")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").confirmed, true);
  });

  it("a yes to ANOTHER question asked after the read-back is not a yes to the spelling (sim S4: 'Got it, K-H-O-U-R-Y. And is the best mobile…?' — 'Yep')", () => {
    const t = [ai("Got it, K-H-O-U-R-Y. And is the best mobile to reach you on the number you're calling from?"), caller("Yep, the number I'm calling from is fine.")];
    assert.deepEqual(surnameSpellingConfirmed(t, "Khoury"), { confirmed: false, reason: "not-asked" });
  });

  it("a short generic check after the read-back is the spelling question", () => {
    for (const q of ["Is that right?", "Did I get that right?", "Correct?", "Is that spelled right?"]) {
      assert.equal(surnameSpellingConfirmed([ai(`Got it, K-H-O-U-R-Y. ${q}`), caller("Yes.")], "Khoury").confirmed, true, q);
    }
    assert.equal(surnameSpellingConfirmed([ai("Got it, K-H-O-U-R-Y. And your number?"), caller("Yes.")], "Khoury").confirmed, false, "a short question about something else");
    assert.equal(
      surnameSpellingConfirmed([ai("Got it, K-H-O-U-R-Y. And is the number you're calling from the right one to reach you on?"), caller("Yes.")], "Khoury").confirmed,
      false,
      "a long question that happens to say 'right' is about something else",
    );
  });

  it("re-review: a longer question about the spelling itself counts; a longer question about something else doesn't", () => {
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Y. Is that how you spell it?"), caller("Yes.")], "Khoury").confirmed, true);
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Y. Is that the correct spelling of your last name?"), caller("Yes.")], "Khoury").confirmed, true);
    assert.equal(surnameSpellingConfirmed([ai("Got it, K-H-O-U-R-Y. Is the number you're calling from the right one?"), caller("Yes.")], "Khoury").reason, "not-asked");
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Y. Could you spell your first name for me?"), caller("Sure.")], "Khoury").reason, "not-asked");
    assert.equal(surnameSpellingConfirmed([ai("K-H-O-U-R-Y. How do you spell your email?"), caller("Sure, it's sami at gmail.")], "Khoury").reason, "not-asked");
  });

  it("a read-back with no question, answered yes, confirms", () => {
    assert.equal(surnameSpellingConfirmed([ai("So that's K-H-O-U-R-Y."), caller("Yep.")], "Khoury").confirmed, true);
  });

  it("a read-back inside a booking question, answered yes, confirms", () => {
    const t = [ai("So that's Sami K-H-O-U-R-Y on Monday at 9, shall I book it?"), caller("Yes please.")];
    assert.equal(surnameSpellingConfirmed(t, "Khoury").confirmed, true);
  });

  it("a surname that can't be spelled in letters is never held", () => {
    assert.equal(surnameSpellingConfirmed([], "خوري").confirmed, true);
    assert.equal(surnameSpellingConfirmed([], "").confirmed, true);
    assert.equal(surnameSpellingConfirmed([], "O").confirmed, true);
  });
});

describe("spellingHoldMessage", () => {
  it("tells the model what it would save, letter by letter, to ask it as its own question, and to wait for a yes", () => {
    const m = spellingHoldMessage("Curry");
    assert.match(m, /^DO NOT BOOK YET/);
    assert.match(m, /C-U-R-R-Y/);
    assert.match(m, /Is that right\?/);
    assert.match(m, /book_appointment again only after they say yes/);
    assert.doesNotMatch(m, /hasn't confirmed/, "never claims what the caller did (the model contradicted it: 'You've already confirmed…')");
  });
});

const MON_9 = { datetime: "2026-10-19T09:00:00" }; // a Monday

describe("declinesCancel (a caller's clear no to a cancel)", () => {
  for (const no of [
    "No.", "Nope", "Nah.", "No thanks.", "No, don't cancel it, I'll keep it.", "Actually no, leave it.", "Never mind.",
    "I don't want to cancel it anymore.", "I'm not sure anymore.", "I've changed my mind.", "Keep the booking please.",
    // re-review 3
    "No, keep it.", "No, don't.", "No, wait.", "No, no.", "Hold on, no.", "Wait.",
  ]) {
    it(`"${no}" takes it back`, () => assert.equal(declinesCancel(no), true));
  }
  for (const yes of [
    "No worries, go ahead.", "Nah yeah, cancel it.", "No problem, yes please.", "No, I mean the one you just booked. Please cancel that.",
    "No, just cancel it.", "Yes.", "I'll keep it handy.",
    // re-review 3: a yes is never a decline unless it says "don't cancel"
    "Yes please, I can't keep the appointment.", "Yeah never mind, cancel it.", "Yes, forget it.",
  ]) {
    it(`"${yes}" does not`, () => assert.equal(declinesCancel(yes), false));
  }
  it("a yes that says don't cancel is a decline", () => assert.equal(declinesCancel("Yes, I mean don't cancel it."), true));
});

describe("fastCancelGate (structural: no 'yes' is read off the transcript)", () => {
  const session = (lines) => {
    const s = new CallSession("CA-gate");
    s.bookingGuards = true;
    for (const l of lines) s.addMessage(l.role, l.content);
    return s;
  };
  const say = (s, role, text) => s.addMessage(role, text);

  it("holds the first attempt — even after the AI asked and the caller said yes — and the retry after the caller's answer goes through", () => {
    const s = session([ai("Do you want me to cancel the Monday 9 AM booking?"), caller("Yes, the three PM one.")]);
    assert.deepEqual(fastCancelGate(s, MON_9, 1000), { proceed: false, via: null, reason: "first-attempt", dropped: 0 });
    assert.deepEqual(fastCancelGate(s, MON_9, 1001), { proceed: false, via: null, reason: "awaiting-caller", dropped: 0 }, "the model's instant retry");
    say(s, "assistant", "To confirm, cancel Monday the 19th at 9 AM?");
    say(s, "user", "Yes.");
    assert.deepEqual(fastCancelGate(s, MON_9, 2000), { proceed: true, via: "retry", reason: null, dropped: 0 });
  });

  it("a cancel with no date or phone of the model's own is held every time", () => {
    const s = session([caller("Cancel it.")]);
    assert.equal(fastCancelGate(s, {}, 1000).reason, "no-identifier");
    say(s, "assistant", "Which booking?");
    say(s, "user", "Yes.");
    assert.equal(fastCancelGate(s, {}, 2000).proceed, false);
  });

  it("two cancels in one reply each keep their own hold, and both go through after the caller's yes", () => {
    const TUE_2 = { datetime: "2026-10-20T14:00:00" };
    const s = session([caller("Cancel both, please.")]);
    assert.equal(fastCancelGate(s, MON_9, 1000).proceed, false);
    assert.equal(fastCancelGate(s, TUE_2, 1001).proceed, false);
    say(s, "assistant", "Cancel Monday at 9 and Tuesday at 2?");
    say(s, "user", "Yes, both.");
    assert.equal(fastCancelGate(s, MON_9, 2000).proceed, true);
    s.clearCancelConfirmation(MON_9); // Monday's cancel went through
    assert.equal(fastCancelGate(s, TUE_2, 2001).proceed, true, "Tuesday's hold survived Monday's cancel");
  });

  it("the caller's no drops a held cancel and a remembered confirmation", () => {
    const s = session([caller("Cancel Monday please.")]);
    assert.equal(fastCancelGate(s, MON_9, 1000).proceed, false);
    say(s, "assistant", "Cancel Monday at 9 AM, is that right?");
    say(s, "user", "No, don't cancel it, I'll keep it.");
    assert.deepEqual(fastCancelGate(s, MON_9, 2000), { proceed: false, via: null, reason: "caller-declined", dropped: 1 });
    const t = session([caller("Cancel Monday please.")]);
    fastCancelGate(t, MON_9, 1000);
    say(t, "assistant", "Cancel Monday at 9?");
    say(t, "user", "Yes.");
    assert.equal(fastCancelGate(t, MON_9, 2000).proceed, true); // the handler then wants a detail
    say(t, "assistant", "What's the name on the booking?");
    say(t, "user", "Actually no, leave it.");
    say(t, "assistant", "No problem.");
    say(t, "user", "Thanks.");
    assert.equal(fastCancelGate(t, MON_9, 3000).proceed, false, "a decline at any point after the confirmation drops it");
  });

  it("re-review 3: a held cancel isn't confirmed by the caller's next words unless the AI spoke after the hold (a talked-over read-back)", () => {
    const s = session([caller("Cancel Monday please.")]);
    assert.equal(fastCancelGate(s, MON_9, 1000).proceed, false);
    say(s, "user", "and also the Tuesday one if you can"); // the read-back never got said
    assert.equal(fastCancelGate(s, MON_9, 2000).proceed, false);
    say(s, "assistant", "Cancel Monday at 9 AM?");
    say(s, "user", "Yes.");
    assert.equal(fastCancelGate(s, MON_9, 3000).proceed, true);
  });

  it("re-review 3: right after the caller's no, the model's cancel is held without a new hold their next words could confirm", () => {
    const s = session([caller("Cancel Monday please.")]);
    fastCancelGate(s, MON_9, 1000);
    say(s, "assistant", "Cancel Monday at 9 AM?");
    say(s, "user", "No.");
    assert.equal(fastCancelGate(s, MON_9, 2000).reason, "caller-declined");
    say(s, "assistant", "Okay, I'll leave it.");
    say(s, "user", "Thanks.");
    assert.equal(fastCancelGate(s, MON_9, 3000).proceed, false, "held as a first attempt again");
  });

  it("re-review 3: a date-only confirmation is spent by that day's cancel — it never covers another booking that day", () => {
    const s = session([caller("Cancel Monday.")]);
    const MON = { date: "2026-10-19" };
    fastCancelGate(s, MON, 1000);
    say(s, "assistant", "Cancel your Monday booking?");
    say(s, "user", "Yes.");
    assert.equal(fastCancelGate(s, MON, 2000).proceed, true); // the handler: "which one?" — the model picks 9 AM
    s.clearCancelConfirmation({ datetime: "2026-10-19T09:00:00" }); // the 9 AM cancel went through
    assert.equal(fastCancelGate(s, MON, 3000).proceed, false, "the 2 PM needs its own read-back");
  });

  it("re-review 3 (P1): a cancel first held with only a phone is not confirmed by an attempt that names a booking — that booking gets its own read-back", () => {
    const PHONE = { phone: "+61412555013" };
    const TUE_2 = { phone: "+61412555013", datetime: "2026-10-20T14:00:00" };
    const s = session([caller("I need to cancel my booking.")]);
    assert.equal(fastCancelGate(s, PHONE, 1000).proceed, false);
    say(s, "assistant", "Sure, which day is it on?");
    say(s, "user", "Tuesday.");
    assert.deepEqual(fastCancelGate(s, TUE_2, 2000), { proceed: false, via: null, reason: "first-attempt", dropped: 0 });
    say(s, "assistant", "Cancel Tuesday the 20th at 2 PM?");
    say(s, "user", "Yes.");
    assert.equal(fastCancelGate(s, TUE_2, 3000).proceed, true);
    // …and by an attempt that names only the day
    const t = session([caller("I need to cancel my booking.")]);
    assert.equal(fastCancelGate(t, PHONE, 1000).proceed, false);
    say(t, "assistant", "Sure, which day is it on?");
    say(t, "user", "Tuesday.");
    assert.equal(fastCancelGate(t, { phone: "+61412555013", date: "2026-10-20" }, 2000).proceed, false);
  });

  it("re-review 3 (P2): a less specific attempt never rewrites what a held cancel is for", () => {
    const s = session([caller("Cancel Monday at 9.")]);
    assert.equal(fastCancelGate(s, MON_9, 1000).proceed, false);
    assert.equal(fastCancelGate(s, { phone: "+61412555013" }, 1001).proceed, false);
    say(s, "assistant", "Cancel Monday at 9 AM?");
    say(s, "user", "Actually it's Tuesday at 2.");
    assert.equal(fastCancelGate(s, { phone: "+61412555013", datetime: "2026-10-20T14:00:00" }, 2000).proceed, false, "Tuesday was never read back");
  });

  it("re-review 3 (P1b): a date-only hold is not confirmed by a timed attempt that day", () => {
    const s = session([caller("Cancel Monday.")]);
    assert.equal(fastCancelGate(s, { date: "2026-10-19" }, 1000).proceed, false);
    say(s, "assistant", "Which time on Monday?");
    say(s, "user", "The 2 PM.");
    assert.equal(fastCancelGate(s, { datetime: "2026-10-19T14:00:00" }, 2000).proceed, false);
  });

  it("says why it held: no identifier, a first attempt, or waiting for the caller", () => {
    const s = session([caller("Cancel it.")]);
    assert.equal(fastCancelGate(s, {}, 1000).reason, "no-identifier");
    assert.equal(fastCancelGate(s, MON_9, 1001).reason, "first-attempt");
    assert.equal(fastCancelGate(s, MON_9, 1002).reason, "awaiting-caller");
  });
});

describe("forgetCancelledBooking (the ledger after a fast-path cancel)", () => {
  const ledger = () => new Map([
    [bookingKey({ datetime: "2026-10-19T09:00:00", first_name: "Sami" }), { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }],
    [bookingKey({ datetime: "2026-10-20T10:00:00", first_name: "Lina" }), { datetime: "2026-10-20T10:00:00", name: "Lina Khoury", at: 2 }],
  ]);

  it("forgets only the cancelled booking and says what is left", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { datetime: "2026-10-19T09:00" }, normalizeDatetime), { remaining: 1, clearedAll: false });
    assert.deepEqual([...l.values()].map((e) => e.name), ["Lina Khoury"]);
  });

  it("re-review: within 15 minutes is the same booking (the handler matches ±15 min)", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { datetime: "2026-10-19T09:10" }, normalizeDatetime), { remaining: 1, clearedAll: false });
    assert.deepEqual([...l.values()].map((e) => e.name), ["Lina Khoury"]);
  });

  it("an exact time wins, and otherwise the closest — never both of two nearby bookings", () => {
    const two = () => new Map([
      ["a", { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }],
      ["b", { datetime: "2026-10-19T09:15:00", name: "Lina Khoury", at: 2 }],
    ]);
    const l = two();
    assert.deepEqual(forgetCancelledBooking(l, { datetime: "2026-10-19T09:00" }, normalizeDatetime), { remaining: 1, clearedAll: false });
    assert.deepEqual([...l.values()].map((e) => e.name), ["Lina Khoury"]);
    const m = two();
    forgetCancelledBooking(m, { datetime: "2026-10-19T09:12" }, normalizeDatetime);
    assert.deepEqual([...m.values()].map((e) => e.name), ["Sami Khoury"], "9:12 is closest to 9:15");
  });

  it("an earlier call's booking leaves this call's ledger alone", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { datetime: "2026-10-23T09:00" }, normalizeDatetime), { remaining: 2, clearedAll: false });
  });

  it("a cancel it can't place (no time or date) forgets them all, as before — and says so", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { confirmation_code: "123456" }, normalizeDatetime), { remaining: 0, clearedAll: true });
  });
});

function guardedSession({ transcript = [], booked = [] } = {}) {
  const confirmedBookings = new Map();
  for (const b of booked) confirmedBookings.set(bookingKey(b), { code: "123456", datetime: b.datetime, name: `${b.first_name} ${b.last_name}`, at: 1 });
  return { bookingGuards: true, bookingGuardState: { spellingHolds: 0, secondBookingNudged: false }, fullTranscriptMessages: transcript, confirmedBookings };
}
const BOOK = { datetime: "2026-10-19T09:00:00", first_name: "Sami", last_name: "Khoury" };

describe("checkBookingGuards", () => {
  it("holds an unspelled booking, then lets it through once the spelling is confirmed", () => {
    const s = guardedSession({ transcript: [caller("It's Sami Khoury")] });
    const held = checkBookingGuards(s, BOOK);
    assert.equal(held.kind, "spelling");
    assert.equal(held.hold, true);
    assert.equal(held.reason, "not-read-back");
    assert.match(held.message, /K-H-O-U-R-Y/);
    s.fullTranscriptMessages.push(ai("That's K-H-O-U-R-Y?"), caller("Yes."));
    assert.equal(checkBookingGuards(s, BOOK), null);
  });

  it(`stops holding after ${SPELLING_HOLD_CAP} caller turns of holds, so a call can never be stuck on it — and says so`, () => {
    const s = guardedSession({ transcript: [caller("It's Sami Khoury")] });
    for (let i = 0; i < SPELLING_HOLD_CAP; i++) {
      assert.equal(checkBookingGuards(s, BOOK)?.hold, true);
      s.fullTranscriptMessages.push(ai("Is that K-H-O-U-R-Y?"), caller("Mm."));
    }
    assert.deepEqual(checkBookingGuards(s, BOOK), { hold: false, kind: "spelling", capReached: true, reason: "not-affirmed" });
  });

  it("holds in the same caller turn count once (the model's instant retries can't spend the cap)", () => {
    const s = guardedSession({ transcript: [caller("It's Sami Khoury")] });
    for (let i = 0; i < SPELLING_HOLD_CAP + 2; i++) assert.equal(checkBookingGuards(s, BOOK)?.hold, true, `attempt ${i + 1}`);
  });

  it("a second booking at another time while this call holds one: nudged to move it, once", () => {
    const s = guardedSession({ transcript: [ai("That's K-H-O-U-R-Y?"), caller("Yes.")], booked: [BOOK] });
    const tuesday = { ...BOOK, datetime: "2026-10-20T10:00:00" };
    const nudge = checkBookingGuards(s, tuesday);
    assert.equal(nudge.kind, "second-booking");
    assert.match(nudge.message, /^NOT BOOKED — no new appointment was made\./, "the model can't relay a nudge as a booking");
    assert.match(nudge.message, /reschedule_appointment/);
    assert.match(nudge.message, /2026-10-19T09:00:00/);
    assert.match(nudge.message, /2026-10-20T10:00:00/);
    assert.equal(checkBookingGuards(s, tuesday), null, "the caller confirmed they want two: let it through");
  });

  it("a re-book of the same slot is left to the RebookGuard (same booking key)", () => {
    const s = guardedSession({ transcript: [ai("That's K-H-O-U-R-Y?"), caller("Yes.")], booked: [BOOK] });
    assert.equal(checkBookingGuards(s, { ...BOOK }), null);
  });

  it("does nothing on a session without the guards (Gemini, classic, owner)", () => {
    const s = { ...guardedSession(), bookingGuards: false };
    assert.equal(checkBookingGuards(s, BOOK), null);
  });

  it("reads the surname from `name` when last_name is missing", () => {
    const s = guardedSession({ transcript: [ai("That's K-H-O-U-R-Y?"), caller("Yes.")] });
    assert.equal(checkBookingGuards(s, { datetime: BOOK.datetime, name: "Sami Khoury" }), null);
    assert.equal(checkBookingGuards(guardedSession(), { datetime: BOOK.datetime, name: "Sami Curry" })?.kind, "spelling");
  });
});

const { withBookedName, noteNameCorrection, callerIsDone, checkCallerDone, END_CALL_HOLD_CAP } = require("../lib/booking-guards");
const { normalizeDatetime } = require("../lib/booking-key");

describe("withBookedName (B6: a booking this call made is changed under the name it was booked with)", () => {
  const ledgerOf = (...entries) => new Map(entries.map((e) => [bookingKey({ datetime: e.datetime, name: e.name }), e]));
  const MON = { code: "123456", datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 };

  it("fills `name` for a reschedule of this call's booking (phone test F1: the handler asked, 'Sorry?' became 'Deville', the move was refused)", () => {
    const out = withBookedName({ current_datetime: "2026-10-19T09:00:00", new_datetime: "2026-10-20T10:00:00", first_name: "Sami", last_name: "Khoury" }, ledgerOf(MON), normalizeDatetime);
    assert.equal(out.name, "Sami Khoury");
  });

  it("re-review: a time within 15 minutes of this call's booking is that booking", () => {
    assert.equal(withBookedName({ current_datetime: "2026-10-19T09:10:00", new_datetime: "2026-10-20T10:00:00" }, ledgerOf(MON), normalizeDatetime).name, "Sami Khoury");
    assert.equal("name" in withBookedName({ current_datetime: "2026-10-19T09:30:00" }, ledgerOf(MON), normalizeDatetime), false, "30 minutes off is not");
  });

  it("fills it for a cancel by datetime or by date", () => {
    assert.equal(withBookedName({ datetime: "2026-10-19T09:00" }, ledgerOf(MON), normalizeDatetime).name, "Sami Khoury");
    assert.equal(withBookedName({ date: "2026-10-19" }, ledgerOf(MON), normalizeDatetime).name, "Sami Khoury");
  });

  it("with no time given, fills it only when this call holds exactly one booking", () => {
    assert.equal(withBookedName({ new_datetime: "2026-10-20T10:00:00" }, ledgerOf(MON), normalizeDatetime).name, "Sami Khoury");
    const two = ledgerOf(MON, { code: "654321", datetime: "2026-10-21T14:00:00", name: "Lina Khoury", at: 2 });
    assert.equal("name" in withBookedName({ new_datetime: "2026-10-20T10:00:00" }, two, normalizeDatetime), false);
  });

  it("never guesses between two of this call's bookings (another person's name would be sent)", () => {
    const sameDay = ledgerOf(MON, { code: "654321", datetime: "2026-10-19T14:00:00", name: "Lina Khoury", at: 2 });
    assert.equal("name" in withBookedName({ date: "2026-10-19" }, sameDay, normalizeDatetime), false);
    const sameTime = new Map([["a", MON], ["b", { ...MON, name: "Lina Khoury", at: 2 }]]);
    assert.equal("name" in withBookedName({ current_datetime: "2026-10-19T09:00:00" }, sameTime, normalizeDatetime), false);
  });

  it("never overrides a name the model passed, and leaves other bookings alone", () => {
    assert.equal(withBookedName({ current_datetime: "2026-10-19T09:00:00", name: "Sam Khoury" }, ledgerOf(MON), normalizeDatetime).name, "Sam Khoury");
    assert.equal("name" in withBookedName({ current_datetime: "2026-10-23T09:00:00" }, ledgerOf(MON), normalizeDatetime), false, "not this call's booking");
    assert.equal("name" in withBookedName({ datetime: "2026-10-19T09:00:00" }, new Map(), normalizeDatetime), false);
  });
});

describe("noteNameCorrection (B6: the ledger follows a name fixed with update_appointment)", () => {
  it("replaces the corrected parts of the booked name", () => {
    const ledger = new Map([["k", { datetime: "2026-10-19T09:00:00", name: "Sami Curry", at: 1 }]]);
    noteNameCorrection(ledger, { last_name: "Khoury" }, normalizeDatetime);
    assert.equal(ledger.get("k").name, "Sami Khoury");
    noteNameCorrection(ledger, { datetime: "2026-10-19T09:00:00", first_name: "Samir", last_name: "Khoury" }, normalizeDatetime);
    assert.equal(ledger.get("k").name, "Samir Khoury");
  });

  it("does nothing without a name in the update or a booking to apply it to", () => {
    const ledger = new Map([["k", { datetime: "2026-10-19T09:00:00", name: "Sami Curry", at: 1 }]]);
    noteNameCorrection(ledger, { phone: "+61400000000" }, normalizeDatetime);
    noteNameCorrection(ledger, { datetime: "2026-10-23T09:00:00", last_name: "X" }, normalizeDatetime);
    assert.equal(ledger.get("k").name, "Sami Curry");
    noteNameCorrection(new Map(), { last_name: "Khoury" }, normalizeDatetime);
  });
});

describe("callerIsDone (B5: the AI ends the call only once the caller has)", () => {
  for (const done of ["Thanks, bye!", "No, that's all, thanks.", "That's everything, cheers", "Nope, I'm good.", "All good, thanks", "Have a good one"]) {
    it(`"${done}" is done`, () => assert.equal(callerIsDone([ai("You're booked in. Anything else?"), caller(done)]), true));
  }
  it("'Is that everything?' asks the same as 'anything else?' — 'Is that all correct?' does not", () => {
    assert.equal(callerIsDone([ai("You're booked. Is that everything?"), caller("Yep, that's it.")]), true);
    assert.equal(callerIsDone([ai("Monday at 9, Sami Khoury. Is that all correct?"), caller("Yep, all good.")]), false);
    assert.equal(callerIsDone([ai("Is that all right?"), caller("Perfect, cheers.")]), false);
    assert.equal(callerIsDone([ai("Monday at 9. Is that all, correct?"), caller("No, the time's wrong.")]), false);
    assert.equal(callerIsDone([ai("Is that all accurate?"), caller("No.")]), false);
  });

  it("a plain no to 'anything else?' is done", () => {
    assert.equal(callerIsDone([ai("Is there anything else I can help with?"), caller("No.")]), true);
    assert.equal(callerIsDone([ai("Is everything correct?"), caller("No.")]), false, "a no to anything else is not");
  });
  for (const notDone of ["Yep, that's all correct. Thanks.", "Yes, that's right.", "Thanks.", "What's the call-out fee?", "Yep, that's it, thanks.", "Yep, all good.", "Perfect, cheers.", "Yep, that's all fine.", "That's all perfect."]) {
    it(`"${notDone}" is not done (the baseline hung up on these)`, () => assert.equal(callerIsDone([ai("Is everything correct?"), caller(notDone)]), false));
  }
  it("nothing said yet is not done", () => assert.equal(callerIsDone([ai("Hello?")]), false));
});

describe("checkCallerDone", () => {
  const session = (lines) => ({ bookingGuards: true, bookingGuardState: { spellingHolds: 0, secondBookingNudged: false, endCallHolds: 0 }, fullTranscriptMessages: lines });

  it("holds an end_call the caller hasn't asked for, with what to do instead", () => {
    const held = checkCallerDone(session([ai("Is everything correct?"), caller("Yep, that's all correct. Thanks.")]));
    assert.match(held.message, /^DON'T END THE CALL YET/);
    assert.match(held.message, /anything else/);
  });

  it("lets it through once the caller is done", () => {
    assert.equal(checkCallerDone(session([ai("Anything else?"), caller("No, that's it, bye.")])), null);
  });

  it(`steps aside after ${END_CALL_HOLD_CAP} caller turns of holds — and says so — and does nothing without the guards`, () => {
    const s = session([ai("Is everything correct?"), caller("Thanks.")]);
    for (let i = 0; i < END_CALL_HOLD_CAP; i++) {
      assert.equal(checkCallerDone(s)?.allow, false);
      s.fullTranscriptMessages.push(ai("Anything else?"), caller("Hmm."));
    }
    assert.deepEqual(checkCallerDone(s), { allow: true, capReached: true });
    assert.equal(checkCallerDone({ ...session([caller("Thanks.")]), bookingGuards: false }), null);
  });

  it("holds in one caller turn count once", () => {
    const s = session([ai("Is everything correct?"), caller("Thanks.")]);
    for (let i = 0; i < END_CALL_HOLD_CAP + 2; i++) assert.equal(checkCallerDone(s)?.allow, false);
  });
});
