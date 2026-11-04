#!/usr/bin/env node
/**
 * Text tradies from Phondo's outreach mobile, 0485 094 768, instead of your own.
 * Their replies are forwarded to your mobile, and a call to that number rings
 * Phondo's line (the Twilio Studio flow from ~/.phondo-outreach/setup-texting-number.mjs).
 *
 *   node --env-file=.env.local scripts/outreach/text.mjs          # preview: who gets a text today, and the words
 *   ...  scripts/outreach/text.mjs --send                          # send today's batch texts
 *   ...  scripts/outreach/text.mjs --to="0491 570 006" --text="…"  # preview one text, e.g. answering a reply
 *   ...  scripts/outreach/text.mjs --to="0491 570 006" --text="…" --send
 *
 * The batch (~/.phondo-outreach/texts.json) is a JSON array of
 * { "to", "business", "text" }, sent in order, at most --max (default 5) first
 * texts a day.
 *
 * Guards:
 *   - Spam Act 2003: every text names Phondo (s 17) and says to reply STOP to
 *     opt out (s 18). Nobody on the do-not-call list is texted, and nobody whose
 *     reply asks us to stop.
 *   - A batch text only goes to someone this number has never texted and who has
 *     never texted it, so a re-run never doubles up. Answer a reply with --to.
 *   - Only in the dialer's calling hours, Sydney time. The Spam Act sets no hours,
 *     but a text at 9pm reads as spam.
 *   - It never spends the Twilio balance below US$5: an empty balance takes
 *     Phondo's phone lines down too.
 * The batch, the do-not-call list (shared with dial.mjs) and the text log live in
 * ~/.phondo-outreach/ (override with TEXT_BATCH, DIAL_DNC_FILE and TEXT_LOG).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callingWindow, csvField, describe, normalizeAuNumber, parseDoNotCallList, pretty } from "./dial.mjs";

const SYDNEY = "Australia/Sydney";
const DEFAULT_FROM = "+61485094768"; // Phondo's outreach mobile, bought 2026-11-04
const DEFAULT_DAILY_MAX = 5; // more first texts a day reads as spam, to carriers and to people
const MAX_DAILY_MAX = 20;
const MAX_SEGMENTS = 4;
const USD_PER_SEGMENT = 0.0515; // Twilio's price per segment to an Australian mobile, Nov 2026
const MIN_BALANCE_USD = 5;
const GAP_MS = 20_000; // between batch texts, so they don't leave as a burst
const STATUS_WAIT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_PAGES = 5; // of 1,000 texts each
const SHOWN_HISTORY = 6;
const LOG_HEADER = "sent_at,to,business,kind,message_sid,segments\n";
const FAILED = new Set(["failed", "undelivered"]);

// GSM 03.38: a basic character costs one septet and an extension-table one two.
// Anything else (an emoji, a curly quote) switches the whole text to UCS-2, which
// fits under half as many characters in a segment.
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);
const GSM7_EXTENDED = new Set("^{}\\[~]|€\f");

// Word processors' punctuation, which would otherwise force UCS-2.
const TYPOGRAPHY = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, "-"],
  [/…/g, "..."],
  [/[   ]/g, " "],
];

// Twilio's opt-out keywords as a whole reply, plus plain-English ways of saying
// it. Errs towards "stop"; the preview shows their words either way.
const OPT_OUT_REPLIES = new Set([
  "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "revoke",
  "no", "nope", "remove", "remove me", "stop please", "please stop",
]);
const OPT_OUT_PHRASES =
  /\b(stop (texting|messaging|msging|contacting|sending|calling)|unsubscribe|opt ?out|remove me|take me off|(dont|do not|never) (text|message|msg|contact|call)|not interested|no thanks|no thank you|leave me alone|wrong number)\b/;

const USAGE = `Usage: node --env-file=.env.local scripts/outreach/text.mjs [options]
  (no options)            preview the batch: who gets a text today, who's skipped and why, and the words
  --send                  send the texts marked SEND NOW
  --max=N                 first texts a day (default ${DEFAULT_DAILY_MAX}, at most ${MAX_DAILY_MAX})
  --to="04…" --text="…"   one text to one person, e.g. answering a reply (add --send to send it)`;
const FLAGS = { send: "switch", help: "switch", max: "value", to: "value", text: "value" };

/** The SMS encoding a text needs and how many segments it's billed as. */
export function smsSegments(text) {
  const chars = [...text];
  if (chars.every((c) => GSM7_BASIC.has(c) || GSM7_EXTENDED.has(c))) {
    return { encoding: "GSM-7", segments: countSegments(chars.map((c) => (GSM7_EXTENDED.has(c) ? 2 : 1)), 160, 153) };
  }
  return { encoding: "UCS-2", segments: countSegments(chars.map((c) => c.length), 70, 67) };
}

