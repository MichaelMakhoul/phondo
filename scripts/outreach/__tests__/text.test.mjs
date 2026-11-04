import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  byContact,
  csvCells,
  firstTextsOn,
  main,
  messageProblem,
  normalizeText,
  optOut,
  parseBatch,
  planTexts,
  smsSegments,
  sydneyDate,
} from "../text.mjs";

// The texter sends real SMS, so its guards matter more than its happy path:
// Spam Act s 16 (record the consent), s 17 (say who it's from) and s 18 (a
// working opt-out); never anyone on the do-not-call list or who asked to stop;
// never a batch text twice; never two sends at once; and never the Twilio balance
// below the floor that keeps the phone lines up. Numbers are ACMA-reserved
// fictitious mobiles (0491 570 xxx), and fetch is always stubbed.

// Neither a test nor a regression may write into the operator's real
// ~/.phondo-outreach. main() reads HOME from the env it's given, which the harness
// points at ENV_HOME; HOME is also stubbed process-wide as a backstop.
const ENV_HOME = mkdtempSync(join(tmpdir(), "text-env-home-"));
const FAKE_HOME = mkdtempSync(join(tmpdir(), "text-home-"));
beforeEach(() => vi.stubEnv("HOME", FAKE_HOME));
afterAll(() => {
  vi.unstubAllEnvs();
  for (const dir of [ENV_HOME, FAKE_HOME]) rmSync(dir, { recursive: true, force: true });
});

const FROM = "+61485094768";
const A = "+61491570006";
const B = "+61491570156";
const C = "+61491570157";
const D = "+61491570158";
const E = "+61491570159";
const F = "+61491570110";
const OK_TEXT = "Hi there, Michael from Phondo. Ring our demo line. Reply STOP and I won't msg again.";
const SOURCE = "Mobile published at https://example.com.au/; checked 2026-10-05";
const row = (to, business = `Biz ${to.slice(-3)}`, text = OK_TEXT, source = SOURCE) => ({ to, business, text, source });
// Thursday 5 Nov 2026, noon in Sydney (AEDT, UTC+11).
const NOON = "2026-11-05T01:00:00Z";
const YESTERDAY = "Wed, 04 Nov 2026 01:00:00 +0000";

describe("smsSegments", () => {
  it.each([
    [160, 1],
    [161, 2],
    [306, 2],
    [307, 3],
  ])("GSM-7: %i characters are billed as %i segment(s)", (length, segments) => {
    expect(smsSegments("a".repeat(length))).toEqual({ encoding: "GSM-7", segments });
  });

  it("counts an extension-table character as two septets", () => {
    expect(smsSegments("€".repeat(80))).toEqual({ encoding: "GSM-7", segments: 1 }); // 160 septets
    expect(smsSegments("€".repeat(81)).segments).toBe(2); // 162
  });

  it("never splits a two-septet character across segments", () => {
    // 152 + 2 + 152 = 306 septets would fit 2 x 153, but the € can't straddle the boundary.
    expect(smsSegments(`${"a".repeat(152)}€${"a".repeat(152)}`).segments).toBe(3);
  });

  it("switches to UCS-2 for any character outside GSM-7, at 70/67 per segment", () => {
    expect(smsSegments("ć".repeat(70))).toEqual({ encoding: "UCS-2", segments: 1 });
    expect(smsSegments("ć".repeat(71))).toEqual({ encoding: "UCS-2", segments: 2 });
    expect(smsSegments("ć".repeat(134))).toEqual({ encoding: "UCS-2", segments: 2 }); // 2 x 67 exactly
    expect(smsSegments("won’t").encoding).toBe("UCS-2");
    // An emoji is two UTF-16 units and can't straddle a boundary either.
    expect(smsSegments(`${"ć".repeat(66)}😀${"ć".repeat(66)}`).segments).toBe(3);
  });

  it("treats GSM-7's accented letters as GSM-7", () => {
    expect(smsSegments("Café Müller £5 ¿").encoding).toBe("GSM-7");
  });
});

describe("normalizeText", () => {
  it("makes word-processor punctuation plain, so the text stays GSM-7", () => {
    const fancy = "“Hi” ‘mate’ – won’t — wait… ok";
    expect(normalizeText(fancy)).toBe("\"Hi\" 'mate' - won't - wait... ok");
    expect(smsSegments(normalizeText(fancy)).encoding).toBe("GSM-7");
  });

  it("trims", () => {
    expect(normalizeText("  hi \n")).toBe("hi");
  });
});

describe("messageProblem", () => {
  it("accepts a text that names Phondo and says Reply STOP", () => {
    expect(messageProblem(OK_TEXT)).toBeNull();
  });

  it.each([
    ["", /empty/],
    ["Hi, Michael here. Reply STOP to opt out.", /Phondo.*s 17/],
    ["Hi, Michael from Phondo.", /STOP.*s 18/],
    ["Hi, Michael from Phondo. Reply stop to opt out.", /STOP/], // must be the keyword, in capitals
    ["Hi, Michael from Phondo. NONSTOP service.", /STOP/], // a whole word, not part of one
    [`Phondo. Reply STOP. ${"a".repeat(600)}`, /5 SMS segments/],
  ])("refuses %j", (text, why) => {
    expect(messageProblem(text)).toMatch(why);
  });
});

