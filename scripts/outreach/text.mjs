#!/usr/bin/env node
/**
 * Text tradies from Phondo's outreach mobile, 0485 094 768, instead of your own.
 * Their replies are forwarded to your mobile, and a call to that number rings
 * Phondo's line (the Twilio Studio flow from ~/.phondo-outreach/setup-texting-number.mjs).
 *
 *   node --env-file=.env.local --env-file=scripts/outreach/.env \
 *     scripts/outreach/text.mjs                                    # preview: who gets a text today, and the words
 *   ...  scripts/outreach/text.mjs --send                          # send today's batch texts
 *   ...  scripts/outreach/text.mjs --to="0491 570 006" --text="…"  # preview one text, e.g. answering a reply
 *   ...  scripts/outreach/text.mjs --to="0491 570 006" --text="…" --send
 *
 * The batch (~/.phondo-outreach/texts.json) is a JSON array of
 * { "to", "business", "text", "source" }, sent in order. "source" is your
 * evidence of consent: where the business publishes the number.
 *
 * Guards:
 *   - Spam Act 2003: every text names Phondo (s 17) and says to reply STOP to
 *     opt out (s 18), and every first text records where the number was published
 *     (consent, s 16). Nobody on the do-not-call list is texted, and nobody whose
 *     reply asks us to stop; a STOP-style reply also puts them on the list.
 *   - A batch text only goes to someone this number has never texted and who has
 *     never texted it, so a re-run never doubles up. Answer a reply with --to.
 *   - At most --max (default 5) first texts a day, counted across everything this
 *     number has sent, and only in the dialer's calling hours, Sydney time. The
 *     Spam Act sets no hours, but a text at 9pm reads as spam.
 *   - It never spends the Twilio balance below US$5: an empty balance takes
 *     Phondo's phone lines down too.
 *   - One send at a time: --send holds a lock from reading the history to the last text.
 * The batch, the do-not-call list (shared with dial.mjs) and the text log live in
 * ~/.phondo-outreach/ (override with TEXT_BATCH, DIAL_DNC_FILE and TEXT_LOG).
 */
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const LOG_HEADER = "sent_at,to,business,kind,message_sid,segments,source,note\n";
const OPT_OUTS_HEADER = "recorded_at,number,reply_sid,replied_at,do_not_call_file,reply\n";
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

// How people say stop. A KEYWORD reply is final: they're never texted again and go
// on the do-not-call list. That's STOP, UNSUBSCRIBE, REMOVE and the like (with or
// without a "please"), "stop texting me", "take us off your list", "remove me",
// "stop" as the first or last word ("Who is this? STOP", "Can you please stop?"),
// or a short reply with "stop" in it. A PHRASE blocks texts too, but --not-opt-out
// can overrule it, on the record: "not interested", "wrong number", "get stuffed",
// any other "remove", "delete" or "take ... off", and any other "stop", including
// questions ("when does the trial stop?", "can you remove me from the trial if it's
// no good?") and "phones won't stop", which for this pitch is a buying signal.
// Both err towards stop: a false alarm costs one text, a miss breaks the Spam Act.
const KEYWORD_FIRST_WORDS = new Set(["stop", "stopall", "optout"]); // and anything starting "unsub"
const KEYWORD_REPLIES = new Set(["cancel", "end", "quit", "revoke", "remove", "delete", "opt out"]);
const COURTESIES = new Set(["please", "pls", "plz", "thanks", "thx", "ta", "mate", "now"]);
const WHO = "(me|us|my number|our number|this number|the number)";
const phrases = (list) => new RegExp(list.map((phrase) => `\\b(${phrase})\\b`).join("|"));
// Final even in a question: "can you take us off your list?" is still a request.
const KEYWORD_PHRASES = phrases([
  "(stop|quit) (texting|txting|messaging|msging|contacting|sending)",
  `(remove|delete|take) (${WHO} )?(off|from) (the |your |this |ur )?list`,
  "(lose|delete|remove) (my|our|this|the) number",
]);
// Final unless asked as a question: "remove me" is, "can you remove me from the trial?" isn't.
const KEYWORD_REQUESTS = phrases([`(remove|delete|unsubscribe) (me|us)`, `take ${WHO} off`, "opt (me|us) out"]);
const NEGATIONS = new Set(["non", "cant", "cannot", "dont", "wont", "never", "doesnt", "didnt", "wouldnt", "couldnt", "isnt", "not"]);
const PHRASE_REPLIES = new Set(["no", "nope", "nah", "nah mate", "no mate", "no more", "blocked", "reported"]);
const PHRASES = phrases([
  "unsub\\w*",
  "opt ?out",
  "remove|delete|take (\\w+ ){1,2}off",
  "(dont|do not|never) (call (or|and) )?(text|txt|sms|message|msg|contact)",
  "no more (texts|txts|messages|msgs)",
  "not interested|not keen",
  "no (thanks|thank you|thankyou|thx)|nah (thanks|thx|ta)",
  "leave me alone|wrong number|spam(ming)?|scam(mer)?|(ive|i have) (blocked|reported)",
  "(fuck|f|fk|fuk|fck|piss|rack|bugger|nick|sod|bog) off|get (lost|stuffed|fucked|rooted)|go away|jog on",
]);

