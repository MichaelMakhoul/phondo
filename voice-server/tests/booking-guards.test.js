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
  cancelConfirmation,
  isPlainYes,
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

describe("isPlainYes (the only yes that confirms a cancel)", () => {
  for (const yes of ["Yes.", "Yes please.", "Yep, go ahead and cancel it.", "Yeah, cancel that one.", "Correct.", "Sure, no worries."]) {
    it(`"${yes}" is a plain yes`, () => assert.equal(isPlainYes(yes), true));
  }
  for (const no of ["Definitely not.", "Absolutely not!", "I'm not sure.", "Okay, hold on.", "Okay, no, don't.", "Yeah, no, leave it.", "Right, hmm, I'm not sure actually.", "Yes, but keep the Tuesday one.", "Yeah, the Monday 9 AM one we just made, please cancel that one now."]) {
    it(`"${no}" is not`, () => assert.equal(isPlainYes(no), false));
  }
});

describe("cancelConfirmation (B4: the AI's own 'cancel <that day>?' answered with a plain yes)", () => {
  it("returns the caller's yes when the AI's last question was to cancel that day's booking", () => {
    assert.equal(cancelConfirmation([ai("Do you want me to cancel the Monday 9 AM booking?"), caller("Yes please.")], MON_9), 1);
    assert.equal(cancelConfirmation([ai("Just to confirm, cancel Monday at 9? Yes or no?"), caller("Yes.")], MON_9), 1);
    assert.equal(cancelConfirmation([ai("Shall I cancel your booking on the 19th?"), caller("Yep.")], MON_9), 1);
  });

  it("only the last question counts, and it must be the cancel itself", () => {
    for (const q of [
      "Sure, I can cancel that. Can I confirm your name is Sami Khoury?",
      "Would you like to reschedule instead of cancelling?",
      "Shall I keep the booking rather than cancel it?",
      "Do you want to cancel it, or move it to another day?",
      "Sure, I can cancel that for you. What date is the appointment on?",
      "I couldn't find an appointment to cancel on that day. Could you double-check the date?",
      "Your Monday booking is cancelled. Anything else?",
      "I can cancel the Monday booking.",
    ]) {
      assert.equal(cancelConfirmation([ai(q), caller("Yes.")], MON_9), -1, q);
    }
  });

  it("the question must name the day being cancelled", () => {
    assert.equal(cancelConfirmation([ai("Do you want me to cancel the Monday 9 AM booking?"), caller("Yes.")], { datetime: "2026-10-22T09:00:00" }), -1, "Thursday's cancel");
    assert.equal(cancelConfirmation([ai("Do you want me to cancel the booking?"), caller("Yes.")], MON_9), -1, "no day named");
    assert.equal(cancelConfirmation([ai("Do you want me to cancel the Monday 9 AM booking?"), caller("Yes.")], {}), -1, "no day to check against");
  });

  it("a yes that hedges or rambles is not a plain yes (the irreversible cancel needs one)", () => {
    for (const reply of ["Yes, but keep the Tuesday one.", "Yeah, the Monday 9 AM one we just made, please cancel that one now."]) {
      assert.equal(cancelConfirmation([ai("Do you want me to cancel the Monday 9 AM booking?"), caller(reply)], MON_9), -1, reply);
    }
  });

  it("the cancel question must be the last thing the AI said", () => {
    assert.equal(cancelConfirmation([ai("Cancel the Monday 9 AM booking? Otherwise I could move it for you."), caller("Yes.")], MON_9), -1);
  });

  it("a negation is never a yes", () => {
    for (const no of ["Definitely not.", "Absolutely not!", "I'm not sure.", "Okay, hold on.", "Okay, no, don't."]) {
      assert.equal(cancelConfirmation([ai("Do you want me to cancel the Monday 9 AM booking?"), caller(no)], MON_9), -1, no);
    }
  });

  it("only the AI's last words before the caller's last words count", () => {
    assert.equal(cancelConfirmation([ai("Do you want me to cancel the Monday booking?"), caller("Hang on."), ai("Sure, take your time."), caller("Yes.")], MON_9), -1);
    assert.equal(cancelConfirmation([caller("Cancel Monday?")], MON_9), -1);
    assert.equal(cancelConfirmation([], MON_9), -1);
  });
});