describe("optOut", () => {
  it.each([
    "STOP", "stop", "Stop.", " STOP!!! ", "Unsubscribe", "unsub", "Unsub please", "STOPALL", "optout", "opt-out",
    "Cancel", "End", "Quit", "Revoke", "Remove", "REMOVE.", "Stop it", "Stop pls", "Stop please", "STOP STOP STOP",
    "stop stop", "Stop now", "Stop spamming me", "STOP SPAM", "STOP. Who is this?", "Stop, who is this?", "pls stop",
    "please stop", "ok stop it", "Stop calling me", "stop txting me", "Can you stop texting me", "Please stop messaging me now",
    "Please stop contacting me", "Can you stop sending these", "pls stop msging me", "Can you stop txting me",
    "Who is this? Stop", "Who gave you my number? STOP", "Thanks but please stop", "Can you please stop", "Mate I said stop",
    "Unsubscribed", "Delete", "Remove please", "Pls remove", "please remove", "Cancel please", "End now", "Quit texting me",
    "Remove from list", "Remove me from your list", "Delete me", "remove my number", "lose my number", "Take me off your list",
    "Opt me out", "Cancel mate", "Quit thanks", "Remove plz", "End thx", "Cancel ta", "Take me off", "Remove me", "Remove us",
    "Take me from your list", "Remove from ur list", "Take us off your list", "Please take us off the list", "Take us off",
    "Take my number off your list", "Take our number off your list", "Take this number off", "Can you take us off your list?",
    "Huh, stop? I said STOP", "Can you please stop?", "Could you stop?", "Will you stop?", "Can u stop?", "Can you just stop?",
    "Can you pls stop?", "Can you opt me out?", "Can you opt us out?", "Opt me out?", "Opt us out?", "Opt us out",
    "Opt me out. Who gave you my number?", "Remove me. Who is this?", "Who is this? Remove me", "Remove me?", "Take me off?",
    "Can you remove me?", "Please stop calling me", "I said stop texting me", "Lose our number", "Take the number off your list",
    "Delete from your list", "STOP?", "Please remove me from your contacts", "Remove us from your mailing list",
    "Take me off your mailing list", "Remove my number from your system", "Remove me, I'm not interested", "Opt me out of this",
    "Can you opt me out of these texts?", "Could you remove me?", "Can u remove me?", "Can you unsubscribe me?",
    "Can you stop contacting me", "Can you stop messaging me", "Can you stop msging me", "Hi\nPlease remove me",
    "Who is this! Remove me", "Who is this; remove me", "Lose this number", "Remove me from this list", "Cancel thanks mate",
    "Thanks mate, remove me", "Just lose my number", "Ok lose my number", "Lose my number cheers", "Lose my number, who is this",
    "Can you please remove me", "Can you please take us off your list", "Could you please unsubscribe me", "Can you just lose my number",
    "Hey remove me", "Hi please remove me", "Yes remove me", "Sorry remove me", "Remove me asap", "Remove me immediately",
    "Can you please just remove me", "Cancel, who is this?", "Please stop, who are you?", "Just cancel", "Yeah cancel",
    "Okay remove me", "Seriously stop it", "Would you remove me?", "Can you pls remove me", "Can you unsubscribe us?",
    "Remove me from your database", "Remove me from your records", "Opt me out of it", "Opt me out of your texts",
    "Opt me out of these messages", "Re: remove me", "Ok mate lose my number", "Do me a favour and lose my number",
    "Stop it, who is this?", "I said stop, who is this?", "Stop stop stop, who are you?", "Stop already, who gave you my number?",
    "Please stop this, who is this?", "Seriously stop, why do you keep texting?", "Sorry can you take us off your list?",
    "Hey can you remove me?", "Hi could you please remove me?", "Hey remove me, who is this?", "Unsubscribe from this list",
    "Unsubscribe, who is this?", "Ok just cancel", "Can you please just remove me?", "Can you pls remove me?",
    "Remove me off your list", "Optout of this", "Stop in future please", "I'd like to be removed from your list",
    "Can I be removed?", "Please have me removed", "Please have my number deleted", "Can I be taken off your list?",
    "Get me off your list", "Can you please stop, who is this?",
  ])("%j is a final STOP", (reply) => {
    expect(optOut(reply)).toBe("keyword");
  });

  it.each([
    "No", "nope", "Nah", "Nah mate", "No mate", "no thanks", "No thank you", "No thankyou", "no thx", "Nah thanks",
    "Not interested mate", "not keen", "Don't text me again", "Don't call or text me again", "dont txt me", "do not contact me",
    "Never message me", "No more texts please", "No more messages", "Nah ta", "leave me alone", "Sorry, wrong number",
    "Is this spam?", "Fuck off", "f off", "rack off", "go away", "get lost", "Can I unsubscribe any time or is there a lock in?",
    "How do I unsubscribe later?", "I'd like to opt out", "Delete my details", "Can you remove the old hot water unit?",
    "No more", "Get stuffed", "Get fucked", "fk off", "jog on", "Scam", "Is this a scam?", "Blocked", "I've blocked you",
    "Reported", "Take it off", "Can you remove me from the trial if it's no good?", "Can it take me off the phone all day?",
    "When does the trial STOP?", "Yeah nah", "Yeah nah mate", "Not for me", "Don't delete my number",
    "Don't take me off the list, I'm keen", "Anything to take me off the phone", "Can you remove me from the trial if it's no good? :)",
    "Take my mobile off", "Scammer", "I have blocked you", "I've reported you", "Sod off", "Piss off", "fuk off", "Get rooted",
    "No.", "No, thanks", "Not for us", "Don't stop texting me, I'm keen", "U stop it?", "I don't want these texts",
    "Don't want your texts", "Lose my number please and thanks", "Stop by the yard Tuesday?",
    "Does the trial stop, or does it roll over?", "When does it stop, after 30 days?", "Does it just stop, or do I get charged?",
    "Sounds good, stop by Tuesday", "No worries, stop in anytime", "Cheers, stop by the yard", "Hi, when does the trial stop?",
    "Nah cheers", "No cheers", "Nope, cheers mate", "Nope mate", "Stop me if I'm wrong, but is it $149?", "I do not want texts",
    "Don't want your messages", "Why would you remove me?", "I've opted out", "Ah no cheers I'm right", "Ah nah cheers I'm right",
    "I don't want you to remove me", "Stop round Friday", "If it's no good just remove me",
    "Calls go to voicemail and I lose the number",
    "Remove? What do you mean?", "Ok. Stop me if I'm wrong but is it $149?", "Sounds good. Stop by the yard Tuesday?",
    // Not final, but they still need a look: "lose my number" can mean either.
    "Don't lose my number, try me next week", "Did you lose my number?",
    // Any other "stop" blocks too, until you've read it: some are opt-outs, some are buying signals.
    "I said STOP already", "Can it stop calls going to voicemail?", "Can it stop calls?",
    "Can you stop calling the office and text me", "Non stop mate", "Phones wont stop", "Can't stop, driving", "Don't stop",
    "Phone doesnt stop", "Do not stop", "Calls cannot stop", "Calls never stop", "It didnt stop", "It wouldnt stop",
    "They couldnt stop", "It isnt stop", "When does the free trial stop?", "Can it make the calls stop?", "Can it stop?",
  ])("%j may be a stop (a phrase you can overrule)", (reply) => {
    expect(optOut(reply)).toBe("phrase");
  });

  it.each([
    "How much?", "I had to cancel a job today", "Sounds good, call me after 4", "No worries, ring me tomorrow", "Who is this?",
    "End of the day works for me", "Don't call, just text me the price", "Never call my landline, text this number",
    "Nah, how much is it?", "My phones are nonstop", "Thanks", "Please", "Gotta take off, call me later", "", null,
  ])("%j isn't", (reply) => {
    expect(optOut(reply)).toBeNull();
  });
});

