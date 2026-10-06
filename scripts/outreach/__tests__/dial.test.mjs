import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newCode,
  normalizeAuNumber,
  zonesFor,
  callingWindow,
  NATIONAL_PUBLIC_HOLIDAYS,
  buildBridgeTwiml,
  buildHoldTwiml,
  parseDoNotCallList,
  main,
} from "../dial.mjs";

// The dialer places real phone calls, so its guards matter more than its happy
// path. Telemarketing Industry Standard 2017 s 8: weekdays 9am-8pm, Saturdays
// 9am-5pm, never Sundays or national public holidays, in the RECIPIENT's local
// time (s 8(4)), unless they gave express consent, which must be provable
// (s 8(5)). Numbers here are ACMA-reserved fictitious ones (0491 570 xxx mobiles,
// 5550 xxxx landlines) or Phondo's own line, and fetch is always stubbed.

const SYDNEY = "Australia/Sydney";

// Every test runs with HOME pointed at a throwaway dir, so neither a test nor a
// regression can write into the operator's real ~/.phondo-outreach (their consent
// evidence lives there).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "dial-home-"));
beforeEach(() => vi.stubEnv("HOME", FAKE_HOME));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("normalizeAuNumber", () => {
  it.each([
    ["0491 570 006", "+61491570006"],
    ["0491570006", "+61491570006"],
    ["+61 491 570 006", "+61491570006"],
    ["61491570006", "+61491570006"],
    ["+61 (0)491 570 006", "+61491570006"],
    ["+61 0491 570 006", "+61491570006"],
    ["0061 491 570 006", "+61491570006"],
    ["(02) 5550 1234", "+61255501234"],
    ["08-5550-1234", "+61855501234"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeAuNumber(input)).toBe(expected);
  });

  it.each([
    "", "12345", "491 570 006", "0491 570 00", "0491 570 0066", "+1 415 555 0100", "1300 123 456", "13 12 34", "000",
    "0569 926 137", "abc", "+61 13 12 34", "+61 1300 123 456", "+61 491 570 00", "+61 569 926 137", "04+91 570 006",
  ])("rejects %s (not an Australian mobile or geographic landline)", (bad) => {
    expect(normalizeAuNumber(bad)).toBeNull();
  });
});

describe("zonesFor: the recipient's possible local time zones", () => {
  it("maps landline area codes to every zone they span", () => {
    expect(zonesFor("+61255501234", SYDNEY)).toEqual([SYDNEY]);
    expect(zonesFor("+61355501234", SYDNEY)).toEqual([SYDNEY]);
    // Tweed Heads is in NSW (daylight saving) but shares Queensland's 07 numbers.
    expect(zonesFor("+61755501234", SYDNEY)).toEqual(["Australia/Brisbane", SYDNEY]);
    expect(zonesFor("+61855501234", SYDNEY)).toEqual(["Australia/Adelaide", "Australia/Darwin", "Australia/Perth"]);
  });

  it("uses the given zone for a mobile (its location isn't in the number)", () => {
    expect(zonesFor("+61491570006", "Australia/Perth")).toEqual(["Australia/Perth"]);
  });
});

