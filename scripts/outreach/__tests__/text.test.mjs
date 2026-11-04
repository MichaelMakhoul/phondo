import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byContact, isOptOut, main, messageProblem, normalizeText, parseBatch, planTexts, smsSegments, sydneyDate } from "../text.mjs";

// The texter sends real SMS, so its guards matter more than its happy path:
// Spam Act s 17 (say who it's from) and s 18 (a working opt-out), never anyone
// on the do-not-call list or who asked to stop, never a batch text twice, and
// never the Twilio balance below the floor that keeps the phone lines up.
// Numbers are ACMA-reserved fictitious mobiles (0491 570 xxx), and fetch is always stubbed.

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
const OK_TEXT = "Hi there, Michael from Phondo. Ring our demo line. Reply STOP and I won't msg again.";
const row = (to, business = `Biz ${to.slice(-3)}`, text = OK_TEXT) => ({ to, business, text });
// Thursday 5 Nov 2026, noon in Sydney (AEDT, UTC+11).
const NOON = "2026-11-05T01:00:00Z";

describe("smsSegments", () => {
  it.each([
    ["a".repeat(160), 1],
    ["a".repeat(161), 2],
    ["a".repeat(306), 2],
    ["a".repeat(307), 3],
  ])("GSM-7: %# is billed as %i segment(s)", (text, segments) => {
    expect(smsSegments(text)).toEqual({ encoding: "GSM-7", segments });
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

describe("isOptOut", () => {
  it.each([
    "STOP", "stop", "Stop.", " STOP!!! ", "Unsubscribe", "opt-out", "End", "Quit", "No", "no thanks",
    "Please stop texting me", "Not interested mate", "Don't text me again", "do not contact me",
    "Remove me from your list", "wrong number", "Never call me again", "Nah, no thank you",
  ])("%j asks us to stop", (reply) => {
    expect(isOptOut(reply)).toBe(true);
  });

  it.each([
    "How much?", "Can it stop calls going to voicemail?", "I had to cancel a job today", "Sounds good, call me after 4",
    "No worries, ring me tomorrow", "Who is this?", "", null,
  ])("%j doesn't", (reply) => {
    expect(isOptOut(reply)).toBe(false);
  });
});

describe("parseBatch", () => {
  const json = (rows) => JSON.stringify(rows);

  it("returns E.164 numbers and plain text", () => {
    expect(parseBatch(json([{ to: "0491 570 006", business: " Acme ", text: " Phondo here – Reply STOP " }]))).toEqual([
      { to: A, business: "Acme", text: "Phondo here - Reply STOP" },
    ]);
  });

  it.each([
    ["not json", /valid JSON/],
    [json({ to: A }), /JSON array/],
    [json([{ business: "Acme", text: OK_TEXT }]), /row 1: "" isn't an Australian mobile/],
    [json([{ to: "(02) 5550 1234", business: "Acme", text: OK_TEXT }]), /landlines can't get texts/],
    [json([row(A), { to: "+61 491 570 006", business: "Dup", text: OK_TEXT }]), /row 2: 0491 570 006 is in the batch twice/],
    [json([{ to: A, text: OK_TEXT }]), /"business" is missing/],
    [json([{ to: A, business: "Acme", text: 42 }]), /\(Acme\): "text" is missing/],
    [json([{ to: A, business: "Acme", text: "Hi from Phondo" }]), /\(Acme\): .*STOP/],
    [json([null]), /row 1/],
  ])("refuses %s", (input, why) => {
    expect(() => parseBatch(input)).toThrow(why);
  });
});

// Twilio's Message resource, as its list API returns it.
function twilioMessage({ from = FROM, to, body = "hi", at = "Wed, 04 Nov 2026 01:00:00 +0000", status = "delivered", inbound = false, error = null }) {
  return { from, to, body, date_created: at, status, error_code: error, direction: inbound ? "inbound" : "outbound-api" };
}
const reply = (from, body, at) => twilioMessage({ from, to: FROM, body, at, inbound: true, status: "received" });

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

describe("planTexts", () => {
  const plan = (rows, { messages = [], dnc = [], single = false, dailyMax = 5, today = "2026-11-05" } = {}) =>
    planTexts(rows, { doNotCall: new Set(dnc), contacts: byContact(messages), single, dailyMax, today });

  it("sends in order up to the daily limit, and leaves the rest for later", () => {
    const actions = plan([row(A), row(B), row(C)], { dailyMax: 2 }).map((r) => r.action);
    expect(actions).toEqual(["send", "send", "later"]);
  });

  it("counts batch texts already sent today against the limit, but not other texts", () => {
    const messages = [
      twilioMessage({ to: A, at: "Thu, 05 Nov 2026 00:00:00 +0000" }), // 11am today in Sydney
      twilioMessage({ to: "+61491570999", at: "Thu, 05 Nov 2026 00:00:00 +0000" }), // not in the batch
      twilioMessage({ to: B, at: "Wed, 04 Nov 2026 01:00:00 +0000" }), // yesterday
    ];
    const rows = plan([row(A), row(B), row(C), row(D)], { messages, dailyMax: 2 });
    expect(rows.map((r) => r.action)).toEqual(["skip", "skip", "send", "later"]);
  });

  it("skips the do-not-call list, opt-outs, replies and anyone already texted, saying why", () => {
    const messages = [
      reply(B, "STOP", "Wed, 04 Nov 2026 02:00:00 +0000"),
      reply(C, "How much is it?", "Wed, 04 Nov 2026 02:00:00 +0000"),
      twilioMessage({ to: D, status: "undelivered", error: 30007 }),
    ];
    const rows = plan([row(A), row(B), row(C), row(D)], { messages, dnc: [A] });
    expect(rows.map((r) => [r.action, r.reason])).toEqual([
      ["skip", "on the do-not-call list"],
      ["skip", 'asked to stop on 2026-11-04: "STOP". Add them to the do-not-call list'],
      ["skip", 'replied on 2026-11-04: "How much is it?". Answer with --to'],
      ["skip", "already texted on 2026-11-04 (last one undelivered, error 30007)"],
    ]);
  });

  it("lets a single text answer someone who replied, but never someone who opted out", () => {
    const answered = plan([row(C)], { single: true, messages: [reply(C, "How much?"), twilioMessage({ to: C })] });
    expect(answered[0].action).toBe("send");
    const optedOut = plan([row(B)], { single: true, messages: [reply(B, "how much"), reply(B, "actually, unsubscribe")] });
    expect(optedOut[0]).toMatchObject({ action: "skip", reason: expect.stringMatching(/asked to stop/) });
    const listed = plan([row(A)], { single: true, dnc: [A] });
    expect(listed[0]).toMatchObject({ action: "skip", reason: "on the do-not-call list" });
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
  send = () => "ok", // per POST: "ok", an HTTP status, "network" or "no-sid"
  delivery = "delivered",
  env = {},
} = {}) {
  const dir = mkdtempSync(join(ENV_HOME, "run-"));
  const files = { batch: join(dir, "texts.json"), dnc: join(dir, "do-not-call.txt"), log: join(dir, "texts.csv") };
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
      if (typeof outcome === "number") return Response.json({ message: "Attempt to send to unsubscribed recipient", code: 21610 }, { status: outcome });
      return Response.json({ sid: outcome === "no-sid" ? undefined : SID(posts), status: "queued" }, { status: 201 });
    }
    if (pathname.endsWith("/Balance.json")) return Response.json({ balance, currency });
    if (pathname.endsWith("/Messages.json")) {
      const from = searchParams.get("From");
      const to = searchParams.get("To");
      return Response.json({ messages: messages.filter((m) => (from ? m.from === from : m.to === to)), next_page_uri: null });
    }
    const sid = /\/Messages\/(\w+)\.json$/.exec(pathname)?.[1];
    if (sid) return Response.json({ sid, status: delivery, error_code: delivery === "undelivered" ? 30007 : null, error_message: null });
    throw new Error(`unexpected request ${method} ${url}`);
  });
  const deps = { fetch, now: vi.fn(() => new Date(now)), sleep: vi.fn(async () => {}), log: vi.fn(), error: vi.fn() };
  const fullEnv = {
    HOME: ENV_HOME,
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "secret",
    TEXT_BATCH: files.batch,
    DIAL_DNC_FILE: files.dnc,
    TEXT_LOG: files.log,
    ...env,
  };
  return {
    deps,
    requests,
    files,
    run: (...args) => main(["node", "text.mjs", ...args], fullEnv, deps),
    sentTo: () => requests.filter((r) => r.method === "POST").map((r) => r.body.To),
    logRows: () => {
      try {
        return readFileSync(files.log, "utf8").trim().split("\n").slice(1);
      } catch {
        return [];
      }
    },
    output: () => [...deps.log.mock.calls, ...deps.error.mock.calls].flat().join("\n"),
  };
}

describe("main: batch", () => {
  it("previews by default: shows every text and why, sends nothing", async () => {
    const h = harness({ batch: [row(A, "Acme Plumbing"), row(B)], dnc: "0491 570 156 # asked to stop\n" });
    expect(await h.run()).toBe(0);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/1\. Acme Plumbing, 0491 570 006 · 1 segment · SEND NOW/);
    expect(h.output()).toMatch(/2\. .*SKIP: on the do-not-call list/);
    expect(h.output()).toContain(OK_TEXT);
    expect(h.output()).toMatch(/Preview only: nothing was sent\. Add --send to send the 1 marked SEND NOW/);
  });

  it("sends in order with the batch text, from the outreach number, and logs each one", async () => {
    const h = harness();
    expect(await h.run("--send")).toBe(0);
    const posts = h.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.body)).toEqual([
      { From: FROM, To: A, Body: OK_TEXT },
      { From: FROM, To: B, Body: OK_TEXT },
    ]);
    expect(posts[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect(h.logRows()).toEqual([
      expect.stringMatching(new RegExp(`^2026-11-05T01:00:00.000Z,\\${A},Biz 006,batch,${SID(1)},1$`)),
      expect.stringMatching(new RegExp(`,\\${B},Biz 156,batch,${SID(2)},1$`)),
    ]);
    expect(h.deps.sleep).toHaveBeenCalledWith(20_000); // a gap between texts
    expect(h.output()).toMatch(/Biz 006, 0491 570 006: delivered/);
    expect(h.output()).toMatch(/Sent 2 of 2/);
  });

  it("never texts the same batch row twice: a re-run skips anyone already texted", async () => {
    const h = harness({ messages: [twilioMessage({ to: A, at: "Thu, 05 Nov 2026 00:30:00 +0000" })] });
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([B]);
  });

  it("reads the history from both directions, through every page", async () => {
    const h = harness();
    const pages = [
      { messages: [], next_page_uri: "/2010-04-01/Accounts/ACtest/Messages.json?From=%2B61485094768&Page=1" },
      { messages: [twilioMessage({ to: A })], next_page_uri: null },
    ];
    const inner = h.deps.fetch.getMockImplementation();
    h.deps.fetch.mockImplementation(async (url, init) => {
      if (url.includes("Messages.json?From=")) return Response.json(pages.shift());
      return inner(url, init);
    });
    expect(await h.run("--send")).toBe(0);
    expect(h.sentTo()).toEqual([B]); // A was only on the second page
    const urls = h.deps.fetch.mock.calls.map(([url]) => url);
    expect(urls).toContain("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json?From=%2B61485094768&Page=1");
    expect(urls.some((url) => url.includes("Messages.json?To=%2B61485094768"))).toBe(true);
  });

  it("stops before sending if Twilio's history comes back malformed", async () => {
    const h = harness();
    const inner = h.deps.fetch.getMockImplementation();
    h.deps.fetch.mockImplementation(async (url, init) => (url.includes("Messages.json?") ? Response.json({}) : inner(url, init)));
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Nothing was sent/);
  });

  it("keeps to the daily limit and says how many are left", async () => {
    const h = harness({ batch: [row(A), row(B), row(C)] });
    expect(await h.run("--send", "--max=2")).toBe(0);
    expect(h.sentTo()).toEqual([A, B]);
    expect(h.output()).toMatch(/1 more in the batch: run it again tomorrow/);
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
    const h = harness({ batch: [row(A), row(B)] });
    h.deps.now.mockReturnValueOnce(new Date(NOON)).mockReturnValueOnce(new Date(NOON)).mockReturnValueOnce(new Date(NOON));
    h.deps.now.mockReturnValue(new Date("2026-11-05T09:00:00Z")); // 8pm
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

  it.each([
    ["an unreadable balance", { balance: "n/a" }],
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

  it.each([
    ["a network failure", "network", /ECONNRESET/],
    ["a gateway error", 502, /HTTP 502/],
    ["a reply without a message ID", "no-sid", /without a message ID/],
  ])("stops on %s, which may have sent the text, and says a re-run is safe", async (_, outcome, why) => {
    const h = harness({ batch: [row(A), row(B)], send: () => outcome });
    expect(await h.run("--send")).toBe(1);
    expect(h.sentTo()).toEqual([A]);
    expect(h.output()).toMatch(why);
    expect(h.output()).toMatch(/may have gone.*Re-running is safe/);
  });

  it("reports texts a carrier didn't deliver, and exits non-zero", async () => {
    const h = harness({ delivery: "undelivered" });
    expect(await h.run("--send")).toBe(1);
    expect(h.output()).toMatch(/undelivered \(error 30007\)/);
  });

  it("still sends when the log can't be written, and prints the row to add by hand", async () => {
    const h = harness({ env: { TEXT_LOG: join(ENV_HOME, "no-such-dir-file", "x") } });
    writeFileSync(join(ENV_HOME, "no-such-dir-file"), "a file, so the log's directory can't be made");
    expect(await h.run("--send")).toBe(0);
    expect(h.output()).toMatch(/couldn't be written .*Add this row by hand:\n.*batch,SM/);
  });

  it.each([
    ["the do-not-call list is missing", { dnc: null }, /No do-not-call list/],
    ["the do-not-call list has a bad line", { dnc: "Joe Bloggs\n" }, /isn't exactly one phone number/],
    ["the batch is missing", { batch: null }, /No batch at/],
    ["the batch is empty", { batch: [] }, /is empty/],
    ["a batch text has no opt-out", { batch: [row(A, "Acme", "Hi from Phondo")] }, /row 1 \(Acme\).*STOP/],
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
    expect(h.logRows()).toEqual([expect.stringMatching(new RegExp(`,\\${A},,single,${SID(1)},1$`))]);
  });

  it("refuses someone who asked to stop", async () => {
    const h = harness({ messages: [reply(A, "Stop texting me")] });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
    expect(h.output()).toMatch(/Not texting 0491 570 006: asked to stop/);
  });

  it("refuses someone on the do-not-call list", async () => {
    const h = harness({ dnc: "0491 570 006 # said no on a call\n" });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(h.sentTo()).toEqual([]);
  });

  it("says a re-run would text them again when the send is uncertain", async () => {
    const h = harness({ send: () => "network" });
    expect(await h.run("--to=0491 570 006", `--text=${OK_TEXT}`, "--send")).toBe(1);
    expect(h.output()).toMatch(/Check the Twilio console before sending it again/);
  });

  it.each([
    [["--to=0491 570 006"], /go together/],
    [[`--text=${OK_TEXT}`], /go together/],
    [["--to=0491 570 006", `--text=${OK_TEXT}`, "--max=3"], /--max is for the batch/],
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