describe("fastCancelGate", () => {
  const session = (lines) => {
    const s = new CallSession("CA-gate");
    s.bookingGuards = true;
    for (const l of lines) s.addMessage(l.role, l.content);
    return s;
  };

  it("a plain yes to 'cancel Monday at 9?' lets that cancel through — once", () => {
    const s = session([ai("Do you want me to cancel the Monday 9 AM booking?"), caller("Yes please.")]);
    assert.deepEqual(fastCancelGate(s, MON_9, 1000), { proceed: true, callerConfirmed: true });
    s.clearCancelConfirmation(); // the cancel went through
    assert.deepEqual(fastCancelGate(s, MON_9, 2000), { proceed: false, callerConfirmed: false }, "the same yes never confirms a second cancel");
  });

  it("a cancel with no date or phone of the model's own is held every time, whatever the caller said", () => {
    const s = session([ai("Do you want me to cancel the Monday 9 AM booking?"), caller("Yes please.")]);
    assert.equal(fastCancelGate(s, {}, 1000).proceed, false);
    s.addMessage("assistant", "Which booking?");
    s.addMessage("user", "Yes.");
    assert.equal(fastCancelGate(s, {}, 2000).proceed, false);
  });

  it("without the caller's yes it is the gate: held, then confirmed by the retry after the caller answers", () => {
    const s = session([caller("Cancel Monday please.")]);
    assert.equal(fastCancelGate(s, MON_9, 1000).proceed, false);
    assert.equal(fastCancelGate(s, MON_9, 1001).proceed, false, "the model's instant retry");
    s.addMessage("assistant", "Cancel Monday at 9 AM, is that right?");
    s.addMessage("user", "Yes.");
    assert.equal(fastCancelGate(s, MON_9, 2000).proceed, true);
  });
});

describe("forgetCancelledBooking (the ledger after a fast-path cancel)", () => {
  const ledger = () => new Map([
    [bookingKey({ datetime: "2026-10-19T09:00:00", first_name: "Sami" }), { datetime: "2026-10-19T09:00:00", name: "Sami Khoury", at: 1 }],
    [bookingKey({ datetime: "2026-10-20T10:00:00", first_name: "Lina" }), { datetime: "2026-10-20T10:00:00", name: "Lina Khoury", at: 2 }],
  ]);

  it("forgets only the cancelled booking and says what is left", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { datetime: "2026-10-19T09:00" }, normalizeDatetime), { remaining: 1 });
    assert.deepEqual([...l.values()].map((e) => e.name), ["Lina Khoury"]);
  });

  it("an earlier call's booking leaves this call's ledger alone", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { datetime: "2026-10-23T09:00" }, normalizeDatetime), { remaining: 2 });
  });

  it("a cancel it can't place (no time or date) forgets them all, as before", () => {
    const l = ledger();
    assert.deepEqual(forgetCancelledBooking(l, { confirmation_code: "123456" }, normalizeDatetime), { remaining: 0 });
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
  it("a plain no to 'anything else?' is done", () => {
    assert.equal(callerIsDone([ai("Is there anything else I can help with?"), caller("No.")]), true);
    assert.equal(callerIsDone([ai("Is everything correct?"), caller("No.")]), false, "a no to anything else is not");
  });
  for (const notDone of ["Yep, that's all correct. Thanks.", "Yes, that's right.", "Thanks.", "What's the call-out fee?", "Yep, that's it, thanks.", "Yep, all good.", "Perfect, cheers."]) {
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