describe("callingWindow", () => {
  const at = (iso, zones = [SYDNEY]) => callingWindow(new Date(iso), { zones });

  it("allows weekdays from 9am to just before 8pm", () => {
    expect(at("2026-10-07T08:59:00+11:00").allowed).toBe(false);
    expect(at("2026-10-07T09:00:00+11:00").allowed).toBe(true);
    expect(at("2026-10-07T19:59:00+11:00").allowed).toBe(true);
    expect(at("2026-10-07T20:00:00+11:00").allowed).toBe(false);
  });

  it("allows Saturdays from 9am to just before 5pm", () => {
    expect(at("2026-10-10T08:59:00+11:00").allowed).toBe(false);
    expect(at("2026-10-10T16:59:00+11:00").allowed).toBe(true);
    expect(at("2026-10-10T17:00:00+11:00").allowed).toBe(false);
  });

  it("never allows Sundays or national public holidays", () => {
    expect(at("2026-10-11T12:00:00+11:00").allowed).toBe(false); // Sunday
    expect(at("2026-12-25T12:00:00+11:00").allowed).toBe(false); // Christmas
    expect(at("2027-03-26T12:00:00+11:00").allowed).toBe(false); // Good Friday 2027
  });

  it("reads the weekday and date in the local zone, not UTC", () => {
    expect(at("2026-10-11T09:30:00+11:00").allowed).toBe(false); // Sunday in Sydney, still Saturday in UTC
    expect(at("2026-12-25T09:30:00+11:00").allowed).toBe(false); // Christmas in Sydney, 24 Dec in UTC
    expect(at("2027-01-27T09:30:00+11:00").allowed).toBe(true); // a Wednesday in Sydney, still Australia Day in UTC
  });

  it("judges every possible zone in its own local time, DST included", () => {
    expect(at("2026-10-06T22:30:00Z").allowed).toBe(true); // 9:30am AEDT Wed
    expect(at("2026-07-15T08:30:00+10:00").allowed).toBe(false); // 8:30am AEST
    // 9:05am in Sydney is 6:05am in Perth: an 08 number must wait.
    expect(at("2026-10-07T09:05:00+11:00", zonesFor("+61855501234", SYDNEY)).allowed).toBe(false);
    // 9:30am AEDT is 8:30am in Brisbane, which has no daylight saving.
    expect(at("2026-10-07T09:30:00+11:00", zonesFor("+61755501234", SYDNEY)).allowed).toBe(false);
    expect(at("2026-10-07T10:30:00+11:00", zonesFor("+61755501234", SYDNEY)).allowed).toBe(true);
    // 7:30pm in Brisbane is 8:30pm in Tweed Heads.
    expect(at("2026-10-07T19:30:00+10:00", zonesFor("+61755501234", SYDNEY)).allowed).toBe(false);
  });

  it("fails closed for a year the holiday table doesn't cover", () => {
    const result = at("2029-03-01T12:00:00+11:00");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/holiday/i);
  });

  it("fails closed when the clock can't be read", () => {
    const garbled = [
      { type: "day", value: "7" },
      { type: "month", value: "10" },
      { type: "year", value: "2026" },
      { type: "hour", value: "??" },
      { type: "minute", value: "00" },
    ];
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(garbled);
    try {
      const result = at("2026-10-07T12:00:00+11:00");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/clock/);
    } finally {
      spy.mockRestore();
    }
  });

  it("express consent overrides the hours (they asked to be called then)", () => {
    expect(callingWindow(new Date("2026-10-11T07:30:00+11:00"), { zones: [SYDNEY], consented: true }).allowed).toBe(true);
  });
});

describe("NATIONAL_PUBLIC_HOLIDAYS", () => {
  const DAY = 86_400_000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
  const easterSunday = (y) => {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, month - 1, day);
  };

  it.each(Object.entries(NATIONAL_PUBLIC_HOLIDAYS))("%s lists every national public holiday", (year, dates) => {
    for (const date of dates) expect(date.startsWith(`${year}-`)).toBe(true);
    for (const fixed of ["01-01", "01-26", "04-25", "12-25", "12-26"]) expect(dates).toContain(`${year}-${fixed}`);
    const easter = easterSunday(Number(year));
    expect(dates).toContain(iso(easter - 2 * DAY)); // Good Friday
    expect(dates).toContain(iso(easter + DAY)); // Easter Monday
  });

  it.each(Object.entries(NATIONAL_PUBLIC_HOLIDAYS))("%s has a weekday substitute for each weekend holiday", (year, dates) => {
    for (const fixed of ["01-01", "01-26", "04-25", "12-25", "12-26"]) {
      const day = Date.parse(`${year}-${fixed}T00:00:00Z`);
      if (![0, 6].includes(new Date(day).getUTCDay())) continue;
      const followingWeekdays = [1, 2, 3].map((n) => day + n * DAY).filter((ms) => ![0, 6].includes(new Date(ms).getUTCDay()));
      expect(followingWeekdays.some((ms) => dates.includes(iso(ms))), `${year}-${fixed}`).toBe(true);
    }
  });
});

