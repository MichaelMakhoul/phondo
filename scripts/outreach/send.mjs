#!/usr/bin/env node
/*
 * Phondo cold-outreach sender.
 *
 * SAFE BY DEFAULT: prints what it WOULD send (dry-run). It only touches Resend
 * when you pass --send (schedule the batch) or --test=you@email (one email to
 * yourself now). Nothing is ever sent without you explicitly asking.
 *
 * Usage:
 *   # preview the batch (no key needed):
 *   node scripts/outreach/send.mjs --batch=scripts/outreach/batch.json
 *
 *   # send one sample to yourself (needs scripts/outreach/.env):
 *   node --env-file=scripts/outreach/.env scripts/outreach/send.mjs --test=you@gmail.com
 *
 *   # schedule the whole batch for real (needs scripts/outreach/.env):
 *   node --env-file=scripts/outreach/.env scripts/outreach/send.mjs --send --at="2026-07-15T09:30:00+10:00"
 *
 * Guard rails baked in: honesty gate (every email must quote the recipient's own
 * review/ad), suppression list, a daily cap (no silent truncation), plain text,
 * one link, an opt-out line on every message.
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SEND = !!args.send;
const TEST = typeof args.test === "string" ? args.test : null;
const BATCH = args.batch || "scripts/outreach/batch.json";
const SUPPRESSION = args.suppression || "scripts/outreach/suppression.csv";
const SENTLOG = args.log || "scripts/outreach/sent.csv";
const CAP = Number(args.cap || 15);
const GLOBAL_AT = typeof args.at === "string" ? args.at : null;
const FORCE = !!args.force;

const FROM = process.env.OUTREACH_FROM || "Michael from Phondo <michael@phondo.ai>";
const REPLY_TO = process.env.OUTREACH_REPLY_TO || "michaelmakhoul0@gmail.com";
const KEY = process.env.RESEND_OUTREACH_API_KEY || "";

// ---------- templates ----------
// First-touch emails are deliberately minimal: personal, ONE question, NO link,
// NO offer, no "AI receptionist" wording, no opt-out line. That is what keeps Gmail
// from filing them under Promotions. The pitch and the link live in REPLY, which you
// send only after they reply (replies stay in the same Primary thread).
const PHONE = process.env.OUTREACH_PHONE || "0400 000 000"; // placeholder until a Twilio number is wired up
const SIGN = `\n\nMichael\nPhondo\n${PHONE}`;

const templates = {
  // reviews mention the phones. Soft, one question, no quote pasted in.
  T1: (v) => {
    req(v, "evidence"); // gate: you have confirmed their reviews really mention the phones (not printed, keeps it personal)
    return {
      subject: `${req(v, "business")}'s phones`,
      text:
`Hi ${v.firstName || "there"},

I noticed a few of ${req(v, "business")}'s reviews mention people struggling to get through on the phone. Is that something you're across, or has it settled down?

I work with ${req(v, "verticalPlural")} on keeping calls answered. Happy to explain if it's useful, or pop in for a quick chat.${SIGN}`,
    };
  },

  // they are advertising for a receptionist / front desk.
  T2: (v) => ({
    subject: `your front desk role`,
    text:
`Hi ${v.firstName || "there"},

Saw ${req(v, "business")} is hiring for the front desk. Quick one while you're recruiting: are you managing to catch all your calls, or are some slipping to voicemail?

I help ${req(v, "verticalPlural")} keep the phones covered while they're short-staffed. Happy to have a quick chat or swing by if it would help.${SIGN}`,
  }),

  // you actually rang them and could not get through (strongest, most personal).
  T3: (v) => ({
    subject: `tried to reach ${req(v, "business")} on ${req(v, "day")}`,
    text:
`Hi ${v.firstName || "there"},

I tried calling ${req(v, "business")} on ${req(v, "day")} around ${req(v, "time")} and couldn't get through. Is the main line still the best way to reach you?

I actually help ${req(v, "verticalPlural")} with missed calls. Happy to explain if it's handy, or pop by for a chat.${SIGN}`,
  }),

  // Send this ONLY after they reply. The link and the full pitch live here, on purpose.
  REPLY: (v) => ({
    subject: `re: ${v.subject || "your phones"}`,
    text:
`Thanks ${v.firstName || "there"}, appreciate you getting back to me.

Short version: Phondo is an AI receptionist that answers your calls 24/7, including the busy times, lunch, and after hours. It takes the caller's name, number and what they need and sends it to your team straight away, and puts urgent callers through to a real person. Your number and the way you work don't change.

Easiest thing is to just hear it: phondo.ai/demo (a real call, no signup, about a minute). Or I'm happy to come by and show you in person.

If you'd like to try it, the first month is on me and I'll set the whole thing up.

Michael
Phondo · phondo.ai
${PHONE}`,
  }),
};

function req(v, field) {
  if (!v[field] || String(v[field]).trim() === "") {
    throw new Error(`missing "${field}" for ${v.email || "(no email)"} — required for template ${v.template}`);
  }
  return v[field];
}

// ---------- helpers ----------
function loadSuppression() {
  if (!existsSync(SUPPRESSION)) return new Set();
  return new Set(
    readFileSync(SUPPRESSION, "utf8")
      .split(/\r?\n/)
      .map((s) => s.split(",")[0].trim().toLowerCase())
      .filter((s) => s && s.includes("@"))
  );
}

function loadBatch() {
  if (!existsSync(BATCH)) {
    console.error(`\n  Batch file not found: ${BATCH}\n  Create it (see batch.sample.json) or pass --batch=<path>.\n`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(BATCH, "utf8"));
  if (!Array.isArray(raw)) throw new Error("batch file must be a JSON array of recipients");
  return raw;
}

function build(item) {
  const t = templates[item.template];
  if (!t) throw new Error(`unknown template "${item.template}" for ${item.email} (use T1, T2 or T3)`);
  const { subject, text } = t(item);
  return { to: item.email, subject, text, scheduledAt: item.scheduledAt || GLOBAL_AT || undefined };
}

function banner() {
  console.log("\n" + "═".repeat(70));
  console.log(`  Phondo outreach  ·  ${SEND ? "SEND (scheduling for real)" : TEST ? "TEST (one to yourself)" : "DRY-RUN (nothing sent)"}`);
  console.log(`  From: ${FROM}   Reply-To: ${REPLY_TO}`);
  console.log("═".repeat(70));
}

function printEmail(e, i) {
  console.log(`\n[${i + 1}] → ${e.to}${e.scheduledAt ? `   @ ${e.scheduledAt}` : "   (send immediately)"}`);
  console.log(`    Subject: ${e.subject}`);
  console.log("    " + e.text.replace(/\n/g, "\n    "));
}

function requireKeyOrExit() {
  if (!KEY) {
    console.error(
      "\n  RESEND_OUTREACH_API_KEY is not set.\n" +
        "  Create a SEPARATE 'Sending access' key in the PHONDO Resend account,\n" +
        "  put it in scripts/outreach/.env, and run with:  node --env-file=scripts/outreach/.env ...\n" +
        "  Do NOT use the app's EMAIL_API_KEY.\n"
    );
    process.exit(1);
  }
}

// ---------- main ----------
async function main() {
  banner();
  const suppressed = loadSuppression();

  // --test: one sample to yourself, right now, no schedule
  if (TEST) {
    requireKeyOrExit();
    const sample = {
      email: TEST,
      template: "T2",
      firstName: "there",
      business: "Your Business",
      board: "Seek",
      verticalPlural: "small businesses",
      booksLine: "captures the details",
      evidence: "answering a high volume of incoming calls",
    };
    const e = build(sample);
    const { Resend } = await import("resend");
    const resend = new Resend(KEY);
    const { data, error } = await resend.emails.send({ from: FROM, to: [e.to], replyTo: REPLY_TO, subject: e.subject, text: e.text });
    if (error) { console.error("  Resend error:", error); process.exit(1); }
    console.log(`\n  Test email sent to ${TEST}. Resend id: ${data?.id}`);
    console.log("  Check it landed in the inbox (not spam) and the from-name/reply-to look right.\n");
    return;
  }

  const batch = loadBatch();
  const emails = [];
  const skipped = [];
  for (const item of batch) {
    if (!item.email || !item.email.includes("@")) { skipped.push([item.email, "no valid email"]); continue; }
    if (suppressed.has(item.email.toLowerCase())) { skipped.push([item.email, "on suppression list"]); continue; }
    emails.push(build(item)); // throws on missing template vars / evidence — fail loud, don't send half a bad batch
  }

  if (emails.length > CAP && !FORCE) {
    console.error(`\n  Batch has ${emails.length} emails but the daily cap is ${CAP}.`);
    console.error(`  Split it across days (recommended during warm-up) or pass --cap=${emails.length} / --force to override.\n`);
    process.exit(1);
  }

  emails.forEach(printEmail);
  if (skipped.length) {
    console.log(`\n  Skipped ${skipped.length}:`);
    skipped.forEach(([e, why]) => console.log(`    - ${e} (${why})`));
  }
  console.log(`\n  ${emails.length} email(s) ready. Cap ${CAP}.`);

  if (!SEND) {
    console.log("\n  DRY-RUN — nothing was sent. Re-run with --send (and --env-file) to schedule.");
    console.log("  Reminder: only send to addresses the business has published, keep it relevant to");
    console.log("  their operations, and honour every 'no' (add it to suppression.csv).\n");
    return;
  }

  requireKeyOrExit();
  const { Resend } = await import("resend");
  const resend = new Resend(KEY);
  console.log("\n  Sending…");
  for (const e of emails) {
    const payload = { from: FROM, to: [e.to], replyTo: REPLY_TO, subject: e.subject, text: e.text };
    if (e.scheduledAt) payload.scheduledAt = e.scheduledAt;
    const { data, error } = await resend.emails.send(payload);
    if (error) { console.error(`    ✗ ${e.to}: ${JSON.stringify(error)}`); continue; }
    const row = `${new Date().toISOString()},${e.to},${e.scheduledAt || "now"},${data?.id || ""}`;
    appendFileSync(SENTLOG, row + "\n");
    console.log(`    ✓ ${e.to}  id=${data?.id}${e.scheduledAt ? `  @${e.scheduledAt}` : ""}`);
    await new Promise((r) => setTimeout(r, 400)); // gentle pacing
  }
  console.log(`\n  Done. Logged to ${SENTLOG}. Cancel a scheduled one with:  resend.emails.cancel(id)\n`);
}

main().catch((err) => { console.error("\n  Aborted:", err.message, "\n"); process.exit(1); });