// A long text goes out in parts of `multi` units each, and no character straddles two parts.
function countSegments(sizes, single, multi) {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= single) return total ? 1 : 0;
  let segments = 1;
  let used = 0;
  for (const size of sizes) {
    if (used + size > multi) {
      segments++;
      used = 0;
    }
    used += size;
  }
  return segments;
}

/** `text` with typographic quotes, dashes and spaces made plain, so it stays in GSM-7. */
export function normalizeText(text) {
  return TYPOGRAPHY.reduce((out, [pattern, plain]) => out.replace(pattern, plain), text).trim();
}

/** Why `text` can't go out as an outreach text, or null if it can. */
export function messageProblem(text) {
  if (!text) return "it's empty";
  if (!/Phondo/.test(text)) return 'it has to say who it\'s from: put "Phondo" in it (Spam Act s 17)';
  if (!/\bSTOP\b/.test(text)) return 'it has to say how to opt out: put "Reply STOP" in it (Spam Act s 18)';
  const { segments } = smsSegments(text);
  if (segments > MAX_SEGMENTS) return `it's ${segments} SMS segments long; keep it to ${MAX_SEGMENTS} or fewer`;
  return null;
}

/** Does this reply ask us to stop texting? */
export function isOptOut(body) {
  const plain = String(body ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
  return OPT_OUT_REPLIES.has(plain) || OPT_OUT_PHRASES.test(plain);
}

/** The batch's rows, checked and made plain. Throws on the first row that can't be sent. */
export function parseBatch(json) {
  let rows;
  try {
    rows = JSON.parse(json);
  } catch (err) {
    throw new Error(`it isn't valid JSON (${err.message})`);
  }
  if (!Array.isArray(rows)) throw new Error('it has to be a JSON array of { "to", "business", "text" }');
  const seen = new Set();
  return rows.map((row, i) => {
    const to = normalizeAuNumber(String(row?.to ?? ""));
    if (!to?.startsWith("+614")) throw new Error(`row ${i + 1}: "${row?.to ?? ""}" isn't an Australian mobile (landlines can't get texts)`);
    if (seen.has(to)) throw new Error(`row ${i + 1}: ${pretty(to)} is in the batch twice`);
    seen.add(to);
    if (typeof row.business !== "string" || !row.business.trim()) throw new Error(`row ${i + 1}: "business" is missing`);
    const business = row.business.trim();
    if (typeof row.text !== "string") throw new Error(`row ${i + 1} (${business}): "text" is missing`);
    const text = normalizeText(row.text);
    const problem = messageProblem(text);
    if (problem) throw new Error(`row ${i + 1} (${business}): ${problem}`);
    return { to, business, text };
  });
}

/** Twilio's texts grouped by the other person's number: what we sent them and what they sent us, oldest first. */
export function byContact(messages) {
  const contacts = new Map();
  const oldestFirst = [...messages].sort((a, b) => Date.parse(a.date_created) - Date.parse(b.date_created));
  for (const m of oldestFirst) {
    const inbound = m.direction === "inbound";
    const other = normalizeAuNumber(String((inbound ? m.from : m.to) ?? ""));
    if (!other) continue; // not an Australian number, so never one we text
    if (!contacts.has(other)) contacts.set(other, { sent: [], received: [] });
    contacts.get(other)[inbound ? "received" : "sent"].push({
      at: new Date(m.date_created),
      body: m.body ?? "",
      status: m.status ?? "",
      errorCode: m.error_code ?? null,
    });
  }
  return contacts;
}

const sydneyDay = new Intl.DateTimeFormat("en-AU", { timeZone: SYDNEY, year: "numeric", month: "2-digit", day: "2-digit" });
/** The calendar day in Sydney, as YYYY-MM-DD. */
export function sydneyDate(date) {
  const parts = Object.fromEntries(sydneyDay.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const NO_HISTORY = { sent: [], received: [] };

/**
 * What happens to each row: "send" now, "later" (over today's limit), or "skip"
 * with the reason. A batch text needs a clean slate with them; a single text
 * (`single`) only needs them not to have opted out.
 */
export function planTexts(rows, { doNotCall, contacts, single, dailyMax, today }) {
  const firstTextedOn = (to) => {
    const first = (contacts.get(to) ?? NO_HISTORY).sent[0];
    return first ? sydneyDate(first.at) : null;
  };
  let slots = single ? 1 : dailyMax - rows.filter((row) => firstTextedOn(row.to) === today).length;
  return rows.map((row) => {
    const history = contacts.get(row.to) ?? NO_HISTORY;
    const optOut = history.received.find((m) => isOptOut(m.body));
    const lastReply = history.received.at(-1);
    const lastSent = history.sent.at(-1);
    let action = "skip";
    let reason;
    if (doNotCall.has(row.to)) reason = "on the do-not-call list";
    else if (optOut) reason = `asked to stop on ${sydneyDate(optOut.at)}: "${clip(optOut.body)}". Add them to the do-not-call list`;
    else if (!single && lastReply) reason = `replied on ${sydneyDate(lastReply.at)}: "${clip(lastReply.body)}". Answer with --to`;
    else if (!single && lastSent) {
      reason = `already texted on ${sydneyDate(history.sent[0].at)} (last one ${lastSent.status}${lastSent.errorCode ? `, error ${lastSent.errorCode}` : ""})`;
    } else if (slots > 0) {
      action = "send";
      slots--;
    } else {
      action = "later";
      reason = `today's limit of ${dailyMax} first texts is reached`;
    }
    return { ...row, ...smsSegments(row.text), action, reason, history };
  });
}

function clip(body, max = 80) {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function who(row) {
  return row.business ? `${row.business}, ${pretty(row.to)}` : pretty(row.to);
}

/** Twilio rejected the request (4xx), so it had no effect. A 5xx or a network failure may have landed. */
class TwilioRefused extends Error {}

function twilioApi(accountSid, authToken, fetchImpl) {
  const origin = "https://api.twilio.com";
  const base = `${origin}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  async function request(url, params) {
    const res = await fetchImpl(url, {
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
    // Twilio's next-page links are paths on its own origin.
    get: (path) => request(path.startsWith("/2010-04-01/") ? `${origin}${path}` : `${base}${path}`),
    post: (path, params) => request(`${base}${path}`, params),
  };
}

/** Every text on the account from or to `number`. */
async function textsOf(api, number) {
  const messages = [];
  for (const side of ["From", "To"]) {
    let path = `/Messages.json?${side}=${encodeURIComponent(number)}&PageSize=1000`;
    for (let page = 1; path; page++) {
      if (page > HISTORY_PAGES) throw new Error(`more than ${HISTORY_PAGES * 1000} texts ${side.toLowerCase()} ${pretty(number)}, which this script doesn't page through`);
      const body = await api.get(path);
      // Without the list, a re-run could text someone twice, so a malformed reply stops here.
      if (!Array.isArray(body.messages)) throw new Error("Twilio's message list came back without messages");
      messages.push(...body.messages);
      path = body.next_page_uri || null;
    }
  }
  return messages;
}

const defaultDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
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
  for (const arg of args) {
    if (!arg.startsWith("--")) return { problem: `Unexpected "${arg}": put the number in --to="…" and the words in --text="…"` };
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);
    const kind = Object.hasOwn(FLAGS, name) ? FLAGS[name] : undefined;
    if (!kind || (kind === "switch" && value !== null)) return { problem: `Unknown option ${arg}` };
    if (kind === "value" && !value?.trim()) return { problem: `--${name} needs a value, e.g. --${name}=${name === "max" ? "5" : '"…"'}` };
    flags.set(name, value ?? true);
  }
  return { flags };
}

