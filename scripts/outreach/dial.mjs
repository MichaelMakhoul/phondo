#!/usr/bin/env node
/**
 * Click-to-call from a business number instead of your personal mobile.
 *
 * Twilio rings YOUR mobile and reads you a two-digit code. Type it here, and
 * only then does Twilio dial the prospect, showing DIAL_CALLER_ID (default:
 * Phondo's own line, so a call-back reaches Phondo's AI receptionist). Typing
 * the code shows you're on the call, and if Twilio detects that voicemail or a
 * call screener answered your phone instead, it won't connect: the prospect is
 * never rung into a silent call.
 *
 *   node --env-file=.env.local --env-file=scripts/outreach/.env \
 *     scripts/outreach/dial.mjs "0491 570 006"          # preview: run the checks, don't call
 *   ...  scripts/outreach/dial.mjs "0491 570 006" --call   # place the call
 *
 * Guards (the Telemarketing Industry Standard 2017 covers business numbers too):
 *   - s 8: weekdays 9am-8pm and Saturdays 9am-5pm, never Sundays or national
 *     public holidays, in the PROSPECT's local time (area code for landlines;
 *     Sydney, or --tz, for mobiles). --consented="<note>" lifts this only when
 *     they asked to be called then; the note is logged as the evidence s 8(5) needs.
 *   - never a number on the do-not-call list. A missing list, or a line that
 *     isn't exactly one number, stops the script instead of being skipped.
 * The list and the call log live in ~/.phondo-outreach/ (override with
 * DIAL_DNC_FILE and DIAL_CALL_LOG), outside any checkout, so a git clean or a
 * new worktree can't lose them.
 */
import { randomInt } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SYDNEY = "Australia/Sydney";
const DEFAULT_CALLER_ID = "+61257015064";
const PLACEHOLDER_MOBILE = "+61400000000"; // the old .env.example value
const RING_SECONDS = 20; // how long Twilio rings your mobile
const ASK_TIMEOUT_MS = 45_000; // well inside the hold message, so your leg is still up
const REQUEST_TIMEOUT_MS = 20_000;
const POLL_MS = 1_000;
const MAX_RING_POLLS = RING_SECONDS + 15;
const DATA_DIR = join(homedir(), ".phondo-outreach");
const LOG_HEADER = "placed_at,prospect,call_sid,outcome,zones,consent\n";
const FINISHED = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const VOICE = 'voice="Polly.Olivia-Neural" language="en-AU"';

// The recipient's local time (s 8(4)), by area code. 07 includes Sydney because
// Tweed Heads (NSW, daylight saving) shares Queensland's numbers; 08 is SA, NT
// and WA, plus Broken Hill on Adelaide time. Island ranges with their own time
// (Lord Howe, Christmas, Cocos) aren't modelled.
const LANDLINE_ZONES = {
  2: [SYDNEY],
  3: [SYDNEY],
  7: ["Australia/Brisbane", SYDNEY],
  8: ["Australia/Adelaide", "Australia/Darwin", "Australia/Perth"],
};

// s 8(3): the national public holidays plus weekday substitutes, including
// state-only ones (a blocked day costs a day of calls; a missed one breaks the
// Standard). Fails closed for any year not listed.
export const NATIONAL_PUBLIC_HOLIDAYS = {
  2026: ["2026-01-01", "2026-01-26", "2026-04-03", "2026-04-06", "2026-04-25", "2026-04-27", "2026-12-25", "2026-12-26", "2026-12-28"],
  2027: ["2027-01-01", "2027-01-26", "2027-03-26", "2027-03-29", "2027-04-25", "2027-04-26", "2027-12-25", "2027-12-26", "2027-12-27", "2027-12-28"],
  2028: ["2028-01-01", "2028-01-03", "2028-01-26", "2028-04-14", "2028-04-17", "2028-04-25", "2028-12-25", "2028-12-26"],
};

// Permitted hours by weekday (0 = Sunday), in minutes after local midnight: [open, close).
const HOURS = { 1: [540, 1200], 2: [540, 1200], 3: [540, 1200], 4: [540, 1200], 5: [540, 1200], 6: [540, 1020] };
const HOURS_HELP =
  "Permitted: weekdays 9am-8pm and Saturdays 9am-5pm in their local time, never Sundays or national public holidays.\n" +
  'If they asked you to ring at this time, re-run with --consented="what they said, and when".';