describe("parseBatch", () => {
  const json = (rows) => JSON.stringify(rows);

  it("returns E.164 numbers, plain text and the source", () => {
    expect(parseBatch(json([{ to: "0491 570 006", business: " Acme ", text: " Phondo here – Reply STOP ", source: " its website " }]))).toEqual([
      { to: A, business: "Acme", text: "Phondo here - Reply STOP", source: "its website" },
    ]);
  });

  it.each([
    ["not json", /valid JSON/],
    [json({ to: A }), /JSON array/],
    [json([{ business: "Acme", text: OK_TEXT, source: SOURCE }]), /row 1: "" isn't an Australian mobile/],
    [json([row("(02) 5550 1234")]), /landlines can't get texts/],
    [json([row(A), row("+61 491 570 006", "Dup")]), /row 2: 0491 570 006 is in the batch twice/],
    [json([{ to: A, text: OK_TEXT, source: SOURCE }]), /"business" is missing/],
    [json([{ to: A, business: "Acme", text: 42, source: SOURCE }]), /\(Acme\): "text" is missing/],
    [json([row(A, "Acme", "Hi from Phondo")]), /\(Acme\): .*STOP/],
    [json([{ to: A, business: "Acme", text: OK_TEXT }]), /\(Acme\): "source" is missing.*consent/],
    [json([row(A, "Acme", OK_TEXT, "  ")]), /\(Acme\): "source" is missing/],
    [json([null]), /row 1/],
  ])("refuses %s", (input, why) => {
    expect(() => parseBatch(input)).toThrow(why);
  });
});

// Twilio's Message resource, as its list API returns it. `inbound` is what the
// script's history reader adds, from which list the text came back in.
function twilioMessage({ from = FROM, to, body = "hi", at = YESTERDAY, status = "delivered", error = null, direction, sid }) {
  const inbound = from !== FROM;
  return {
    sid: sid ?? `SM${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
    from,
    to,
    body,
    date_created: at,
    status,
    error_code: error,
    direction: direction ?? (inbound ? "inbound" : "outbound-api"),
    inbound,
  };
}
const reply = (from, body, at = YESTERDAY, sid) => twilioMessage({ from, to: FROM, body, at, status: "received", sid });
const REPLY = (n) => `SM${String(n).padStart(32, "f")}`; // a reply's message ID, distinct from the SIDs our sends get
const firstText = (to, at) => twilioMessage({ to, at, body: OK_TEXT });

describe("csvCells", () => {
  it("reads back what csvField writes", () => {
    expect(csvCells('a,"b,c","say ""hi""",,\'=x')).toEqual(["a", "b,c", 'say "hi"', "", "'=x"]);
  });
});

describe("byContact", () => {
  it("groups by the other person's number, oldest first", () => {
    const contacts = byContact([
      twilioMessage({ to: A, body: "second", at: "Wed, 04 Nov 2026 03:00:00 +0000" }),
      reply(A, "their reply", "Wed, 04 Nov 2026 02:30:00 +0000"),
      twilioMessage({ to: A, body: "first", at: "Wed, 04 Nov 2026 02:00:00 +0000" }),
      twilioMessage({ to: "+16205550100", body: "not Australian" }),
    ]);
    expect([...contacts.keys()]).toEqual([A]);
    expect(contacts.get(A).sent.map((m) => m.body)).toEqual(["first", "second"]);
    expect(contacts.get(A).received.map((m) => m.body)).toEqual(["their reply"]);
  });
});

describe("sydneyDate", () => {
  it("uses Sydney's calendar day, not UTC's", () => {
    expect(sydneyDate(new Date("2026-11-04T13:30:00Z"))).toBe("2026-11-05"); // 00:30 AEDT
    expect(sydneyDate(new Date("2026-11-04T12:30:00Z"))).toBe("2026-11-04"); // 23:30 AEDT
  });
});

describe("firstTextsOn", () => {
  const today = "2026-11-05";
  const at = "Thu, 05 Nov 2026 00:00:00 +0000"; // 11am today in Sydney

  it("counts people first texted today with this script's texts", () => {
    expect(firstTextsOn(byContact([firstText(A, at), firstText(B, at), twilioMessage({ to: B, at, body: "follow-up" })]), today)).toBe(2);
  });

  it("leaves out yesterday's, texts without a STOP line, and answers to people who texted first", () => {
    const messages = [
      firstText(A, YESTERDAY),
      twilioMessage({ to: B, at, body: "Phondo test: this is your new texting number" }), // the setup test to your mobile
      twilioMessage({ to: C, at, body: "Reply to your Phondo texts from 0491 570 006: STOP" }), // a forwarded reply
      reply(D, "hi, saw your flyer", "Wed, 04 Nov 2026 23:00:00 +0000"),
      twilioMessage({ to: D, at, body: OK_TEXT }),
    ];
    expect(firstTextsOn(byContact(messages), today)).toBe(0);
  });
});

describe("planTexts", () => {
  const plan = (rows, { messages = [], dnc = [], single = false, dailyMax = 5, today = "2026-11-05", overruled = null } = {}) =>
    planTexts(rows, { doNotCall: new Set(dnc), contacts: byContact(messages), single, dailyMax, today, overruled });
  const today = "Thu, 05 Nov 2026 00:00:00 +0000";

  it("sends in order up to the daily limit, and leaves the rest for later", () => {
    expect(plan([row(A), row(B), row(C)], { dailyMax: 2 }).map((r) => r.action)).toEqual(["send", "send", "later"]);
  });

  it("counts today's first texts to numbers outside this batch too", () => {
    const messages = [firstText(E, today), firstText(F, today)];
    expect(plan([row(A), row(B)], { messages, dailyMax: 3 }).map((r) => r.action)).toEqual(["send", "later"]);
  });

  it("skips opt-outs, the do-not-call list, replies and anyone already texted, saying why", () => {
    const messages = [
      reply(A, "STOP"),
      reply(C, "Not interested", YESTERDAY, REPLY(8)),
      reply(D, "How much is it?"),
      reply(E, "Can it stop calls going to voicemail?", YESTERDAY, REPLY(9)),
      twilioMessage({ to: F, status: "undelivered", error: 30007 }),
    ];
    expect(plan([row(A), row(B), row(C), row(D), row(E), row(F)], { messages, dnc: [B] }).map((r) => [r.action, r.reason])).toEqual([
      ["skip", 'asked to stop on 2026-11-04: "STOP"'],
      ["skip", "on the do-not-call list"],
      ["skip", `may have asked to stop: "Not interested" (2026-11-04, ${REPLY(8)})`],
      ["skip", 'replied on 2026-11-04: "How much is it?". Answer with --to'],
      ["skip", `may have asked to stop: "Can it stop calls going to voicemail?" (2026-11-04, ${REPLY(9)})`],
      ["skip", "already texted on 2026-11-04 (last one undelivered, error 30007)"],
    ]);
  });

  it("never lets an overrule past a STOP, whatever came before it", () => {
    const messages = [
      reply(A, "not interested", "Wed, 04 Nov 2026 01:00:00 +0000", REPLY(1)),
      reply(A, "STOP", "Wed, 04 Nov 2026 02:00:00 +0000", REPLY(2)),
    ];
    expect(plan([row(A)], { single: true, messages, overruled: REPLY(1) })[0].action).toBe("skip");
    expect(plan([row(A)], { single: true, messages, overruled: REPLY(2) })[0].action).toBe("skip");
  });

  it("only counts phrases since your last text, and an overrule covers them only if it names the newest", () => {
    const messages = [
      twilioMessage({ to: A, at: "Mon, 02 Nov 2026 01:00:00 +0000" }),
      reply(A, "Can I unsubscribe any time?", "Mon, 02 Nov 2026 02:00:00 +0000", REPLY(3)),
      twilioMessage({ to: A, at: "Tue, 03 Nov 2026 01:00:00 +0000" }), // you answered it: settled
      reply(A, "Not interested anymore", "Wed, 04 Nov 2026 01:00:00 +0000", REPLY(4)),
      reply(A, "no thanks", "Wed, 04 Nov 2026 02:00:00 +0000", REPLY(5)),
    ];
    expect(plan([row(A)], { single: true, messages })[0].reason).toBe(
      `may have asked to stop: "Not interested anymore" (2026-11-04, ${REPLY(4)}), "no thanks" (2026-11-04, ${REPLY(5)}). ` +
        `If they didn't, add --not-opt-out="what they meant" --seen=${REPLY(5)}`
    );
    expect(plan([row(A)], { single: true, messages, overruled: REPLY(5) })[0].action).toBe("send");
    // "no thanks" arrived after you overruled "Not interested anymore": read it first.
    expect(plan([row(A)], { single: true, messages, overruled: REPLY(4) })[0]).toMatchObject({
      action: "skip",
      reason: expect.stringContaining(`${REPLY(4)} isn't their newest one: read them all, then use --seen=${REPLY(5)}`),
    });
    expect(plan([row(A)], { single: true, messages: messages.slice(0, 3) })[0].action).toBe("send");
  });

  it("catches an opt-out even when later replies came after it", () => {
    const messages = [reply(A, "Please stop texting me", "Wed, 04 Nov 2026 01:00:00 +0000"), reply(A, "who is this?", "Wed, 04 Nov 2026 02:00:00 +0000")];
    expect(plan([row(A)], { single: true, messages })[0]).toMatchObject({ action: "skip", reason: expect.stringMatching(/^asked to stop/) });
  });

  it("lets a single text answer someone who replied, without using a first-text slot", () => {
    const messages = [reply(C, "How much?"), twilioMessage({ to: C }), firstText(E, today)];
    expect(plan([row(C)], { single: true, messages, dailyMax: 1 })[0].action).toBe("send");
  });

  it("only lets a single text past a phrase when you overrule it, and never past a STOP", () => {
    const phrase = [reply(B, "Can I unsubscribe any time?", YESTERDAY, REPLY(6))];
    expect(plan([row(B)], { single: true, messages: phrase })[0]).toMatchObject({ action: "skip", reason: expect.stringMatching(/--not-opt-out/) });
    expect(plan([row(B)], { single: true, messages: phrase, overruled: REPLY(6) })[0].action).toBe("send");
    const keyword = [reply(B, "STOP", YESTERDAY, REPLY(7))];
    expect(plan([row(B)], { single: true, messages: keyword, overruled: REPLY(7) })[0].action).toBe("skip");
    expect(plan([row(A)], { single: true, dnc: [A], overruled: REPLY(6) })[0]).toMatchObject({ action: "skip", reason: "on the do-not-call list" });
  });

  it("counts a single first text against the daily limit", () => {
    expect(plan([row(A)], { single: true, messages: [firstText(E, today)], dailyMax: 1 })[0].action).toBe("later");
    expect(plan([row(A)], { single: true, dailyMax: 1 })[0].action).toBe("send");
  });

  it("reports each text's size", () => {
    expect(plan([row(A, "Acme", `Phondo. Reply STOP. ${"a".repeat(300)}`)])[0]).toMatchObject({ encoding: "GSM-7", segments: 3 });
  });
});