export async function main(argv, env, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { log, error } = deps;

  const { flags, problem } = parseArgs(argv.slice(2));
  if (problem) {
    error(`${problem}\n${USAGE}`);
    return 1;
  }
  if (flags.has("help")) {
    log(USAGE);
    return 0;
  }
  const single = flags.has("to") || flags.has("text");
  if (single && !(flags.has("to") && flags.has("text"))) {
    error(`--to and --text go together.\n${USAGE}`);
    return 1;
  }
  if (single && flags.has("max")) {
    error("--max is for the batch; --to sends one text.");
    return 1;
  }
  const dailyMax = flags.has("max") ? Number(flags.get("max")) : DEFAULT_DAILY_MAX;
  if (!Number.isInteger(dailyMax) || dailyMax < 1 || dailyMax > MAX_DAILY_MAX) {
    error(`--max must be a whole number from 1 to ${MAX_DAILY_MAX}.`);
    return 1;
  }
  const from = normalizeAuNumber(env.TEXT_FROM || DEFAULT_FROM);
  if (!from?.startsWith("+614")) {
    error(`TEXT_FROM has to be the Twilio mobile texts go from (04…), not "${env.TEXT_FROM}".`);
    return 1;
  }

  const dataDir = join(env.HOME || homedir(), ".phondo-outreach"); // outside any checkout
  const dncPath = env.DIAL_DNC_FILE || join(dataDir, "do-not-call.txt");
  const batchPath = env.TEXT_BATCH || join(dataDir, "texts.json");
  const logPath = env.TEXT_LOG || join(dataDir, "texts.csv");
  let doNotCall;
  try {
    const text = deps.readFile(dncPath);
    if (text == null) {
      error(
        `No do-not-call list at ${dncPath}.\n` +
          "If you keep it somewhere else, set DIAL_DNC_FILE to it.\n" +
          `If nobody has asked you to stop yet, create it empty:\n  mkdir -p "${dirname(dncPath)}" && touch "${dncPath}"`
      );
      return 1;
    }
    doNotCall = parseDoNotCallList(text);
  } catch (err) {
    error(`Can't use the do-not-call list ${dncPath}: ${err.message}`);
    return 1;
  }

  let rows;
  if (single) {
    const to = normalizeAuNumber(flags.get("to"));
    if (!to?.startsWith("+614")) {
      error(`Not an Australian mobile: "${flags.get("to")}" (landlines can't get texts).`);
      return 1;
    }
    const text = normalizeText(flags.get("text"));
    const why = messageProblem(text);
    if (why) {
      error(`Not sending that: ${why}.`);
      return 1;
    }
    rows = [{ to, business: "", text }];
  } else {
    try {
      const json = deps.readFile(batchPath);
      if (json == null) {
        error(`No batch at ${batchPath}. Put the texts there as a JSON array of { "to", "business", "text" } (see scripts/outreach/README.md).`);
        return 1;
      }
      rows = parseBatch(json);
    } catch (err) {
      error(`Can't use the batch ${batchPath}: ${err.message}`);
      return 1;
    }
    if (!rows.length) {
      error(`The batch ${batchPath} is empty.`);
      return 1;
    }
  }

  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken } = env;
  if (!accountSid || !authToken) {
    error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are missing: run with --env-file=.env.local");
    return 1;
  }
  const api = twilioApi(accountSid, authToken, deps.fetch);
  let contacts;
  let balance;
  try {
    contacts = byContact(await textsOf(api, from));
    balance = await api.get("/Balance.json");
  } catch (err) {
    error(`Couldn't read the texting history or balance from Twilio (${describe(err)}). Nothing was sent.`);
    return 1;
  }

  const plan = planTexts(rows, { doNotCall, contacts, single, dailyMax, today: sydneyDate(deps.now()) });
  const toSend = plan.filter((row) => row.action === "send");
  const segments = toSend.reduce((sum, row) => sum + row.segments, 0);
  const cost = segments * USD_PER_SEGMENT;

  if (single) {
    const [row] = plan;
    const convo = [...row.history.sent.map((m) => ({ ...m, by: "you " })), ...row.history.received.map((m) => ({ ...m, by: "them" }))]
      .sort((a, b) => a.at - b.at)
      .slice(-SHOWN_HISTORY);
    log(convo.length ? `Your latest texts with ${pretty(row.to)}:` : `No texts with ${pretty(row.to)} yet.`);
    for (const m of convo) log(`  ${sydneyDate(m.at)} ${m.by}: ${clip(m.body, 120)}`);
    if (row.action !== "send") {
      error(`Not texting ${pretty(row.to)}: ${row.reason}.`);
      return 1;
    }
  } else {
    log(`Batch ${batchPath}: ${rows.length} texts. Up to ${dailyMax} first texts a day.`);
    log(`Do-not-call list: ${doNotCall.size} number${doNotCall.size === 1 ? "" : "s"} checked (${dncPath}).`);
  }
  log("");
  plan.forEach((row, i) => {
    const label = row.action === "send" ? "SEND NOW" : `${row.action === "later" ? "LATER" : "SKIP"}: ${row.reason}`;
    const size = `${row.segments} segment${row.segments === 1 ? "" : "s"}${row.encoding === "UCS-2" ? " (UCS-2: emoji or special characters)" : ""}`;
    log(`${String(i + 1).padStart(2)}. ${single ? pretty(row.to) : who(row)} · ${size} · ${label}`);
    for (const line of row.text.split("\n")) log(`    ${line}`);
  });
  log("");
  if (!toSend.length) {
    log("Nothing to send now.");
    return 0;
  }

  const blockers = [];
  const hours = () => callingWindow(deps.now(), { zones: [SYDNEY] });
  const window = hours();
  if (!window.allowed) blockers.push(`${window.reason}; texts go out in the dialer's calling hours, Sydney time`);
  const funds = Number(balance.balance);
  const readable = balance.currency === "USD" && Number.isFinite(funds);
  if (!readable) {
    blockers.push(`couldn't read the Twilio balance ("${balance.balance} ${balance.currency}")`);
  } else if (funds - cost < MIN_BALANCE_USD) {
    blockers.push(
      `top up Twilio first: the balance is US$${funds.toFixed(2)}, and these texts would leave less than the US$${MIN_BALANCE_USD} that keeps Phondo's phone lines answering`
    );
  }
  const plural = toSend.length === 1 ? "" : "s";
  log(
    `From ${pretty(from)}: ${toSend.length} text${plural}, ${segments} segments, ≈US$${cost.toFixed(2)}. ` +
      `Twilio balance: ${readable ? `US$${funds.toFixed(2)}` : "unknown"}.`
  );

  if (!flags.has("send")) {
    for (const blocker of blockers) error(`Can't send yet: ${blocker}.`);
    log(`Preview only: nothing was sent. Add --send to send the ${toSend.length} marked SEND NOW.`);
    return 0;
  }
  if (blockers.length) {
    for (const blocker of blockers) error(`Not sending: ${blocker}.`);
    return 1;
  }

  const kind = single ? "single" : "batch";
  const rerun = single ? "Check the Twilio console before sending it again." : "Re-running is safe: it skips anyone already texted.";
  const sent = [];
  let refused = 0;
  let refusedInARow = 0;
  let stopped = false;
  for (const [i, row] of toSend.entries()) {
    if (i > 0) await deps.sleep(GAP_MS);
    const recheck = hours();
    if (!recheck.allowed) {
      error(`Stopped: ${recheck.reason}. The rest go next time.`);
      stopped = true;
      break;
    }
    let message;
    try {
      message = await api.post("/Messages.json", { From: from, To: row.to, Body: row.text });
    } catch (err) {
      if (!(err instanceof TwilioRefused)) {
        error(`Couldn't confirm the text to ${who(row)} (${describe(err)}): it may have gone. Stopped. ${rerun}`);
        stopped = true;
        break;
      }
      // A refusal costs nothing and sends nothing. One bad number shouldn't hold up
      // the rest of the batch, but two in a row points at the account, not the number.
      refused++;
      error(`Twilio refused the text to ${who(row)} (${err.message}), so it didn't go.`);
      if (++refusedInARow === 2) {
        error("Twilio refused two texts in a row, so stopping.");
        stopped = true;
        break;
      }
      continue;
    }
    refusedInARow = 0;
    if (!/^(SM|MM)[0-9a-f]{32}$/.test(message.sid ?? "")) {
      error(`Twilio replied without a message ID for ${who(row)}: it may have gone. Stopped. ${rerun}`);
      stopped = true;
      break;
    }
    sent.push({ row, sid: message.sid });
    log(`Sent ${sent.length}: ${who(row)} (${message.sid}).`);
    const entry = [deps.now().toISOString(), row.to, csvField(row.business), kind, message.sid, row.segments].join(",");
    try {
      deps.appendLog(logPath, entry);
    } catch (err) {
      error(`${logPath} couldn't be written (${err.message}). Add this row by hand:\n${entry}`);
    }
  }

  // Delivery reports take a few seconds; a carrier's spam filter shows up here as "undelivered".
  let failures = 0;
  if (sent.length) {
    await deps.sleep(STATUS_WAIT_MS);
    for (const { row, sid } of sent) {
      try {
        const message = await api.get(`/Messages/${sid}.json`);
        if (FAILED.has(message.status)) failures++;
        const detail = message.error_code ? ` (error ${message.error_code}${message.error_message ? `: ${message.error_message}` : ""})` : "";
        log(`${who(row)}: ${message.status}${detail}.`);
      } catch (err) {
        error(`${who(row)}: couldn't read the delivery status (${describe(err)}). Check it in the Twilio console.`);
      }
    }
  }
  log(`Sent ${sent.length} of ${toSend.length}.`);
  const later = plan.filter((row) => row.action === "later").length;
  if (later) log(`${later} more in the batch: run it again tomorrow.`);
  log(`Replies are forwarded to your mobile. If anyone asks you to stop, add their number to ${dncPath}.`);
  return stopped || refused || failures ? 1 : 0;
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
      console.error(`Texting failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  );
}