describe("TwiML", () => {
  it("bridges to the prospect showing the business caller ID", () => {
    const twiml = buildBridgeTwiml("+61491570006", "+61257015064");
    expect(twiml).toContain('<Dial callerId="+61257015064"');
    expect(twiml).toContain("<Number>+61491570006</Number>");
  });

  it("refuses anything that isn't plain E.164 (no markup can reach the TwiML)", () => {
    expect(() => buildBridgeTwiml('+614"/><Hangup/>', "+61257015064")).toThrow();
    expect(() => buildBridgeTwiml("+61491570006", "0257015064")).toThrow();
  });

  it("holds your phone with a spoken code and never dials anyone", () => {
    const hold = buildHoldTwiml("47");
    expect(hold).toContain("4 7");
    expect(hold).toContain("<Pause");
    expect(hold).not.toContain("<Dial");
    expect(() => buildHoldTwiml('4"/><Dial>')).toThrow();
  });
});

describe("newCode", () => {
  it("draws a fresh two-digit code for each call", () => {
    const draws = Array.from({ length: 200 }, newCode);
    expect(draws.every((c) => /^\d{2}$/.test(c))).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(30);
  });
});

describe("parseDoNotCallList", () => {
  it("reads one number per line in any format, with notes after #", () => {
    const list = parseDoNotCallList(
      "﻿# asked not to be called\n0491 570 006 # Joe's Plumbing, asked to stop 7/10\n\n+61 (0)491 570 156\r\n0491-570-157   # mobile\n"
    );
    expect([...list].sort()).toEqual(["+61491570006", "+61491570156", "+61491570157"]);
  });

  it.each([
    ["a note without #", "0491 570 006 Joe's Plumbing"],
    ["a CSV row", "0491570006,Joe"],
    ["a name first", "Joe 0491 570 158"],
    ["two numbers", "0491 570 006 / 0491 570 156"],
  ])("stops at %s instead of silently skipping it", (_, line) => {
    expect(() => parseDoNotCallList(`0491 570 159\n${line}\n`)).toThrow(/line 2/);
  });
});

// main() with every side effect injected: no real network, and no real files
// unless a test opts in with temp paths.
const SID = "CA" + "0123456789abcdef".repeat(2);
const spokenCode = (twiml) => twiml.match(/type ([\d ]+) in your terminal/)?.[1].replace(/ /g, "");

function harness({
  status = "in-progress",
  answeredBy = "human",
  typed, // what you type; by default, the code spoken on the call
  dnc = "",
  now = "2026-10-07T10:00:00+11:00",
  bridge = "ok", // or an HTTP status, or "network"
  realFiles = false,
  env = {},
} = {}) {
  const requests = [];
  let spoken = null;
  let polls = 0;
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    requests.push({ url, method, body });
    if (method === "GET") {
      // Answering-machine detection settles a moment after your phone is answered.
      polls += 1;
      return Response.json({ sid: SID, status, answered_by: polls > 1 ? answeredBy : null });
    }
    if (url.endsWith("/Calls.json")) spoken = spokenCode(body.Twiml);
    if (body?.Twiml?.includes("<Dial") && bridge !== "ok") {
      if (bridge === "network") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      if (bridge >= 500) return new Response("<html>Bad Gateway</html>", { status: bridge });
      return Response.json({ message: "Call is not in-progress. Cannot redirect.", code: 21220 }, { status: bridge });
    }
    return Response.json({ sid: SID, status: "queued" }, { status: 201 });
  });
  const deps = {
    fetch,
    now: vi.fn(() => new Date(now)),
    sleep: async () => {},
    code: vi.fn().mockReturnValueOnce("83").mockReturnValue("38"), // a second draw would differ
    interactive: () => true,
    ask: vi.fn(async () => (typed === undefined ? spoken : typed)),
    readDoNotCall: () => dnc,
    appendLog: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  };
  if (realFiles) {
    delete deps.readDoNotCall;
    delete deps.appendLog;
  }
  const fullEnv = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "secret", DIAL_MY_MOBILE: "0491 570 159", ...env };
  return {
    deps,
    requests,
    run: (...args) => main(["node", "dial.mjs", ...args], fullEnv, deps),
    dialed: () => requests.some((r) => r.body?.Twiml?.includes("<Dial")),
    hungUp: () => requests.some((r) => r.body?.Status === "completed"),
    loggedRow: () => deps.appendLog?.mock.calls[0]?.[1],
    output: () => [...deps.log.mock.calls, ...deps.error.mock.calls].flat().join("\n"),
  };
}