const USAGE = `Usage: node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/dial.mjs "<number>" [options]
  (no options)       preview: run every check and show the plan, without calling
  --call             ring your mobile; type the code it reads you, then it rings them
  --tz=ZONE          a mobile's time zone if they're not in Sydney, e.g. --tz=Australia/Perth
  --consented="..."  they asked to be called at this time; the note is logged as your evidence`;
const FLAGS = { call: "switch", help: "switch", tz: "value", consented: "value" };

/** An Australian mobile or geographic landline in E.164 (+61…), or null. */
export function normalizeAuNumber(input) {
  if (typeof input !== "string" || !/^[\d\s()+.-]+$/.test(input.trim())) return null;
  // +61, 0061 or 61, optionally followed by the trunk 0 ("+61 (0)4…"), or just the trunk 0.
  // 4 = mobile; 2/3/7/8 = landlines. 13/1300/1800, 05 and 000 are not callable prospects.
  const match = /^(?:(?:\+61|0061|61)0?|0)([23478]\d{8})$/.exec(input.replace(/[\s().-]/g, ""));
  return match ? `+61${match[1]}` : null;
}

/** The recipient's possible local time zones: by area code, or `mobileZone` for a mobile. */
export function zonesFor(e164, mobileZone) {
  return e164[3] === "4" ? [mobileZone] : LANDLINE_ZONES[e164[3]];
}

const formatters = new Map();
function localClock(date, zone) {
  if (!formatters.has(zone)) {
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-AU", {
        timeZone: zone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
        numberingSystem: "latn",
      })
    );
  }
  const parts = Object.fromEntries(formatters.get(zone).formatToParts(date).map((p) => [p.type, p.value]));
  const [year, month, day, hour, minute] = ["year", "month", "day", "hour", "minute"].map((k) => Number(parts[k]));
  const pad = (n) => String(n).padStart(2, "0");
  return {
    valid: [year, month, day, hour, minute].every(Number.isInteger),
    year,
    ymd: `${year}-${pad(month)}-${pad(day)}`,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(), // from the date, not locale text
    minutes: hour * 60 + minute,
    hhmm: `${pad(hour)}:${pad(minute)}`,
  };
}

/** May we place a telemarketing call at `date`, in every one of the recipient's possible `zones`? */
export function callingWindow(date, { zones, consented = false }) {
  if (consented) return { allowed: true, reason: "express consent: they asked to be called at this time" };
  if (!zones?.length) throw new Error("callingWindow needs the recipient's time zones");
  for (const zone of zones) {
    const clock = localClock(date, zone);
    const place = zone.split("/").pop().replace(/_/g, " ");
    if (!clock.valid) return { allowed: false, reason: `couldn't read the clock for ${zone}` };
    const holidays = NATIONAL_PUBLIC_HOLIDAYS[clock.year];
    if (!holidays) {
      return { allowed: false, reason: `the public holiday table has no ${clock.year} dates (extend NATIONAL_PUBLIC_HOLIDAYS in dial.mjs)` };
    }
    if (holidays.includes(clock.ymd)) return { allowed: false, reason: `${clock.ymd} is a public holiday in ${place}` };
    const hours = HOURS[clock.weekday];
    if (!hours) return { allowed: false, reason: `it's Sunday in ${place}` };
    if (!(clock.minutes >= hours[0] && clock.minutes < hours[1])) {
      const span = clock.weekday === 6 ? "Saturday 9am-5pm" : "weekday 9am-8pm";
      return { allowed: false, reason: `it's ${clock.hhmm} in ${place}, outside ${span}` };
    }
  }
  return { allowed: true, reason: "inside permitted calling hours" };
}

/** A fresh two-digit code for each call. */
export function newCode() {
  return String(randomInt(10, 100));
}