const SID = (n) => `SM${String(n).padStart(32, "0")}`;

function harness({
  batch = [row(A), row(B)],
  messages = [],
  dnc = "",
  balance = "50.00",
  currency = "USD",
  now = NOON,
  send = () => "ok", // per POST: "ok", an HTTP status, "network", "no-sid" or a SID to return
  delivery = "delivered", // or an HTTP status for the status read
  env = {},
  overrides = {},
} = {}) {
  const dir = mkdtempSync(join(ENV_HOME, "run-"));
  const files = { batch: join(dir, "texts.json"), dnc: join(dir, "do-not-call.txt"), log: join(dir, "texts.csv"), optOuts: join(dir, "opt-outs.csv") };
  files.lock = `${files.log}.lock`;
  if (batch !== null) writeFileSync(files.batch, typeof batch === "string" ? batch : JSON.stringify(batch));
  if (dnc !== null) writeFileSync(files.dnc, dnc);
  const requests = [];
  let posts = 0;
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    requests.push({ url, method, body });
    const { pathname, searchParams } = new URL(url);
    if (method === "POST") {
      posts += 1;
      const outcome = send(posts, body);
      if (outcome === "network") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      if (outcome === 502) return new Response("<html>Bad Gateway</html>", { status: 502 });
      if (typeof outcome === "number") return Response.json({ message: "Attempt to send to unsubscribed recipient", code: 21610 }, { status: outcome });
      const sid = outcome === "ok" ? SID(posts) : outcome === "no-sid" ? undefined : outcome;
      return Response.json({ sid, status: "queued" }, { status: 201 });
    }
    if (pathname.endsWith("/Balance.json")) return Response.json({ balance, currency });
    if (pathname.endsWith("/Messages.json")) {
      const from = searchParams.get("From");
      const to = searchParams.get("To");
      return Response.json({ messages: messages.filter((m) => (!from || m.from === from) && (!to || m.to === to)), next_page_uri: null });
    }
    const sid = /\/Messages\/(\w+)\.json$/.exec(pathname)?.[1];
    if (sid) {
      if (typeof delivery === "number") return new Response("<html>Bad Gateway</html>", { status: delivery });
      return Response.json({ sid, status: delivery, error_code: delivery === "undelivered" ? 30007 : null, error_message: null });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
  const deps = {
    fetch,
    now: vi.fn(() => new Date(now)),
    sleep: vi.fn(async () => {}),
    onInterrupt: vi.fn(() => () => {}), // never touch the test runner's own signal handling
    exit: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  const fullEnv = {
    HOME: ENV_HOME,
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "secret",
    TEXT_BATCH: files.batch,
    DIAL_DNC_FILE: files.dnc,
    TEXT_LOG: files.log,
    ...env,
  };
  // Answers one kind of request differently, and leaves the rest to the stub above.
  const intercept = (match, respond) => {
    const inner = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, init) => (match(url, init) ? respond(url, init) : inner(url, init)));
  };
  return {
    deps,
    env: fullEnv,
    requests,
    files,
    intercept,
    run: (...args) => main(["node", "text.mjs", ...args], fullEnv, deps),
    sentTo: () => requests.filter((r) => r.method === "POST").map((r) => r.body.To),
    logRows: () => (existsSync(files.log) ? readFileSync(files.log, "utf8").trim().split("\n").slice(1) : []),
    output: () => [...deps.log.mock.calls, ...deps.error.mock.calls].flat().join("\n"),
  };
}
const isHistory = (url) => url.includes("/Messages.json?") && !(url.includes("From=") && url.includes("To="));