describe("main", () => {
  it("previews by default: runs every guard, places no call", async () => {
    const h = harness();
    expect(await h.run("0491 570 006")).toBe(0);
    expect(h.deps.fetch).not.toHaveBeenCalled();
    expect(h.output()).toMatch(/Preview only/);
    expect(h.output()).toMatch(/assumed for a mobile/);
  });

  it("connects the prospect only after you type the code spoken on your phone", async () => {
    const h = harness();
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    const create = h.requests[0];
    expect(create.url).toMatch(/\/Calls\.json$/);
    expect(create.body).toMatchObject({
      To: "+61491570159",
      From: "+61257015064",
      Timeout: "20",
      MachineDetection: "Enable",
      MachineDetectionTimeout: "10",
    });
    expect(create.body.Twiml).toContain("8 3");
    expect(create.body.Twiml).not.toContain("<Dial");
    expect(h.deps.ask).toHaveBeenCalledOnce();
    expect(h.dialed()).toBe(true);
    expect(h.deps.appendLog).toHaveBeenCalledOnce();
    expect(h.loggedRow()).toContain(`,+61491570006,${SID},connected,Australia/Sydney,human,`);
  });

  it("never shows the code anywhere but on the call", async () => {
    const h = harness();
    await h.run("0491 570 006", "--call");
    const shown = [h.output(), ...h.deps.ask.mock.calls.map(([question]) => question)].join("\n");
    expect(shown).not.toMatch(/8\s?3/);
  });

  it.each([
    ["a wrong code", "74"],
    ["no code (voicemail answered, or you declined)", null],
  ])("hangs up without ringing the prospect on %s", async (_, typed) => {
    const h = harness({ typed });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.dialed()).toBe(false);
    expect(h.hungUp()).toBe(true);
    expect(h.deps.appendLog).not.toHaveBeenCalled();
  });

  it.each(["machine_start", "machine_end_beep", "fax"])(
    "hangs up as soon as Twilio says %s answered your phone (declining the call cancels it)",
    async (answeredBy) => {
      const h = harness({ answeredBy });
      expect(await h.run("0491 570 006", "--call")).toBe(1);
      expect(h.deps.ask).not.toHaveBeenCalled();
      expect(h.dialed()).toBe(false);
      expect(h.hungUp()).toBe(true);
      expect(h.output()).toMatch(/was not called/);
    }
  );

  it.each(["human", "unknown"])("connects when answering-machine detection says %s and the code matches", async (answeredBy) => {
    const h = harness({ answeredBy });
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    expect(h.dialed()).toBe(true);
    expect(h.loggedRow()).toContain(`,${answeredBy},`);
  });

  it("says so, and logs it, when Twilio gives no answering-machine result", async () => {
    const h = harness({ answeredBy: null });
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    expect(h.output()).toMatch(/no answering-machine result/);
    expect(h.loggedRow()).toContain(",none,");
  });

  it("never rings the prospect when your phone isn't answered", async () => {
    const h = harness({ status: "no-answer" });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.dialed()).toBe(false);
    expect(h.deps.ask).not.toHaveBeenCalled();
  });

  it("gives up and hangs up if your phone never stops ringing", async () => {
    const h = harness({ status: "ringing" });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.dialed()).toBe(false);
    expect(h.hungUp()).toBe(true);
    expect(h.deps.ask).not.toHaveBeenCalled();
  });

  it("won't ring your phone without a terminal to type the code into", async () => {
    const h = harness();
    h.deps.interactive = () => false;
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses, in preview too, when the do-not-call list is missing, unreadable, or lists the number", async () => {
    for (const dnc of [null, "Joe 0491 570 006\n", "0491 570 006 # asked to stop\n"]) {
      for (const mode of [[], ["--call"]]) {
        const h = harness({ dnc });
        expect(await h.run("0491 570 006", ...mode)).toBe(1);
        expect(h.deps.fetch).not.toHaveBeenCalled();
      }
    }
  });

  it("refuses outside the prospect's calling hours", async () => {
    const h = harness({ now: "2026-10-07T07:30:00+11:00" });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });

  it("re-checks the hours just before connecting", async () => {
    const h = harness();
    h.deps.now
      .mockReturnValueOnce(new Date("2026-10-07T19:59:30+11:00"))
      .mockReturnValue(new Date("2026-10-07T20:00:05+11:00"));
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.dialed()).toBe(false);
    expect(h.hungUp()).toBe(true);
  });

  it("allows outside hours only with a consent note, and logs the note as evidence", async () => {
    const bare = harness({ now: "2026-10-11T07:30:00+11:00" });
    expect(await bare.run("0491 570 006", "--call", "--consented")).toBe(1);
    expect(bare.deps.fetch).not.toHaveBeenCalled();
    const noted = harness({ now: "2026-10-11T07:30:00+11:00" });
    expect(await noted.run("0491 570 006", "--call", "--consented=asked 3/10 to ring Sun 7:30am, mobile")).toBe(0);
    expect(noted.loggedRow()).toContain('"asked 3/10 to ring Sun 7:30am, mobile"');
  });

  it("uses --tz for a mobile's local hours", async () => {
    const early = harness({ now: "2026-10-07T09:30:00+11:00" }); // 6:30am in Perth
    expect(await early.run("0491 570 006", "--call", "--tz=Australia/Perth")).toBe(1);
    expect(early.deps.fetch).not.toHaveBeenCalled();
    const open = harness({ now: "2026-10-07T12:30:00+11:00" }); // 9:30am in Perth
    expect(await open.run("0491 570 006", "--tz=Australia/Perth")).toBe(0);
    expect(open.output()).toContain("Australia/Perth (from --tz)");
  });

  it("only adds --tz to a landline's zones, never replaces them", async () => {
    const h = harness({ now: "2026-10-07T10:00:00+11:00" }); // 7am in Perth
    expect(await h.run("(08) 5550 1234", "--tz=Australia/Sydney")).toBe(1);
  });

  it.each(["UTC", "Etc/GMT+8", "Australia/Perh", "America/New_York"])("rejects --tz=%s (not an Australian zone)", async (zone) => {
    // Inside calling hours in UTC, UTC-8 and New York alike, so only the zone check can refuse.
    const h = harness({ now: "2026-10-07T17:00:00Z" });
    expect(await h.run("0491 570 006", `--tz=${zone}`)).toBe(1);
  });

  it("rejects unknown flags, so a typo can't silently pass", async () => {
    for (const flag of ["--consent", "--dry-run", "--call=no", "--constructor", "--toString"]) {
      const h = harness();
      expect(await h.run("0491 570 006", "--call", flag)).toBe(1);
      expect(h.deps.fetch).not.toHaveBeenCalled();
    }
  });

  it("--help exits cleanly; no number is an error", async () => {
    expect(await harness().run("--help")).toBe(0);
    expect(await harness().run()).toBe(1);
  });

  it.each([
    ["blank", ""],
    ["the .env.example placeholder", "0400 000 000"],
    ["a landline", "(02) 5550 1234"],
    ["the number being called", "0491 570 006"],
  ])("requires DIAL_MY_MOBILE to be your own mobile, not %s", async (_, mobile) => {
    const h = harness({ env: { DIAL_MY_MOBILE: mobile } });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });

  it("reports a rejected call (4xx) as nobody called", async () => {
    const h = harness();
    h.deps.fetch.mockImplementationOnce(async () => Response.json({ message: "Invalid 'To' number", code: 21211 }, { status: 400 }));
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.output()).toMatch(/21211/);
    expect(h.output()).toMatch(/Nobody was called/);
  });

  it("says your phone may ring after a gateway error, a reply with no call SID, or a lost connection", async () => {
    const replies = [
      async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      async () => new Response("{}", { status: 201 }),
      async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      },
    ];
    for (const reply of replies) {
      const h = harness();
      h.deps.fetch.mockImplementationOnce(reply);
      expect(await h.run("0491 570 006", "--call")).toBe(1);
      expect(h.output()).toMatch(/phone rings/i);
      expect(h.dialed()).toBe(false);
    }
  });

  it("reports a refused connection (4xx) as not called, and logs nothing", async () => {
    const h = harness({ bridge: 400 });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.output()).toMatch(/was not called/);
    expect(h.deps.appendLog).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", "network"],
    ["an internal error", 500],
    ["a gateway error", 502],
  ])("treats %s while connecting as maybe connected: logs it and doesn't hang up", async (_, bridge) => {
    const h = harness({ bridge });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.output()).toMatch(/may be ringing/);
    expect(h.output()).toMatch(/Don't re-run/);
    expect(h.loggedRow()).toContain(",unconfirmed,");
    expect(h.hungUp()).toBe(false);
  });

  it("still reports a connected call when the call log can't be written", async () => {
    const h = harness();
    h.deps.appendLog.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    expect(h.output()).toMatch(/Add this row by hand/);
    expect(h.output()).toMatch(/Don't re-run/);
  });
});

