#!/usr/bin/env node
/**
 * Click-to-call from a business number instead of your personal mobile.
 *
 * Twilio rings YOUR mobile first; when you answer, it dials the prospect and
 * shows them DIAL_CALLER_ID (default: Phondo's own line, whose call-backs are
 * answered by Phondo's AI receptionist, which is a free demo).
 *
 *   node --env-file=.env.local --env-file=scripts/outreach/.env \
 *     scripts/outreach/dial.mjs "0469 926 137" [--dry-run] [--consented]
 *
 * Guards (the Telemarketing Industry Standard 2017 covers business numbers too):
 *   - only weekdays 9am-8pm and Saturdays 9am-5pm, Sydney time; never Sundays
 *     or national public holidays. Pass --consented ONLY when the person asked
 *     to be called at this time (express consent given in advance).
 *   - never a number listed in scripts/outreach/do-not-call.txt (gitignored).
 * Each placed call is logged to scripts/outreach/calls.csv (gitignored).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TIME_ZONE = "Australia/Sydney";
const DEFAULT_CALLER_ID = "+61257015064";
const KNOWN_FLAGS = new Set(["--consented", "--dry-run", "--help"]);

// National public holidays, plus the common substitute days (conservative: a
// blocked substitute day costs one day of calls, a missed holiday breaks the
// Standard). Fails closed for any year not listed.
const NATIONAL_PUBLIC_HOLIDAYS = {
  2026: ["2026-01-01", "2026-01-26", "2026-04-03", "2026-04-06", "2026-04-25", "2026-04-27", "2026-12-25", "2026-12-26", "2026-12-28"],
  2027: ["2027-01-01", "2027-01-26", "2027-03-26", "2027-03-29", "2027-04-25", "2027-04-26", "2027-12-25", "2027-12-26", "2027-12-27", "2027-12-28"],
};

/** An Australian mobile or geographic landline in E.164 (+61…), or null. */
export function normalizeAuNumber(input) {
  if (typeof input !== "string" || !/^[\d\s()+.-]+$/.test(input.trim())) return null;
  let digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+61")) digits = digits.slice(3);
  else if (digits.startsWith("61") && digits.length === 11) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 10) digits = digits.slice(1);
  else return null;
  // 4 = mobile; 2/3/7/8 = landlines. 13/1300/1800, 05 and 000 are not callable prospects.
  return /^[23478]\d{8}$/.test(digits) ? `+61${digits}` : null;
}

function sydneyClock(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    weekday: parts.weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** May we place a telemarketing call at `date` (Sydney time)? */
export function callingWindow(date, { consented = false } = {}) {
  if (consented) return { allowed: true, reason: "express consent: they asked to be called at this time" };
  const { ymd, year, weekday, minutes } = sydneyClock(date);
  const holidays = NATIONAL_PUBLIC_HOLIDAYS[year];
  if (!holidays) {
    return { allowed: false, reason: `the public holiday table has no ${year} dates; update NATIONAL_PUBLIC_HOLIDAYS in dial.mjs` };
  }
  if (holidays.includes(ymd)) return { allowed: false, reason: `${ymd} is a national public holiday` };
  if (weekday === "Sun") return { allowed: false, reason: "no telemarketing calls on Sundays" };
  const saturday = weekday === "Sat";
  const close = saturday ? 17 * 60 : 20 * 60;
  if (minutes < 9 * 60 || minutes >= close) {
    return { allowed: false, reason: `outside ${saturday ? "Saturday 9am-5pm" : "weekday 9am-8pm"} (Sydney time)` };
  }
  return { allowed: true, reason: "inside permitted calling hours" };
}

/** TwiML for the leg to your mobile: once you answer, dial the prospect. */
export function buildBridgeTwiml(prospect, callerId) {
  for (const n of [prospect, callerId]) {
    if (!/^\+61\d{9}$/.test(n)) throw new Error(`not an E.164 Australian number: ${n}`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    '<Say voice="Polly.Olivia-Neural" language="en-AU">Connecting you now.</Say>' +
    `<Dial callerId="${callerId}" timeout="30"><Number>${prospect}</Number></Dial>` +
    "</Response>"
  );
}

/** Is `e164` listed (in any format) in a do-not-call list's text? */
export function isOnDoNotCallList(e164, listText) {
  return listText
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .some((line) => normalizeAuNumber(line) === e164);
}

function pretty(e164) {
  const n = e164.slice(3);
  return n.startsWith("4") ? `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : `(0${n[0]}) ${n.slice(1, 5)} ${n.slice(5)}`;
}

const USAGE = `Usage: node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/dial.mjs "<number>" [--dry-run] [--consented]
  --dry-run    check everything and print the plan, but don't call
  --consented  they asked you to ring at this time (allows outside permitted hours)`;

export async function main(argv, env) {
  const args = argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length) {
    console.error(`Unknown option ${unknown.join(", ")}\n${USAGE}`);
    return 1;
  }
  const target = args.filter((a) => !a.startsWith("--")).join(" ");
  if (flags.includes("--help") || !target) {
    console.log(USAGE);
    return target ? 0 : 1;
  }

  const prospect = normalizeAuNumber(target);
  if (!prospect) {
    console.error(`Not an Australian mobile or landline: "${target}"`);
    return 1;
  }
  const dncFile = new URL("./do-not-call.txt", import.meta.url);
  if (existsSync(dncFile) && isOnDoNotCallList(prospect, readFileSync(dncFile, "utf8"))) {
    console.error(`${pretty(prospect)} is on do-not-call.txt, so not calling.`);
    return 1;
  }
  const window = callingWindow(new Date(), { consented: flags.includes("--consented") });
  if (!window.allowed) {
    console.error(
      `Not calling now: ${window.reason}.\nPermitted: weekdays 9am-8pm and Saturdays 9am-5pm (Sydney), never Sundays or national public holidays.\nIf they asked you to ring at this time, re-run with --consented.`
    );
    return 1;
  }

  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = env;
  const myMobile = normalizeAuNumber(env.DIAL_MY_MOBILE ?? "");
  const callerId = normalizeAuNumber(env.DIAL_CALLER_ID || DEFAULT_CALLER_ID);
  if (!sid || !token) {
    console.error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are missing: run with --env-file=.env.local");
    return 1;
  }
  if (!myMobile) {
    console.error("Set DIAL_MY_MOBILE (your own mobile) in scripts/outreach/.env");
    return 1;
  }
  if (!callerId) {
    console.error(`DIAL_CALLER_ID is not an Australian number: "${env.DIAL_CALLER_ID}"`);
    return 1;
  }

  const twiml = buildBridgeTwiml(prospect, callerId);
  const plan = `Twilio rings your mobile ${pretty(myMobile)}; when you answer, it dials ${pretty(prospect)}, who sees ${pretty(callerId)}.`;
  if (flags.includes("--dry-run")) {
    console.log(`[dry run] ${plan}`);
    return 0;
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: myMobile, From: callerId, Twiml: twiml }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Twilio refused the call (HTTP ${res.status}): ${body.message ?? "no details"}${body.code ? ` [code ${body.code}]` : ""}`);
    return 1;
  }

  const log = new URL("./calls.csv", import.meta.url);
  if (!existsSync(log)) appendFileSync(log, "placed_at,prospect,call_sid\n");
  appendFileSync(log, `${new Date().toISOString()},${prospect},${body.sid}\n`);
  console.log(`${plan}\nRinging your mobile now.`);
  console.log("Say who you are and why you're calling. If they ask you to stop, add their number to scripts/outreach/do-not-call.txt.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv, process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Dialer failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  );
}
