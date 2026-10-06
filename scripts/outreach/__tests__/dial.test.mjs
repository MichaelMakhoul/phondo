import { describe, it, expect, vi } from "vitest";
import {
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

// main() with every side effect injected: no real network, file or terminal.
const SID = "CA" + "0123456789abcdef".repeat(2);

function harness({ status = "in-progress", typed = "47", dnc = "", now = "2026-10-07T10:00:00+11:00", bridge = 200, env = {} } = {}) {
  const requests = [];
  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    requests.push({ url, method, body });
    if (method === "GET") return Response.json({ sid: SID, status });
    if (body?.Twiml?.includes("<Dial") && bridge !== 200) {
      return Response.json({ message: "Call is not in-progress. Cannot redirect.", code: 21220 }, { status: bridge });
    }
    return Response.json({ sid: SID, status: "queued" }, { status: 201 });
  });
  const deps = {
    fetch,
    now: vi.fn(() => new Date(now)),
    sleep: async () => {},
    code: () => "47",
    ask: vi.fn(async () => typed),
    readDoNotCall: () => dnc,
    appendLog: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  };
  const fullEnv = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "secret", DIAL_MY_MOBILE: "0491 570 159", ...env };
  return {
    deps,
    requests,
    run: (...args) => main(["node", "dial.mjs", ...args], fullEnv, deps),
    dialed: () => requests.some((r) => r.body?.Twiml?.includes("<Dial")),
    hungUp: () => requests.some((r) => r.body?.Status === "completed"),
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

  it("connects the prospect only after you type the code read out on your phone", async () => {
    const h = harness();
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    const create = h.requests[0];
    expect(create.url).toMatch(/\/Calls\.json$/);
    expect(create.body).toMatchObject({ To: "+61491570159", From: "+61257015064" });
    expect(create.body.Twiml).toContain("4 7");
    expect(create.body.Twiml).not.toContain("<Dial");
    expect(h.deps.ask).toHaveBeenCalledOnce();
    expect(h.dialed()).toBe(true);
    expect(h.deps.appendLog).toHaveBeenCalledOnce();
    expect(h.deps.appendLog.mock.calls[0][0]).toContain("+61491570006");
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

  it("refuses when the do-not-call list is missing, unreadable, or lists the number", async () => {
    for (const dnc of [null, "Joe 0491 570 006\n", "0491 570 006 # asked to stop\n"]) {
      const h = harness({ dnc });
      expect(await h.run("0491 570 006", "--call")).toBe(1);
      expect(h.deps.fetch).not.toHaveBeenCalled();
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
    expect(noted.deps.appendLog.mock.calls[0][0]).toContain('"asked 3/10 to ring Sun 7:30am, mobile"');
  });

  it("uses --tz for a mobile's local hours, and rejects a zone it doesn't know", async () => {
    const perth = harness({ now: "2026-10-07T09:30:00+11:00" }); // 6:30am in Perth
    expect(await perth.run("0491 570 006", "--call", "--tz=Australia/Perth")).toBe(1);
    expect(perth.deps.fetch).not.toHaveBeenCalled();
    const typo = harness();
    expect(await typo.run("0491 570 006", "--call", "--tz=Australia/Perh")).toBe(1);
    expect(typo.deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects unknown flags, so a typo can't silently pass", async () => {
    for (const flag of ["--consent", "--dry-run", "--call=no"]) {
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

  it("surfaces a Twilio error, even when the error body isn't JSON", async () => {
    const h = harness();
    h.deps.fetch.mockImplementationOnce(async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.output()).toMatch(/502/);
    expect(h.dialed()).toBe(false);
  });

  it("says the call may exist when Twilio's reply has no call SID or never arrives", async () => {
    const noSid = harness();
    noSid.deps.fetch.mockImplementationOnce(async () => new Response("{}", { status: 201 }));
    expect(await noSid.run("0491 570 006", "--call")).toBe(1);
    expect(noSid.output()).toMatch(/phone rings/i);
    const lost = harness();
    lost.deps.fetch.mockImplementationOnce(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    expect(await lost.run("0491 570 006", "--call")).toBe(1);
    expect(lost.output()).toMatch(/ECONNRESET/);
    expect(lost.output()).toMatch(/phone rings/i);
  });

  it("reports a refused connection as not called, and logs nothing", async () => {
    const h = harness({ bridge: 400 });
    expect(await h.run("0491 570 006", "--call")).toBe(1);
    expect(h.output()).toMatch(/was not called/);
    expect(h.deps.appendLog).not.toHaveBeenCalled();
  });

  it("still reports a connected call when calls.csv can't be written", async () => {
    const h = harness();
    h.deps.appendLog.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(await h.run("0491 570 006", "--call")).toBe(0);
    expect(h.output()).toMatch(/Add this row by hand/);
    expect(h.output()).toMatch(/Don't re-run/);
  });
});