describe("main with real files on disk (fetch still stubbed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dial-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name, contents) => {
    const path = join(dir, name);
    if (contents !== null) writeFileSync(path, contents);
    return path;
  };

  it("refuses when DIAL_DNC_FILE doesn't exist, and names it", async () => {
    const path = file("missing.txt", null);
    const h = harness({ realFiles: true, env: { DIAL_DNC_FILE: path } });
    expect(await h.run("0491 570 006")).toBe(1);
    expect(h.output()).toContain(path);
  });

  it("refuses a number listed in DIAL_DNC_FILE", async () => {
    const h = harness({ realFiles: true, env: { DIAL_DNC_FILE: file("listed.txt", "0491 570 006 # asked to stop\n") } });
    expect(await h.run("0491 570 006")).toBe(1);
  });

  it("checks an empty list and says so", async () => {
    const path = file("empty.txt", "");
    const h = harness({ realFiles: true, env: { DIAL_DNC_FILE: path } });
    expect(await h.run("0491 570 006")).toBe(0);
    expect(h.output()).toContain(`0 numbers checked (${path})`);
  });

  it("creates DIAL_CALL_LOG with a header and records the call", async () => {
    const log = join(dir, "nested", "calls.csv");
    const h = harness({ realFiles: true, env: { DIAL_DNC_FILE: file("ok.txt", ""), DIAL_CALL_LOG: log } });
    expect(await h.run("0491 570 006", "--call", "--consented=asked to ring, any time")).toBe(0);
    const [header, row, extra] = readFileSync(log, "utf8").trim().split("\n");
    expect(header).toBe("placed_at,prospect,call_sid,outcome,zones,amd,consent");
    expect(row).toContain(`,+61491570006,${SID},connected,Australia/Sydney,human,"asked to ring, any time"`);
    expect(extra).toBeUndefined();
  });

  it("defaults both files to ~/.phondo-outreach, outside any checkout", async () => {
    const dataDir = join(FAKE_HOME, ".phondo-outreach");
    const missing = harness({ realFiles: true });
    expect(await missing.run("0491 570 006")).toBe(1);
    expect(missing.output()).toContain(join(dataDir, "do-not-call.txt"));
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "do-not-call.txt"), "");
    const h = harness({ realFiles: true });
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    expect(readFileSync(join(dataDir, "calls.csv"), "utf8")).toContain(`,+61491570006,${SID},connected,`);
  });
});