describe("main: batch", () => {
  it("previews by default: shows every text, its source and why, and sends nothing", async () => {
    const h = harness({ batch: [row(A, "Acme Plumbing"), row(B)], dnc: "0491 570 156 # asked to stop\n" });
    expect(await h.run()).toBe(0);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/First texts today: 0 of 5/);
    expect(h.output()).toMatch(/1\. Acme Plumbing, 0491 570 006 · 1 segment · SEND NOW/);
    expect(h.output()).toMatch(/2\. .*SKIP: on the do-not-call list/);
    expect(h.output()).toContain(OK_TEXT);
    expect(h.output()).toContain(`source: ${SOURCE}`);
    expect(h.output()).toMatch(/Preview only: nothing was sent\. Add --send to send the 1 marked SEND NOW/);
  });

  it("sends in order with the batch text, from the outreach number, logs each one with its source, and releases the lock", async () => {
    const h = harness();
    expect(await h.run("--send")).toBe(0);
    const posts = h.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.body)).toEqual([
      { From: FROM, To: A, Body: OK_TEXT },
      { From: FROM, To: B, Body: OK_TEXT },
    ]);
    expect(posts[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect(h.logRows()).toEqual([
      `2026-11-05T01:00:00.000Z,${A},Biz 006,batch,${SID(1)},1,${SOURCE},`,
      `2026-11-05T01:00:00.000Z,${B},Biz 156,batch,${SID(2)},1,${SOURCE},`,
    ]);
    expect(h.deps.sleep).toHaveBeenCalledWith(20_000); // a gap between texts
    expect(h.output()).toMatch(/Biz 006, 0491 570 006: delivered/);
    expect(h.output()).toMatch(/Sent 2 of 2/);
    expect(readdirSync(join(h.files.lock, ".."))).not.toContain("texts.csv.lock");
  });

  it("never texts the same batch row twice: a re-run skips anyone already texted", async () => {
    const h = harness({ messages: [firstText(A, "Thu, 05 Nov 2026 00:30:00 +0000")] });
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([B]);
  });

  it("reads the history from both directions, through every page", async () => {
    const h = harness();
    const pages = [
      { messages: [], next_page_uri: "/2010-04-01/Accounts/ACtest/Messages.json?From=%2B61485094768&Page=1" },
      { messages: [firstText(A)], next_page_uri: null },
    ];
    h.intercept((url) => isHistory(url) && url.includes("From="), () => Response.json(pages.shift()));
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([B]); // A was only on the second page
    const urls = h.deps.fetch.mock.calls.map(([url]) => url);
    expect(urls).toContain("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json?From=%2B61485094768&Page=1");
    expect(urls.some((url) => url.includes("Messages.json?To=%2B61485094768"))).toBe(true);
  });

  it("stops rather than read an endless history", async () => {
    const h = harness();
    h.intercept(isHistory, () => Response.json({ messages: [], next_page_uri: "/2010-04-01/Accounts/ACtest/Messages.json?From=x&Page=2" }));
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/more than 5000 texts/);
  });

  it.each([
    ["no message list", { next_page_uri: null }, /without messages/],
    ["a message list that isn't a list", { messages: "none" }, /without messages/],
    ["a text with no date", { messages: [{ ...firstText(A), date_created: null }] }, /can't account for/],
    ["a text that isn't from this number", { messages: [firstText(A, YESTERDAY), { ...firstText(B), from: "+61491570999" }] }, /can't account for/],
  ])("sends nothing when Twilio's history has %s", async (_, page, why) => {
    const h = harness();
    h.intercept((url) => isHistory(url) && url.includes("From="), () => Response.json(page));
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(why);
    expect(h.output()).toMatch(/Nothing was sent/);
  });

  it("knows a reply is inbound from the list it came back in, whatever its direction field says", async () => {
    const h = harness({ batch: [row(A)], messages: [{ ...reply(A, "STOP"), direction: "outbound-reply" }] });
    expect(await h.run()).toBe(0);
    expect(h.output()).toMatch(/SKIP: asked to stop/);
  });

  it("sends 5 first texts a day by default, and says how many are left", async () => {
    const h = harness({ batch: [row(A), row(B), row(C), row(D), row(E), row(F)] });
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([A, B, C, D, E]);
    expect(h.output()).toMatch(/1 more in the batch: run it again tomorrow/);
  });

  it("keeps to --max", async () => {
    const h = harness({ batch: [row(A), row(B), row(C)] });
    expect(await h.run("--send", "--max=2")).toBe(0);
    expect(h.sentTo()).toEqual([A, B]);
  });

  it("counts first texts sent earlier the same Sydney day, even to numbers no longer in the batch", async () => {
    // 9:30am Thursday in Sydney, but still Wednesday in UTC.
    const messages = [firstText(E, "Wed, 04 Nov 2026 22:10:00 +0000"), firstText(F, "Wed, 04 Nov 2026 22:15:00 +0000")];
    const h = harness({ now: "2026-11-04T22:30:00Z", batch: [row(A), row(B), row(C)], messages });
    expect(await h.run("--send", "--max=2")).toBe(0);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/First texts today: 2 of 2/);
    expect(h.output()).toMatch(/LATER: today's limit of 2 first texts is reached/);
  });

  it.each(["0", "21", "2.5", "lots"])("refuses --max=%s", async (max) => {
    const h = harness();
    expect(await h.run(`--max=${max}`)).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["at 9pm", "2026-11-05T10:00:00Z", /21:00 in Sydney/],
    ["on a Sunday", "2026-11-08T01:00:00Z", /Sunday/],
    ["on Christmas Day", "2026-12-25T01:00:00Z", /public holiday/],
  ])("won't send %s, but still previews", async (_, now, why) => {
    const h = harness({ now });
    expect(await h.run()).toBe(0);
    expect(h.output()).toMatch(why);
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
  });

  it("stops mid-batch when the hours close", async () => {
    const h = harness();
    let calls = 0;
    h.deps.now.mockImplementation(() => new Date(++calls <= 3 ? NOON : "2026-11-05T09:00:00Z")); // then 8pm
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A]);
    expect(h.output()).toMatch(/Stopped: .*20:00 in Sydney/);
  });

  it("refuses to spend the balance below the floor that keeps the phone lines up", async () => {
    // Two 1-segment texts cost US$0.103: 5.10 leaves 4.997, under the US$5 floor.
    const low = harness({ balance: "5.10" });
    expect(await low.run()).toBe(0);
    expect(low.output()).toMatch(/Can't send yet: top up Twilio first: the balance is US\$5\.10/);
    expect(await low.run("--send")).toBe(1);
    expect(low.sentTo()).toEqual([]);

    const enough = harness({ balance: "5.11" });
    expect(await enough.run("--send")).toBe(0);
    expect(enough.sentTo()).toEqual([A, B]);
  });

  it("allows a send that leaves exactly the floor", async () => {
    const h = harness({ batch: [row(A)], balance: "5.0515" });
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([A]);
  });

  it("prices every segment, not every text", async () => {
    const long = `Phondo. Reply STOP. ${"a".repeat(300)}`; // 3 segments
    const h = harness({ batch: [row(A, "A", long), row(B, "B", long)], balance: "5.305" }); // 6 x 0.0515 = 0.309
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/6 segments, ≈US\$0\.31/);
  });

  it.each([
    ["an unreadable balance", { balance: "n/a" }],
    ["a balance in exponent form", { balance: "1e3" }],
    ["no balance", { balance: null }],
    ["a balance in another currency", { currency: "AUD" }],
  ])("refuses to send with %s", async (_, opts) => {
    const h = harness(opts);
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/couldn't read the Twilio balance/);
  });

  it("skips a number Twilio refuses and carries on, then reports it", async () => {
    const h = harness({ batch: [row(A), row(B), row(C)], send: (n) => (n === 1 ? 400 : "ok") });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A, B, C]);
    expect(h.logRows()).toHaveLength(2);
    expect(h.output()).toMatch(/Twilio refused the text to Biz 006, 0491 570 006 \(HTTP 400: Attempt to send to unsubscribed recipient \[code 21610\]\), so it didn't go/);
    expect(h.output()).toMatch(/Sent 2 of 3/);
  });

  it("stops after two refusals in a row: that's the account, not a number", async () => {
    const h = harness({ batch: [row(A), row(B), row(C)], send: () => 400 });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A, B]);
    expect(h.output()).toMatch(/refused two texts in a row, so stopping/);
  });

  it("only stops for refusals that come one after another", async () => {
    const h = harness({ batch: [row(A), row(B), row(C), row(D)], send: (n) => (n % 2 ? 400 : "ok") });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A, B, C, D]);
  });

  it.each([
    ["a network failure", "network", /ECONNRESET/],
    ["a gateway error", 502, /HTTP 502/],
    ["a reply without a message ID", "no-sid", /without a message ID/],
    ["a reply with a malformed message ID", "SM-not-a-real-sid", /without a message ID/],
  ])("stops on %s, which may have sent the text, and says a re-run is safe", async (_, outcome, why) => {
    const h = harness({ send: () => outcome });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A]);
    expect(h.output()).toMatch(why);
    expect(h.output()).toMatch(/may have gone.*Re-running is safe/);
  });

  it("skips anyone texted from this number after the history was read", async () => {
    const h = harness();
    h.intercept(
      (url) => url.includes("From=") && url.includes(`To=${encodeURIComponent(B)}`),
      () => Response.json({ messages: [firstText(B, "Thu, 05 Nov 2026 00:59:00 +0000")] })
    );
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A]);
    expect(h.output()).toMatch(/Skipped Biz 156, 0491 570 156: they've been texted from this number since the history was read/);
  });

  it("skips anyone whose re-check comes back without a message list", async () => {
    const h = harness();
    h.intercept((url) => url.includes("From=") && url.includes(`To=${encodeURIComponent(A)}`), () => Response.json({}));
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([B]);
    expect(h.output()).toMatch(/Skipped Biz 006, 0491 570 006: Twilio's re-check came back without a message list/);
  });

  it("stops if it can't re-check someone before texting them", async () => {
    const h = harness();
    h.intercept(
      (url) => url.includes("From=") && url.includes(`To=${encodeURIComponent(A)}`),
      () => new Response("<html>Bad Gateway</html>", { status: 502 })
    );
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Couldn't re-check Biz 006/);
  });

  it.each([
    ["undelivered", /undelivered \(error 30007\)/],
    ["failed", /: failed\./],
  ])("reports %s texts, and exits non-zero", async (delivery, why) => {
    const h = harness({ delivery });
    expect(await h.run("--send")).toBe(1);
    expect(h.output()).toMatch(why);
  });

  it.each([
    ["it can't read a delivery status", 502, /couldn't read the delivery status \(HTTP 502/],
    ["Twilio's reply has no status", "", /couldn't read the delivery status \(Twilio's reply had no status\)/],
  ])("exits non-zero when %s", async (_, delivery, why) => {
    const h = harness({ delivery });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A, B]);
    expect(h.output()).toMatch(why);
  });

  it("still sends when the log can't be written, prints the row to add by hand, and exits non-zero", async () => {
    const blocker = join(ENV_HOME, "a-file-not-a-dir");
    writeFileSync(blocker, "so the log's directory can't be made");
    const h = harness({ env: { TEXT_LOG: join(blocker, "texts.csv") }, overrides: { lock: () => () => {} } });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A, B]);
    expect(h.output()).toMatch(/couldn't be written .*Add this row by hand:\n.*batch,SM/);
  });

  it("keeps spreadsheet formulas out of the log", async () => {
    const h = harness({
      batch: [row(A, '=HYPERLINK("http://x")', OK_TEXT, "+tracked source"), row(B, "-1+2 Plumbing"), row(C, "@home Plumbing")],
    });
    expect(await h.run("--send")).toBe(0);
    const [first, second, third] = h.logRows();
    expect(first).toContain(`,"'=HYPERLINK(""http://x"")",batch,`);
    expect(first).toContain(",'+tracked source,");
    expect(second).toContain(",'-1+2 Plumbing,batch,");
    expect(third).toContain(",'@home Plumbing,batch,");
  });

  it("releases the lock even when something throws mid-send", async () => {
    const h = harness({ overrides: { sleep: async () => { throw new Error("boom"); } } });
    await expect(h.run("--send")).rejects.toThrow("boom");
    expect(h.sentTo()).toEqual([A]);
    expect(existsSync(h.files.lock)).toBe(false);
  });

  it("releases the lock before it exits on Ctrl-C, saying a re-run is safe", async () => {
    const handlers = [];
    let lockHeldWhenInterrupted;
    let lockHeldAtExit;
    const h = harness({
      overrides: {
        onInterrupt: (handler) => (handlers.push(handler), () => {}),
        exit: vi.fn(() => {
          lockHeldAtExit = existsSync(h.files.lock);
        }),
        sleep: async () => {
          lockHeldWhenInterrupted ??= existsSync(h.files.lock);
          handlers[0]?.();
        },
      },
    });
    await h.run("--send");
    expect(lockHeldWhenInterrupted).toBe(true);
    expect(h.deps.exit).toHaveBeenCalledWith(130);
    expect(lockHeldAtExit).toBe(false);
    expect(h.output()).toMatch(/Interrupted\. Re-running is safe/);
  });

  it.each([
    ["the do-not-call list is missing", { dnc: null }, /No do-not-call list/],
    ["the do-not-call list has a bad line", { dnc: "Joe Bloggs\n" }, /isn't exactly one phone number/],
    ["the batch is missing", { batch: null }, /No batch at/],
    ["the batch is empty", { batch: [] }, /is empty/],
    ["a batch text has no opt-out", { batch: [row(A, "Acme", "Hi from Phondo")] }, /row 1 \(Acme\).*STOP/],
    ["a batch row has no source", { batch: [{ to: A, business: "Acme", text: OK_TEXT }] }, /row 1 \(Acme\): "source" is missing/],
    ["the Twilio keys are missing", { env: { TWILIO_AUTH_TOKEN: "" } }, /TWILIO_ACCOUNT_SID/],
    ["TEXT_FROM isn't a mobile", { env: { TEXT_FROM: "(02) 5701 5064" } }, /TEXT_FROM/],
  ])("refuses when %s, before calling Twilio", async (_, opts, why) => {
    const h = harness(opts);
    expect(await h.run("--send")).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
    expect(h.output()).toMatch(why);
  });

  it("says so when there's nothing to send", async () => {
    const h = harness({ batch: [row(A)], dnc: "0491 570 006\n" });
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Nothing to send now/);
  });

  it("uses the data folder in the HOME it's given, not the real one", async () => {
    const h = harness({ env: { TEXT_BATCH: "", DIAL_DNC_FILE: "", TEXT_LOG: "" } });
    expect(await h.run()).toBe(1);
    expect(h.output()).toContain(join(ENV_HOME, ".phondo-outreach", "do-not-call.txt"));
  });

  it("shows their words without terminal control codes", async () => {
    const h = harness({ batch: [row(A)], messages: [reply(A, "hi\u001b[2J\u001b[1;1Hthere\u009b2J‮")] });
    expect(await h.run()).toBe(0);
    expect(h.output()).toMatch(/replied on 2026-11-04: "hi \[2J \[1;1Hthere 2J"/);
    expect(h.output()).not.toMatch(/[\u001b\u009b‮]/);
  });
});