const USAGE = `Usage: node --env-file=.env.local --env-file=scripts/outreach/.env scripts/outreach/text.mjs [options]
  (no options)            preview the batch: who gets a text today, who's skipped and why, and the words
  --send                  send the texts marked SEND NOW
  --max=N                 first texts a day (default ${DEFAULT_DAILY_MAX}, at most ${MAX_DAILY_MAX})
  --to="04…" --text="…"   one text to one person, e.g. answering a reply (add --send to send it)
  --source="…"            with --to, for someone this number has never texted: where they publish their number
  --not-opt-out="…" --seen=SM…
                          with --to, when their reply only looks like a stop ("can I unsubscribe any time?"):
                          what they meant, and the ID of their newest such reply, as the preview shows it`;
const FLAGS = { send: "switch", help: "switch", max: "value", to: "value", text: "value", source: "value", "not-opt-out": "value", seen: "value" };

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

/** Whether a reply asks us to stop: "keyword" (final), "phrase" (--not-opt-out can overrule it) or null. */
export function optOut(body) {
  const text = String(body ?? "");
  const plain = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (!plain) return null;
  const words = plain.split(" ");
  const core = words.filter((word) => !COURTESIES.has(word)).join(" "); // "Remove please" → "remove"
  const asked = /\?\W*$/.test(text);
  if (KEYWORD_FIRST_WORDS.has(words[0]) || words[0].startsWith("unsub") || KEYWORD_REPLIES.has(core) || KEYWORD_PHRASES.test(plain)) {
    return "keyword";
  }
  if (!asked && KEYWORD_REQUESTS.test(plain)) return "keyword";
  const stops = words.flatMap((word, i) => (word === "stop" ? [i] : []));
  const plainStop = (i) => !NEGATIONS.has(words[i - 1]); // not "can't stop" or "non stop"
  // "When does the free trial stop?" asks about something; "Can you please stop?" asks us to.
  const question = /\bstop\W*\?\W*$/i.test(text) && !/\b(you|u)( (please|pls|just))? stop\b/.test(plain);
  if (!question && stops.includes(words.length - 1) && plainStop(words.length - 1)) return "keyword"; // "Who is this? STOP"
  if (!question && words.length <= 3 && stops.some(plainStop)) return "keyword"; // "pls stop", "ok stop it"
  if (stops.length || PHRASE_REPLIES.has(plain) || PHRASES.test(plain)) return "phrase";
  return null;
}

/** The batch's rows, checked and made plain. Throws on the first row that can't be sent. */
export function parseBatch(json) {
  let rows;
  try {
    rows = JSON.parse(json);
  } catch (err) {
    throw new Error(`it isn't valid JSON (${err.message})`);
  }
  if (!Array.isArray(rows)) throw new Error('it has to be a JSON array of { "to", "business", "text", "source" }');
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
    if (typeof row.source !== "string" || !row.source.trim()) {
      throw new Error(`row ${i + 1} (${business}): "source" is missing: say where the business publishes this number (your evidence of consent, Spam Act s 16)`);
    }
    return { to, business, text, source: row.source.trim() };
  });
}