/** TwiML for your leg while you're asked for the code. It never dials anyone. */
export function buildHoldTwiml(code) {
  if (!/^\d{2,4}$/.test(code)) throw new Error(`bad confirmation code: ${code}`);
  const spoken = code.split("").join(" ");
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Say ${VOICE} loop="4">To connect, type ${spoken} in your terminal.</Say>` +
    '<Pause length="60"/>' +
    `<Say ${VOICE}>Not connected. Goodbye.</Say><Hangup/></Response>`
  );
}

/** TwiML that bridges your leg to the prospect, showing the business caller ID. */
export function buildBridgeTwiml(prospect, callerId) {
  for (const n of [prospect, callerId]) {
    if (!/^\+61\d{9}$/.test(n)) throw new Error(`not an E.164 Australian number: ${n}`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Say ${VOICE}>Connecting you now.</Say>` +
    `<Dial callerId="${callerId}" timeout="30"><Number>${prospect}</Number></Dial>` +
    "</Response>"
  );
}

/** Every number on a do-not-call list: one per line, notes after #. Throws on a line it can't read. */
export function parseDoNotCallList(text) {
  const numbers = new Set();
  text
    .replace(/^﻿/, "")
    .split(/\r\n|\r|\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) return;
      const number = normalizeAuNumber(line);
      if (!number) throw new Error(`line ${i + 1} isn't exactly one phone number: "${raw.trim()}" (put notes after a #)`);
      numbers.add(number);
    });
  return numbers;
}

function pretty(e164) {
  const n = e164.slice(3);
  return n.startsWith("4") ? `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : `(0${n[0]}) ${n.slice(1, 5)} ${n.slice(5)}`;
}

/** The canonical Australian zone for `zone`, or null (UTC, Etc/GMT+8 and typos are all refused). */
function australianZone(zone) {
  try {
    const id = new Intl.DateTimeFormat("en-AU", { timeZone: zone }).resolvedOptions().timeZone;
    return id.startsWith("Australia/") ? id : null;
  } catch {
    return null; // not a zone Intl knows
  }
}

function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function describe(err) {
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
}

/** Twilio rejected the request (4xx), so it had no effect. A 5xx or a network failure may have landed. */
class TwilioRefused extends Error {}

function twilioCalls(accountSid, authToken, fetchImpl) {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls`;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  async function request(path, params) {
    const res = await fetchImpl(`${base}${path}`, {
      method: params ? "POST" : "GET",
      headers: params ? { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" } : { Authorization: authorization },
      body: params ? new URLSearchParams(params) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON (e.g. a gateway error page); the raw text is reported below
    }
    if (!res.ok) {
      const detail = body?.message ? `${body.message}${body.code ? ` [code ${body.code}]` : ""}` : text.trim().slice(0, 200) || "no details";
      const message = `HTTP ${res.status}: ${detail}`;
      // A gateway error (5xx) can follow a change that did land, so only a 4xx is a definite no.
      throw res.status < 500 ? new TwilioRefused(message) : new Error(message);
    }
    return body ?? {};
  }
  return {
    create: (params) => request(".json", params),
    get: (callSid) => request(`/${callSid}.json`),
    update: (callSid, params) => request(`/${callSid}.json`, params),
  };
}

async function askOnTerminal(question, timeoutMs) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        process.stdout.write("\n(timed out)\n");
        resolve(null);
      }, timeoutMs);
      rl.on("SIGINT", () => {
        clearTimeout(timer);
        process.stdout.write("\n");
        resolve(null);
      });
      rl.question(question, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  } finally {
    rl.close();
  }
}

const defaultDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  code: newCode,
  interactive: () => Boolean(process.stdin.isTTY),
  ask: askOnTerminal,
  readDoNotCall: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  appendLog: (path, row) => {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) appendFileSync(path, LOG_HEADER);
    appendFileSync(path, `${row}\n`);
  },
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};

function parseArgs(args) {
  const flags = new Map();
  const words = [];
  for (const arg of args) {
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);
    const kind = Object.hasOwn(FLAGS, name) ? FLAGS[name] : undefined;
    if (!kind || (kind === "switch" && value !== null)) return { problem: `Unknown option ${arg}` };
    if (kind === "value" && !value?.trim()) {
      return {
        problem:
          name === "tz"
            ? "--tz needs a zone, e.g. --tz=Australia/Perth"
            : 'Say what they agreed to, for your records: --consented="asked 3/10 to ring Sat 7:30am"',
      };
    }
    flags.set(name, value?.trim() ?? true);
  }
  return { flags, target: words.join(" ") };
}