describe("main: opt-outs go on the do-not-call list", () => {
  it("adds a STOP reply to the list, keeping the line before it intact, records it, and skips them", async () => {
    const h = harness({ batch: [row(A), row(B)], dnc: "0491 570 157  # said no on a call", messages: [reply(B, "Stop texting me pls")] });
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.dnc, "utf8")).toBe(
      '0491 570 157  # said no on a call\n0491 570 156  # replied "Stop texting me pls" to a text on 2026-11-04 (added by text.mjs)\n'
    );
    const [header, recordedRow, ...rest] = readFileSync(h.files.optOuts, "utf8").split("\n");
    expect(header).toBe("recorded_at,number,reply_sid,replied_at,do_not_call_file,reply");
    expect(csvCells(recordedRow)).toEqual([
      "2026-11-05T01:00:00.000Z",
      B,
      expect.stringMatching(/^SM\w{32}$/),
      "2026-11-04T01:00:00.000Z",
      h.files.dnc,
      "Stop texting me pls",
    ]);
    expect(rest).toEqual([""]);
    expect(h.output()).toMatch(/Added 0491 570 156 to the do-not-call list/);
    expect(h.output()).toMatch(/2\. Biz 156, 0491 570 156 .*SKIP: asked to stop/);
  });

  it("puts a number back when they send a new STOP, and says when one is missing", async () => {
    const messages = [reply(B, "STOP", "Wed, 04 Nov 2026 01:00:00 +0000", REPLY(30))];
    const h = harness({ messages });
    expect(await h.run()).toBe(0);
    writeFileSync(h.files.dnc, "");
    expect(await h.run()).toBe(0);
    expect(h.output()).toMatch(/0491 570 156 replied STOP to a text but isn't on the do-not-call list \(taken off by hand\?\)/);
    messages.push(reply(B, "Stop calling me", "Wed, 04 Nov 2026 22:00:00 +0000", REPLY(31)));
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.dnc, "utf8")).toMatch(/^0491 570 156 {2}# replied "Stop calling me"/);
    expect(readFileSync(h.files.optOuts, "utf8").trim().split("\n")).toHaveLength(3); // the header and two opt-outs
  });

  it("records the list each opt-out went on, so a different list still gets it", async () => {
    const h = harness({ messages: [reply(B, "STOP", YESTERDAY, REPLY(32))] });
    expect(await h.run()).toBe(0);
    const other = join(ENV_HOME, "the-dialers-list.txt");
    writeFileSync(other, "");
    expect(await main(["node", "text.mjs"], { ...h.env, DIAL_DNC_FILE: other }, h.deps)).toBe(0);
    expect(readFileSync(other, "utf8")).toMatch(/^0491 570 156 {2}# replied "STOP"/);
  });

  it("keeps spreadsheet formulas out of the opt-out record", async () => {
    const h = harness({ messages: [reply(B, '=HYPERLINK("http://x","STOP")')] });
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.optOuts, "utf8")).toContain(`,"'=HYPERLINK(""http://x"",""STOP"")"\n`);
  });

  it("stops if it can't read the opt-out record", async () => {
    const h = harness();
    mkdirSync(h.files.optOuts); // a folder where the file should be
    expect(await h.run()).toBe(1);
    expect(h.output()).toMatch(/Can't read .*opt-outs\.csv .*Nothing was sent/);
  });

  it("reads back a do-not-call path with commas in it", async () => {
    const list = join(mkdtempSync(join(ENV_HOME, "a,b-")), "do,not,call.txt");
    writeFileSync(list, "");
    const h = harness({ env: { DIAL_DNC_FILE: list }, messages: [reply(B, "STOP", YESTERDAY, REPLY(40))] });
    expect(await h.run()).toBe(0);
    writeFileSync(list, ""); // taken off by hand
    expect(await h.run()).toBe(0);
    expect(readFileSync(list, "utf8")).toBe("");
  });

  it("only warns about a missing opt-out when it really is missing", async () => {
    const h = harness({ messages: [reply(B, "STOP")] });
    expect(await h.run()).toBe(0);
    expect(await h.run()).toBe(0);
    expect(h.output()).not.toMatch(/taken off by hand/);
  });

  it("adds a STOP even when they wrote more afterwards", async () => {
    const h = harness({ messages: [reply(B, "STOP", "Wed, 04 Nov 2026 01:00:00 +0000"), reply(B, "who is this?", "Wed, 04 Nov 2026 02:00:00 +0000")] });
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.dnc, "utf8")).toMatch(/^0491 570 156 {2}# replied "STOP"/);
  });

  it("keeps the list readable whatever they wrote, so the next run (and dial.mjs) still starts", async () => {
    const h = harness({ messages: [reply(B, "STOP\nthanks\r\n# 0491 570 999 x")] });
    expect(await h.run()).toBe(0);
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.dnc, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("leaves a number you took off the list off, while still never texting them", async () => {
    const h = harness({ batch: [row(B)], messages: [reply(B, "STOP")] });
    expect(await h.run()).toBe(0);
    writeFileSync(h.files.dnc, ""); // you decided they can be rung after all
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.dnc, "utf8")).toBe("");
    expect(readFileSync(h.files.optOuts, "utf8").trim().split("\n")).toHaveLength(2); // the header and one opt-out
    expect(h.output()).toMatch(/SKIP: asked to stop/);
    expect(h.output()).toMatch(/isn't on the do-not-call list \(taken off by hand\?\), so dial\.mjs would ring them/);
  });

  it("doesn't add a phrase you might overrule, or anyone already listed", async () => {
    const h = harness({ batch: [row(A)], dnc: "0491 570 006\n", messages: [reply(A, "STOP"), reply(B, "not interested")] });
    expect(await h.run()).toBe(0);
    expect(readFileSync(h.files.dnc, "utf8")).toBe("0491 570 006\n");
  });

  it("stops if it can't write the list, and prints the line to add", async () => {
    const h = harness({ messages: [reply(B, "STOP")], overrides: { appendDoNotCall: () => { throw new Error("read-only"); } } });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Couldn't add 0491 570 156 to the do-not-call list \(read-only\)\. Nothing was sent\..*\n0491 570 156  # replied "STOP"/);
  });

  it("stops if it can't record the opt-out", async () => {
    const h = harness({ messages: [reply(B, "STOP")], overrides: { appendOptOut: () => { throw new Error("disk full"); } } });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Couldn't record 0491 570 156's opt-out .*\(disk full\)\. Nothing was sent/);
  });
});