/** Texts grouped by the other person's number: what we sent them and what they sent us, oldest first. */
export function byContact(messages) {
  const contacts = new Map();
  const oldestFirst = [...messages].sort((a, b) => Date.parse(a.date_created) - Date.parse(b.date_created));
  for (const m of oldestFirst) {
    const other = normalizeAuNumber(String((m.inbound ? m.from : m.to) ?? ""));
    if (!other) continue; // not an Australian number, so never one we text
    if (!contacts.has(other)) contacts.set(other, { sent: [], received: [] });
    contacts.get(other)[m.inbound ? "received" : "sent"].push({
      sid: m.sid ?? "",
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

// The Studio flow from setup-texting-number.mjs forwards each reply to your mobile with this prefix.
const FORWARDED = "Reply to your Phondo texts from";

/**
 * How many first texts went out on `today`: people texted for the first time that
 * day who hadn't texted first. It counts everyone this number has texted, so
 * editing the batch can't reset it. Your own mobile isn't counted: the setup test
 * has no STOP line (every text from this script does), and forwarded replies carry
 * the flow's prefix.
 */
export function firstTextsOn(contacts, today) {
  let count = 0;
  for (const { sent, received } of contacts.values()) {
    const [first] = sent;
    if (!first || sydneyDate(first.at) !== today || !/\bSTOP\b/.test(first.body)) continue;
    if (received[0]?.at < first.at || sent.some((m) => m.body.startsWith(FORWARDED))) continue;
    count++;
  }
  return count;
}

const NO_HISTORY = { sent: [], received: [] };

/**
 * What happens to each row: "send" now, "later" (over today's limit), or "skip"
 * with the reason. A batch text needs a clean slate with them. A single text
 * (`single`) only needs them not to have opted out, and only a first text to
 * someone uses up one of the day's sends. The PHRASE replies that block it are the
 * ones since your last text (a phrase you texted them after was settled then).
 * `overruled` is the ID of the newest one you've read and overruled: it lets the
 * text past those, and nothing that has arrived since.
 */
export function planTexts(rows, { doNotCall, contacts, single, dailyMax, today, overruled = null }) {
  let slots = dailyMax - firstTextsOn(contacts, today);
  return rows.map((row) => {
    const history = contacts.get(row.to) ?? NO_HISTORY;
    const lastReply = history.received.at(-1);
    const lastSent = history.sent.at(-1);
    const final = history.received.find((m) => optOut(m.body) === "keyword");
    const open = history.received.filter((m) => optOut(m.body) === "phrase" && !(lastSent?.at > m.at));
    const newest = open.at(-1);
    let action = "skip";
    let reason;
    if (final) reason = `asked to stop on ${sydneyDate(final.at)}: "${clip(final.body)}"`;
    else if (doNotCall.has(row.to)) reason = "on the do-not-call list";
    else if (newest && !(single && overruled && overruled === newest.sid)) {
      reason = `may have asked to stop: ${open.map((m) => `"${clip(m.body)}" (${sydneyDate(m.at)}, ${m.sid})`).join(", ")}`;
      if (single && overruled) reason += `. ${overruled} isn't their newest one: read them all, then use --seen=${newest.sid}`;
      else if (single) reason += `. If they didn't, add --not-opt-out="what they meant" --seen=${newest.sid}`;
    } else if (!single && lastReply) {
      reason = `replied on ${sydneyDate(lastReply.at)}: "${clip(lastReply.body)}". Answer with --to`;
    } else if (!single && lastSent) {
      reason = `already texted on ${sydneyDate(history.sent[0].at)} (last one ${lastSent.status}${lastSent.errorCode ? `, error ${lastSent.errorCode}` : ""})`;
    } else if (single && (history.sent.length || history.received.length)) {
      action = "send"; // a text in a conversation you're already having
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

// Their words, on one line, without terminal control codes or text-direction overrides.
function clip(body, max = 80) {
  // eslint-disable-next-line no-control-regex
  const flat = body.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A spreadsheet runs a cell that starts with = + - or @ as a formula; a leading ' keeps it text.
function sheetSafe(value) {
  return csvField(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
}

/** The cells of one line written with csvField: a cell with a comma or quote is quoted, and "" is a quote. */
export function csvCells(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"') {
      if (line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (c === '"' && !cell) {
      quoted = true;
    } else if (c === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell);
  return cells;
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

/**
 * Every text on the account from or to `number`. Which list a text came back in
 * says whether it's inbound. A text that can't be placed in time, or isn't ours,
 * stops the run: it could hide an opt-out or a text already sent.
 */
async function textsOf(api, number) {
  const messages = [];
  for (const side of ["From", "To"]) {
    let path = `/Messages.json?${side}=${encodeURIComponent(number)}&PageSize=1000`;
    for (let page = 1; path; page++) {
      if (page > HISTORY_PAGES) throw new Error(`more than ${HISTORY_PAGES * 1000} texts ${side.toLowerCase()} ${pretty(number)}, which this script doesn't page through`);
      const body = await api.get(path);
      if (!Array.isArray(body.messages)) throw new Error("Twilio's message list came back without messages");
      for (const m of body.messages) {
        if ((side === "From" ? m.from : m.to) !== number || !Number.isFinite(Date.parse(m.date_created))) {
          throw new Error(`Twilio listed a text this script can't account for (${m.sid ?? "no ID"})`);
        }
        messages.push({ ...m, inbound: side === "To" });
      }
      path = body.next_page_uri || null;
    }
  }
  return messages;
}

/**
 * Takes the send lock at `path`, so two sends can't text the same people at once,
 * and returns its release. A lock left by a send that was killed outright is never
 * taken over: two sends could both decide it was stale. Ctrl-C releases it cleanly.
 */
function takeLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const mine = `${path}.${process.pid}`;
  writeFileSync(mine, String(process.pid));
  try {
    linkSync(mine, path); // atomic: the lock appears with our process ID already in it
    return () => rmSync(path, { force: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const pid = Number(readFileSync(path, "utf8"));
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new Error(`another send is running (process ${pid})`);
    throw new Error(`a send that was killed left its lock behind. If no send is running, delete ${path} and try again`);
  } finally {
    rmSync(mine, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // it exists, it just isn't ours
  }
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
  appendDoNotCall: (path, line) => {
    const text = readFileSync(path, "utf8");
    appendFileSync(path, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
  },
  appendOptOut: (path, row) => {
    if (!existsSync(path)) appendFileSync(path, OPT_OUTS_HEADER);
    appendFileSync(path, `${row}\n`);
  },
  lock: takeLock,
  onInterrupt: (handler) => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, handler);
    return () => {
      for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, handler);
    };
  },
  exit: (code) => process.exit(code),
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
  for (const name of ["source", "not-opt-out", "seen"]) {
    if (flags.has(name) && !single) {
      error(`--${name} goes with --to; the batch keeps its sources in the file.`);
      return 1;
    }
  }
  if (flags.has("not-opt-out") !== flags.has("seen")) {
    error("--not-opt-out and --seen go together: the preview shows the --seen=SM… to use.");
    return 1;
  }
  if (flags.has("seen") && !/^(SM|MM)[0-9a-f]{32}$/.test(flags.get("seen"))) {
    error(`--seen has to be the reply's ID from the preview (SM and 32 letters and digits), not "${flags.get("seen")}".`);
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
  const lockPath = `${logPath}.lock`;
  const optOutsPath = join(dirname(logPath), "opt-outs.csv");
  let doNotCall;
  try {
    const text = deps.readFile(dncPath);
    if (text == null) {
      error(
        `No do-not-call list at ${dncPath}.\n` +
          "If you keep it somewhere else, set DIAL_DNC_FILE to it in scripts/outreach/.env.\n" +
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
    rows = [{ to, business: "", text, source: flags.get("source")?.trim() ?? "" }];
  } else {
    try {
      const json = deps.readFile(batchPath);
      if (json == null) {
        error(`No batch at ${batchPath}. Put the texts there as a JSON array of { "to", "business", "text", "source" } (see scripts/outreach/README.md).`);
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
  const seen = flags.get("seen") ?? null;
  const note = flags.has("not-opt-out") ? `${flags.get("not-opt-out").trim()} (overrules ${seen})` : "";
  const rerun = single ? "Check the Twilio console before sending it again." : "Re-running is safe: it skips anyone already texted.";

  const planAndSend = async () => {
    let contacts;
    let balance;
    try {
      contacts = byContact(await textsOf(api, from));
      balance = await api.get("/Balance.json");
    } catch (err) {
      error(`Couldn't read the texting history or balance from Twilio (${describe(err)}). Nothing was sent.`);
      return 1;
    }

    // A STOP-style reply is final, so it goes on the do-not-call list, which dial.mjs
    // reads too. Each one is recorded in opt-outs.csv against the list it went on,
    // once: a number you take off that list yourself stays off (texts stay blocked
    // either way), though a new STOP puts it back, and every run says it's missing.
    let recorded;
    try {
      const lines = (deps.readFile(optOutsPath) ?? "").split("\n").slice(1).filter(Boolean);
      recorded = new Set(
        lines.map((line) => {
          const cells = csvCells(line);
          return `${cells[2]} ${cells[4]}`;
        })
      );
    } catch (err) {
      error(`Can't read ${optOutsPath} (${err.message}). Nothing was sent.`);
      return 1;
    }
    const takenOff = new Set();
    for (const [number, { received }] of contacts) {
      for (const stop of received.filter((m) => optOut(m.body) === "keyword")) {
        const id = stop.sid || `${number}@${stop.at.toISOString()}`;
        const key = `${id} ${dncPath}`;
        if (recorded.has(key)) {
          takenOff.add(number);
          continue;
        }
        const words = clip(stop.body, 40);
        if (!doNotCall.has(number)) {
          const line = `${pretty(number)}  # replied "${words}" to a text on ${sydneyDate(stop.at)} (added by text.mjs)`;
          try {
            deps.appendDoNotCall(dncPath, line);
          } catch (err) {
            error(`Couldn't add ${pretty(number)} to the do-not-call list (${err.message}). Nothing was sent. Add this line to ${dncPath} by hand, then re-run:\n${line}`);
            return 1;
          }
          doNotCall.add(number);
          log(`Added ${pretty(number)} to the do-not-call list: they replied "${words}" on ${sydneyDate(stop.at)}.`);
        }
        const entry = [deps.now().toISOString(), number, id, stop.at.toISOString(), csvField(dncPath), sheetSafe(clip(stop.body))];
        try {
          deps.appendOptOut(optOutsPath, entry.join(","));
        } catch (err) {
          error(`Couldn't record ${pretty(number)}'s opt-out in ${optOutsPath} (${err.message}). Nothing was sent.`);
          return 1;
        }
        recorded.add(key);
      }
    }
    for (const number of takenOff) {
      if (!doNotCall.has(number)) {
        error(`${pretty(number)} replied STOP to a text but isn't on the do-not-call list (taken off by hand?), so dial.mjs would ring them. Texts stay blocked.`);
      }
    }

    const today = sydneyDate(deps.now());
    const plan = planTexts(rows, { doNotCall, contacts, single, dailyMax, today, overruled: seen });
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
      if (!convo.length && !row.source) {
        error(
          `You've never texted ${pretty(row.to)} and they've never texted this number, so say where they publish their number: ` +
            '--source="…" (your evidence of consent, Spam Act s 16).'
        );
        return 1;
      }
      if (note) log(`Overruling a possible opt-out: ${note}.`);
    } else {
      log(`Batch ${batchPath}: ${rows.length} texts.`);
      log(`First texts today: ${firstTextsOn(contacts, today)} of ${dailyMax}.`);
      log(`Do-not-call list: ${doNotCall.size} number${doNotCall.size === 1 ? "" : "s"} checked (${dncPath}).`);
    }
    log("");
    plan.forEach((row, i) => {
      const label = row.action === "send" ? "SEND NOW" : `${row.action === "later" ? "LATER" : "SKIP"}: ${row.reason}`;
      const size = `${row.segments} segment${row.segments === 1 ? "" : "s"}${row.encoding === "UCS-2" ? " (UCS-2: emoji or special characters)" : ""}`;
      log(`${String(i + 1).padStart(2)}. ${single ? pretty(row.to) : who(row)} · ${size} · ${label}`);
      for (const line of row.text.split("\n")) log(`    ${line}`);
      if (row.source) log(`    source: ${row.source}`);
    });
    log("");
    const toSend = plan.filter((row) => row.action === "send");
    if (!toSend.length) {
      log("Nothing to send now.");
      return 0;
    }

    const segments = toSend.reduce((sum, row) => sum + row.segments, 0);
    const cost = segments * USD_PER_SEGMENT;
    const blockers = [];
    const hours = () => callingWindow(deps.now(), { zones: [SYDNEY] });
    const window = hours();
    if (!window.allowed) blockers.push(`${window.reason}; texts go out in the dialer's calling hours, Sydney time`);
    const funds = /^-?\d+(\.\d+)?$/.test(String(balance.balance ?? "")) ? Number(balance.balance) : NaN;
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
    const sent = [];
    let refused = 0;
    let refusedInARow = 0;
    let raced = 0;
    let unlogged = 0;
    let stopped = false;
    for (const [i, row] of toSend.entries()) {
      if (i > 0) await deps.sleep(GAP_MS);
      const recheck = hours();
      if (!recheck.allowed) {
        error(`Stopped: ${recheck.reason}. The rest go next time.`);
        stopped = true;
        break;
      }
      if (!single) {
        // Someone else (the Twilio console, another computer) may have texted them since the history was read.
        let latest;
        try {
          latest = await api.get(`/Messages.json?From=${encodeURIComponent(from)}&To=${encodeURIComponent(row.to)}&PageSize=1`);
        } catch (err) {
          error(`Couldn't re-check ${who(row)} before texting them (${describe(err)}), so stopped. Re-running is safe: it skips anyone already texted.`);
          stopped = true;
          break;
        }
        if (!Array.isArray(latest.messages) || latest.messages.length) {
          raced++;
          error(`Skipped ${who(row)}: ${Array.isArray(latest.messages) ? "they've been texted from this number since the history was read" : "Twilio's re-check came back without a message list"}.`);
          continue;
        }
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
      const entry = [deps.now().toISOString(), row.to, sheetSafe(row.business), kind, message.sid, row.segments, sheetSafe(row.source), sheetSafe(note)].join(",");
      try {
        deps.appendLog(logPath, entry);
      } catch (err) {
        unlogged++;
        error(`${logPath} couldn't be written (${err.message}). Add this row by hand:\n${entry}`);
      }
    }

    // Delivery reports take a few seconds; a carrier's spam filter shows up here as "undelivered".
    let failures = 0;
    let unknown = 0;
    if (sent.length) {
      await deps.sleep(STATUS_WAIT_MS);
      for (const { row, sid } of sent) {
        try {
          const message = await api.get(`/Messages/${sid}.json`);
          if (!message.status) throw new Error("Twilio's reply had no status");
          if (FAILED.has(message.status)) failures++;
          const detail = message.error_code ? ` (error ${message.error_code}${message.error_message ? `: ${message.error_message}` : ""})` : "";
          log(`${who(row)}: ${message.status}${detail}.`);
        } catch (err) {
          unknown++;
          error(`${who(row)}: couldn't read the delivery status (${describe(err)}). Check it in the Twilio console.`);
        }
      }
    }
    log(`Sent ${sent.length} of ${toSend.length}.`);
    const later = plan.filter((row) => row.action === "later").length;
    if (later) log(`${later} more in the batch: run it again tomorrow.`);
    log("Replies are forwarded to your mobile. A STOP reply goes on the do-not-call list by itself; add anyone who says no some other way yourself.");
    return stopped || refused || raced || failures || unknown || unlogged ? 1 : 0;
  };

  if (!flags.has("send")) return planAndSend(); // a preview sends nothing, so it needs no lock
  let release;
  try {
    release = deps.lock(lockPath);
  } catch (err) {
    error(`Not sending: ${err.message}.`);
    return 1;
  }
  const unlock = () => {
    try {
      release();
    } catch (err) {
      error(`Couldn't remove the send lock (${err.message}): delete ${lockPath} by hand before the next send.`);
    }
  };
  // Ctrl-C mid-send releases the lock, so it doesn't block the next send.
  const stopListening = deps.onInterrupt(() => {
    unlock();
    error(`\nInterrupted. ${rerun}`);
    deps.exit(130);
  });
  try {
    return await planAndSend();
  } finally {
    stopListening();
    unlock();
  }
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