export async function main(argv, env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { log, error } = deps;

  const { flags, target, problem } = parseArgs(argv.slice(2));
  if (problem) {
    error(`${problem}\n${USAGE}`);
    return 1;
  }
  if (flags.has("help")) {
    log(USAGE);
    return 0;
  }
  if (!target) {
    error(USAGE);
    return 1;
  }
  const prospect = normalizeAuNumber(target);
  if (!prospect) {
    error(`Not an Australian mobile or landline: "${target}"`);
    return 1;
  }
  const tz = flags.has("tz") ? australianZone(flags.get("tz")) : null;
  if (flags.has("tz") && !tz) {
    error(`--tz must be an Australian time zone like Australia/Perth, Australia/Brisbane or Australia/Adelaide (got "${flags.get("tz")}").`);
    return 1;
  }
  const consent = flags.get("consented") ?? "";

  const dncPath = env.DIAL_DNC_FILE || join(DATA_DIR, "do-not-call.txt");
  const logPath = env.DIAL_CALL_LOG || join(DATA_DIR, "calls.csv");
  let doNotCall;
  try {
    const text = deps.readDoNotCall(dncPath);
    if (text == null) {
      error(
        `No do-not-call list at ${dncPath}.\n` +
          "If you already keep one somewhere else, set DIAL_DNC_FILE to it in scripts/outreach/.env.\n" +
          `If nobody has asked you to stop yet, create it empty:\n  mkdir -p "${dirname(dncPath)}" && touch "${dncPath}"`
      );
      return 1;
    }
    doNotCall = parseDoNotCallList(text);
  } catch (err) {
    error(`Can't use the do-not-call list ${dncPath}: ${err.message}`);
    return 1;
  }
  if (doNotCall.has(prospect)) {
    error(`${pretty(prospect)} is on the do-not-call list, so not calling.`);
    return 1;
  }

  const zones = [...new Set([...zonesFor(prospect, tz ?? SYDNEY), ...(tz ? [tz] : [])])];
  const inHours = () => callingWindow(deps.now(), { zones, consented: Boolean(consent) });
  const window = inHours();
  if (!window.allowed) {
    error(`Not calling now: ${window.reason}.\n${HOURS_HELP}`);
    return 1;
  }

  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken } = env;
  if (!accountSid || !authToken) {
    error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are missing: run with --env-file=.env.local");
    return 1;
  }
  const callerId = normalizeAuNumber(env.DIAL_CALLER_ID || DEFAULT_CALLER_ID);
  if (!callerId) {
    error(`DIAL_CALLER_ID is not an Australian number: "${env.DIAL_CALLER_ID}"`);
    return 1;
  }
  const myMobile = normalizeAuNumber(env.DIAL_MY_MOBILE ?? "");
  if (!myMobile?.startsWith("+614") || [PLACEHOLDER_MOBILE, callerId, prospect].includes(myMobile)) {
    error(
      "Set DIAL_MY_MOBILE in scripts/outreach/.env to your own mobile (04…), not a placeholder, the caller ID or the number you're calling."
    );
    return 1;
  }

  const where =
    prospect[3] === "4"
      ? tz
        ? `${tz} (from --tz)`
        : `${SYDNEY} (assumed for a mobile; add --tz=Australia/Perth etc. if they're elsewhere)`
      : `${zones.join(", ")} (from the 0${prospect[3]} area code${tz ? " and --tz" : ""})`;
  log(`Plan: Twilio rings your mobile ${pretty(myMobile)} and reads you a code. Type it here and it rings ${pretty(prospect)}, who sees ${pretty(callerId)}.`);
  log(`Their local time: ${where}. ${consent ? `Consent noted: "${consent}".` : "Calling hours are open."}`);
  log(`Do-not-call list: ${doNotCall.size} number${doNotCall.size === 1 ? "" : "s"} checked (${dncPath}).`);
  if (!flags.has("call")) {
    log("Preview only: nothing was dialed. Add --call to place it.");
    return 0;
  }
  if (!deps.interactive()) {
    error("--call needs an interactive terminal to type the code into, so nothing was dialed.");
    return 1;
  }

  const calls = twilioCalls(accountSid, authToken, deps.fetch);
  const code = deps.code();
  const hangUp = async (callSid) => {
    try {
      await calls.update(callSid, { Status: "completed" });
    } catch (err) {
      error(`(Couldn't hang up your phone's leg: ${describe(err)}. It ends by itself within a minute.)`);
    }
  };

  let call;
  try {
    call = await calls.create({
      To: myMobile,
      From: callerId,
      Twiml: buildHoldTwiml(code),
      Timeout: String(RING_SECONDS),
      MachineDetection: "Enable",
      MachineDetectionTimeout: "10",
    });
  } catch (err) {
    error(
      err instanceof TwilioRefused
        ? `Twilio rejected the call (${err.message}). Nobody was called.`
        : `Couldn't reach Twilio (${describe(err)}). If your phone rings anyway, hang up: ${pretty(prospect)} is only called after you type the code.`
    );
    return 1;
  }
  if (!/^CA[0-9a-f]{32}$/.test(call.sid ?? "")) {
    error(`Twilio replied without a call SID. If your phone rings anyway, hang up: ${pretty(prospect)} is only called after you type the code.`);
    return 1;
  }

  try {
    log("Ringing your mobile now. Answer it and say hello; after a moment you'll hear a two-digit code.");
    let status = "timeout";
    for (let i = 0; i < MAX_RING_POLLS; i++) {
      ({ status } = await calls.get(call.sid));
      if (status === "in-progress" || FINISHED.has(status)) break;
      status = "timeout";
      await deps.sleep(POLL_MS);
    }
    if (status !== "in-progress") {
      if (status === "timeout") await hangUp(call.sid);
      error(`Your phone wasn't answered (${status}). ${pretty(prospect)} was not called.`);
      return 1;
    }
    const typed = await deps.ask(
      `Type the code you heard on the call (never one read off a voicemail or call-screening screen) to ring ${pretty(prospect)}, or press Enter to cancel: `,
      ASK_TIMEOUT_MS
    );
    if ((typed ?? "").replace(/\D/g, "") !== code) {
      await hangUp(call.sid);
      error(`${typed?.trim() ? "Wrong code" : "No code"}, so hung up. ${pretty(prospect)} was not called.`);
      return 1;
    }
    const recheck = inHours();
    if (!recheck.allowed) {
      await hangUp(call.sid);
      error(`Not connecting: ${recheck.reason}. ${pretty(prospect)} was not called.`);
      return 1;
    }
    // Answering-machine detection settles before the hold message plays, so it's in by
    // now. Voicemail and call screeners (iOS Live Voicemail, Pixel Call Screen) open
    // with a long greeting, which reads as machine_*. A person who stays silent reads
    // as "unknown"; they still had to hear the code to type it.
    const { answered_by: answeredBy } = await calls.get(call.sid);
    if (/^(machine|fax)/.test(answeredBy ?? "")) {
      await hangUp(call.sid);
      error(`Twilio detected ${answeredBy === "fax" ? "a fax machine" : "voicemail or a call screener"} on your phone, not you, so hung up. ${pretty(prospect)} was not called.`);
      return 1;
    }
  } catch (err) {
    await hangUp(call.sid);
    error(`Lost track of the call (${describe(err)}), so hung up. ${pretty(prospect)} was not called.`);
    return 1;
  }

  let outcome = "connected";
  try {
    await calls.update(call.sid, { Twiml: buildBridgeTwiml(prospect, callerId) });
  } catch (err) {
    if (err instanceof TwilioRefused) {
      await hangUp(call.sid);
      error(`Twilio wouldn't connect them (${err.message}). ${pretty(prospect)} was not called.`);
      return 1;
    }
    outcome = "unconfirmed";
    error(
      `Couldn't confirm the connection (${describe(err)}): ${pretty(prospect)} may be ringing now. Stay on the line and say who you are. ` +
        "Don't re-run until you've checked the call in the Twilio console."
    );
  }

  const row = [deps.now().toISOString(), prospect, call.sid, outcome, zones.join(" "), csvField(consent)].join(",");
  try {
    deps.appendLog(logPath, row);
  } catch (err) {
    error(`${logPath} couldn't be written (${err.message}). Add this row by hand:\n${row}\nDon't re-run: that would call them again.`);
  }
  if (outcome === "connected") {
    log(`Connecting you to ${pretty(prospect)}. Say who you are and why you're calling.`);
  }
  log(`If they ask you to stop, add their number to ${dncPath}.`);
  return outcome === "connected" ? 0 : 1;
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false; // argv[1] isn't a file (e.g. a REPL): we were imported, not run
  }
}

if (invokedDirectly()) {
  main(process.argv, process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Dialer failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  );
}