describe("main: one send at a time", () => {
  it("won't send while another send holds the lock, and doesn't touch Twilio", async () => {
    const h = harness();
    writeFileSync(h.files.lock, String(process.pid)); // a process that's alive: this one
    expect(await h.run("--send")).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
    expect(h.output()).toMatch(/Not sending: another send is running \(process \d+\)/);
    expect(readFileSync(h.files.lock, "utf8")).toBe(String(process.pid)); // not ours to remove
  });

  it("treats a lock held by a process it can't signal as running", async () => {
    const h = harness();
    writeFileSync(h.files.lock, "1"); // launchd/init: alive, but not ours (EPERM)
    expect(await h.run("--send")).toBe(1);
    expect(h.output()).toMatch(/another send is running \(process 1\)/);
  });

  it("won't take over a lock left by a send that was killed, and says how to clear it", async () => {
    const h = harness();
    writeFileSync(h.files.lock, "2147483646"); // no such process
    expect(await h.run("--send")).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
    expect(h.output()).toContain(`a send that was killed left its lock behind. If no send is running, delete ${h.files.lock} and try again`);
    expect(existsSync(h.files.lock)).toBe(true);
  });

  it("previews without the lock", async () => {
    const h = harness();
    writeFileSync(h.files.lock, String(process.pid));
    expect(await h.run()).toBe(0);
    expect(h.output()).toMatch(/Preview only/);
  });

  it("leaves no lock files behind, and stops listening for Ctrl-C when it's done", async () => {
    const stopListening = vi.fn();
    const h = harness({ overrides: { onInterrupt: () => stopListening } });
    expect(await h.run("--send")).toBe(0);
    expect(readdirSync(join(h.files.lock, "..")).filter((name) => name.startsWith("texts.csv.lock"))).toEqual([]);
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it("listens for Ctrl-C and SIGTERM only while it sends", async () => {
    const before = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
    let during;
    const h = harness({ overrides: { sleep: async () => (during ??= ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))) } });
    delete h.deps.onInterrupt; // the real one; no signal is ever sent
    expect(await h.run("--send")).toBe(0);
    expect(during).toEqual(before.map((count) => count + 1));
    expect(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal))).toEqual(before);
  });
});

describe("main: one text (--to)", () => {
  it("previews the conversation so far, and sends nothing", async () => {
    const messages = [twilioMessage({ to: A, body: "first text" }), reply(A, "How much?", "Wed, 04 Nov 2026 02:00:00 +0000")];
    const h = harness({ messages });
    expect(await h.run("--to=0491 570 006", `--text=From $149 a month. ${OK_TEXT}`)).toBe(0);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/2026-11-04 you : first text\n.*2026-11-04 them: How much\?/);
    expect(h.output()).toMatch(/Preview only/);
  });

  it("sends one text to someone who replied, without a gap or the batch", async () => {
    const h = harness({ batch: null, messages: [twilioMessage({ to: A }), reply(A, "How much?")] });
    expect(await h.run("--to=0491 570 006", "--text=From $149 a month. Michael, Phondo. Reply STOP to opt out.", "--send")).toBe(0);
    expect(h.requests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([
      { From: FROM, To: A, Body: "From $149 a month. Michael, Phondo. Reply STOP to opt out." },
    ]);
    expect(h.deps.sleep).not.toHaveBeenCalledWith(20_000);
    expect(h.logRows()).toEqual([`2026-11-05T01:00:00.000Z,${A},,single,${SID(1)},1,,`]);
  });

  it("sends the text made plain", async () => {
    const h = harness({ messages: [reply(A, "How much?")] });
    expect(await h.run("--to=0491 570 006", "--text=Phondo – it won’t bite. Reply STOP to opt out.", "--send")).toBe(0);
    expect(h.requests.find((r) => r.method === "POST").body.Body).toBe("Phondo - it won't bite. Reply STOP to opt out.");
  });

  it("refuses someone who sent a STOP, even with --not-opt-out", async () => {
    const h = harness({ messages: [reply(A, "How much?"), reply(A, "Stop texting me", YESTERDAY, REPLY(20))] });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=they meant the other thing", `--seen=${REPLY(20)}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Not texting 0491 570 006: asked to stop/);
  });

  it("refuses a reply that may be a stop until you overrule it by its ID, and logs why", async () => {
    const messages = [twilioMessage({ to: A }), reply(A, "Can I unsubscribe any time or is there a lock in?", "Wed, 04 Nov 2026 02:00:00 +0000", REPLY(21))];
    const refused = harness({ messages });
    expect(await refused.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(refused.sentTo()).toEqual([]);
    expect(refused.output()).toContain(`may have asked to stop: "Can I unsubscribe any time or is there a lock in?" (2026-11-04, ${REPLY(21)})`);
    expect(refused.output()).toContain(`--not-opt-out="what they meant" --seen=${REPLY(21)}`);

    const overruled = harness({ messages });
    expect(await overruled.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=asking about the contract", `--seen=${REPLY(21)}`, "--send")).toBe(0);
    expect(overruled.sentTo()).toEqual([A]);
    expect(overruled.logRows()[0]).toMatch(new RegExp(`,single,SM\\w+,1,,asking about the contract \\(overrules ${REPLY(21)}\\)$`));
  });

  it("won't overrule a reply that arrived after the one you read", async () => {
    const messages = [
      twilioMessage({ to: A }),
      reply(A, "Can I unsubscribe any time?", "Wed, 04 Nov 2026 02:00:00 +0000", REPLY(22)),
      reply(A, "Actually not interested, don't text me again", "Wed, 04 Nov 2026 03:00:00 +0000", REPLY(23)),
    ];
    const h = harness({ messages });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=asking about the contract", `--seen=${REPLY(22)}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toContain(`${REPLY(22)} isn't their newest one: read them all, then use --seen=${REPLY(23)}`);
  });

  it("refuses someone on the do-not-call list", async () => {
    const h = harness({ dnc: "0491 570 006 # said no on a call\n" });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
  });

  it("needs a source for a first text, and counts it against the daily limit", async () => {
    const noSource = harness();
    expect(await noSource.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(noSource.sentTo()).toEqual([]);
    expect(noSource.output()).toMatch(/--source=.*consent/);

    const sourced = harness();
    expect(await sourced.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--source=on their van", "--send")).toBe(0);
    expect(sourced.logRows()[0]).toMatch(/,single,SM\w+,1,on their van,$/);

    const full = harness({ messages: [firstText(E, "Thu, 05 Nov 2026 00:00:00 +0000")] });
    expect(await full.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--source=on their van", "--max=1", "--send")).toBe(1);
    expect(full.sentTo()).toEqual([]);
    expect(full.output()).toMatch(/today's limit of 1 first texts is reached/);
  });

  it("won't send at 9pm", async () => {
    const h = harness({ now: "2026-11-05T10:00:00Z", messages: [reply(A, "How much?")] });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
  });

  it("holds back an answer to a reply that mentions stop until you've read it and said so", async () => {
    const messages = [reply(A, "Can it stop calls going to voicemail?", YESTERDAY, REPLY(24))];
    const held = harness({ messages });
    expect(await held.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(held.sentTo()).toEqual([]);
    const answered = harness({ messages });
    expect(await answered.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=asking what it does", `--seen=${REPLY(24)}`, "--send")).toBe(0);
    expect(answered.sentTo()).toEqual([A]);
  });

  it("refuses 'stop' at the end of a longer reply as final", async () => {
    const h = harness({ messages: [twilioMessage({ to: A }), reply(A, "Who gave you my number? STOP", "Wed, 04 Nov 2026 02:00:00 +0000", REPLY(25))] });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=no", `--seen=${REPLY(25)}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(readFileSync(h.files.dnc, "utf8")).toMatch(/^0491 570 006 /);
  });

  it("says a re-run would text them again when the send is uncertain", async () => {
    const h = harness({ messages: [reply(A, "How much?")], send: () => "network" });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(h.output()).toMatch(/Check the Twilio console before sending it again/);
  });

  it.each([
    [["--to=0491 570 006"], /go together/],
    [[`--text=${OK_TEXT}`], /go together/],
    [["--source=x"], /--source goes with --to/],
    [["--not-opt-out=x"], /--not-opt-out goes with --to/],
    [[`--seen=${REPLY(1)}`], /--seen goes with --to/],
    [["--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=x"], /--not-opt-out and --seen go together/],
    [["--to=0491 570 006", `--text=${OK_TEXT}`, `--seen=${REPLY(1)}`], /--not-opt-out and --seen go together/],
    [["--to=0491 570 006", `--text=${OK_TEXT}`, "--not-opt-out=x", "--seen=SM123"], /--seen has to be the reply's ID/],
    [["--to=(02) 5550 1234", `--text=${OK_TEXT}`], /landlines can't get texts/],
    [["--to=0491 570 006", "--text=Hi mate"], /Not sending that: .*Phondo/],
    [["--to=0491 570 006", "--text="], /--text needs a value/],
    [["0491 570 006"], /Unexpected "0491 570 006"/],
    [["--call"], /Unknown option --call/],
    [["--send=yes"], /Unknown option --send=yes/],
  ])("refuses %j before calling Twilio", async (args, why) => {
    const h = harness();
    expect(await h.run(...args)).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
    expect(h.output()).toMatch(why);
  });

  it("prints usage for --help", async () => {
    const h = harness();
    expect(await h.run("--help")).toBe(0);
    expect(h.output()).toMatch(/--to="04…" --text="…"/);
  });
});
