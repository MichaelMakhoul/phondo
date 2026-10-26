/**
 * SCRUM-594 simulated calls — the runner. See scripts/sim-calls/README.md.
 *
 *   SIM_FIXTURE=path/to/demo-line.json npx vitest run --config scripts/sim-calls/vitest.config.ts
 *
 * Scripted callers (an LLM with a goal) phone the demo line's REAL
 * conversation logic — server.js's turn handler, its guards, the real tool
 * executor, the real Next.js calendar handlers — over an in-memory diary, and
 * every call is scored against docs/call-scorecard.md. Network access is
 * limited to Haiku on the Messages API (Anthropic's, or OpenRouter's under
 * SIM_GATEWAY=openrouter; gateway.ts): nothing here can touch production.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/admin", async () => {
  const { simDb } = await import("./fake-supabase");
  return { createAdminClient: () => simDb.client() };
});
vi.mock("@sentry/nextjs", () => {
  const scope = { setTag() {}, setTags() {}, setExtra() {}, setExtras() {}, setLevel() {}, setContext() {}, setUser() {}, setFingerprint() {} };
  return {
    captureException: () => "",
    captureMessage: () => "",
    withScope: (fn: (s: typeof scope) => unknown) => fn(scope),
    addBreadcrumb: () => {},
    setTag: () => {},
    setExtra: () => {},
    setContext: () => {},
    flush: async () => true,
  };
});
// Customer emails/SMS and the owner's notifications: never sent from a simulation.
vi.mock("@/lib/notifications/notification-service", () => ({
  sendAppointmentNotification: async () => "skipped",
  sendCallbackNotification: async () => "skipped",
}));
vi.mock("@/lib/sms/caller-sms", () => ({
  sendAppointmentConfirmationSMS: async () => undefined,
  sendCancellationSMS: async () => undefined,
}));
// Production POSTs the voice server's /cache/invalidate, which invalidates its schedule cache.
vi.mock("@/lib/voice-cache/invalidate", async () => {
  const { loadVoiceServer } = await import("./voice");
  return {
    invalidateVoiceScheduleCache: async (organizationId: string) => {
      loadVoiceServer().scheduleCache.invalidate(organizationId);
    },
  };
});
vi.mock("@/lib/security/rate-limiter", () => ({
  withRateLimit: () => ({ allowed: true, headers: {} }),
  rateLimitDistributed: async () => ({ allowed: true }),
}));
vi.mock("@/lib/observability/page-sentry", () => ({ pageSentry: () => {} }));

import { POST } from "@/app/api/internal/tool-call/route";
import { simDb, type Row } from "./fake-supabase";
import { loadVoiceServer, routeConsole, startSimCall, SIM_INTERNAL_SECRET, SIM_INTERNAL_URL, VOICE_DIR } from "./voice";
import { SimCaller, hearAs, HANGUP, type NoiseLevel } from "./caller";
import { PERSONA, SCENARIOS, type Scenario } from "./scenarios";
import { llmStats, SESSION_JUDGE, type CallRecord, type DiaryEntry, type TranscriptLine } from "./score";
import { renderReport, renderRun, runFileName, type ScoredCall } from "./report";
import { usage } from "./anthropic";
import { assertApiModel, envKey, OPENROUTER_PLACEHOLDER_KEY, simFetch, simGateway, type Gateway } from "./gateway";
import { assertFreshRunDir, loadRecords, scoreRecord } from "./runs";

/** The gateway's API key from the environment, else from voice-server/.env or SIM_ENV_FILE (never printed). */
function ensureApiKey(gateway: Gateway): void {
  const envFile = process.env.SIM_ENV_FILE || path.join(VOICE_DIR, ".env");
  if (gateway === "openrouter") {
    const key = envKey("OPENROUTER_API_KEY", envFile);
    if (!key) throw new Error("SIM_GATEWAY=openrouter: OPENROUTER_API_KEY is not set (env or voice-server/.env)");
    process.env.OPENROUTER_API_KEY = key;
    process.env.ANTHROPIC_API_KEY = OPENROUTER_PLACEHOLDER_KEY; // the real Anthropic key is never loaded
    return;
  }
  const key = envKey("ANTHROPIC_API_KEY", envFile);
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set (env or voice-server/.env)");
  process.env.ANTHROPIC_API_KEY = key;
}

/** Only the in-process tool-call route and Haiku on the Messages API are reachable (gateway.ts). */
function sandboxFetch(gateway: Gateway): void {
  globalThis.fetch = simFetch({
    realFetch: globalThis.fetch.bind(globalThis),
    internalUrl: `${SIM_INTERNAL_URL}/api/internal/tool-call`,
    internal: (req) => POST(req),
    gateway,
    openRouterKey: process.env.OPENROUTER_API_KEY,
  });
}

/** A model as the report names it. */
function modelLabel(model: string, gateway: Gateway): string {
  return gateway === "openrouter" && model !== SESSION_JUDGE ? `${model} via OpenRouter` : model;
}

type Fixture = Record<string, Row[]>;

/**
 * Seed one call's business: the fixture with every id replaced (foreign keys
 * follow), so concurrent calls never share an org, a schedule cache or a diary.
 */
function seedBusiness(fixture: Fixture): { orgId: string; calledNumber: string } {
  const ids = new Map<string, string>();
  for (const rows of Object.values(fixture)) for (const r of rows) if (typeof r.id === "string") ids.set(r.id, crypto.randomUUID());
  let json = JSON.stringify(fixture);
  for (const [from, to] of ids) json = json.split(from).join(to);
  const seeded = JSON.parse(json) as Fixture;
  const calledNumber = `+612${String(crypto.randomInt(10_000_000, 99_999_999))}`;
  const phones = seeded.phone_numbers || [];
  if (phones.length !== 1) throw new Error(`sim: the fixture needs exactly one phone_numbers row (has ${phones.length})`);
  phones[0].phone_number = calledNumber;
  for (const [table, rows] of Object.entries(seeded)) simDb.seed(table, rows);
  const orgs = seeded.organizations || [];
  if (orgs.length !== 1) throw new Error(`sim: the fixture needs exactly one organizations row (has ${orgs.length})`);
  return { orgId: String(orgs[0].id), calledNumber };
}

/** Each call has its own business with an empty diary, so every appointment in it is this caller's. */
/** "YYYY-MM-DD" of the nth business day (Mon–Fri) after today in `timezone` (n = 1: the next one). */
function businessDayAfterToday(timezone: string, n: number): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
  const weekday = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(d);
  let found = 0;
  for (let i = 1; i < 30; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    if (weekday(d) === "Sat" || weekday(d) === "Sun") continue;
    if (++found === n) return day(d);
  }
  throw new Error("sim: no business day in the next 30 days");
}

/** The UTC instant of a wall-clock time in `timezone` (two passes settle a DST edge). */
function zonedInstant(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let pass = 0; pass < 2; pass++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** A scenario's bookings from an earlier call: the caller's, under their own name and number, no call_id. */
function seedEarlierBookings(scenario: Scenario, orgId: string, timezone: string): void {
  for (const b of scenario.earlierBookings || []) {
    const start = zonedInstant(businessDayAfterToday(timezone, b.businessDay), b.time, timezone);
    simDb.seed("appointments", [{
      id: crypto.randomUUID(),
      organization_id: orgId,
      provider: "internal",
      attendee_name: `${PERSONA.firstName} ${PERSONA.lastName}`,
      attendee_first_name: PERSONA.firstName,
      attendee_last_name: PERSONA.lastName,
      attendee_phone: PERSONA.phone,
      attendee_email: `booking-${crypto.randomUUID()}@noreply.phondo.ai`,
      start_time: start.toISOString(),
      end_time: new Date(start.getTime() + 30 * 60_000).toISOString(),
      duration_minutes: 30,
      status: "confirmed",
      confirmation_code: String(crypto.randomInt(100_000, 999_999)),
      metadata: { source: "ai_receptionist" },
      call_id: null,
    }]);
  }
}

function activeCount(orgId: string): number {
  return simDb.rows("appointments").filter((r) => r.organization_id === orgId && (r.status === "confirmed" || r.status === "pending")).length;
}

function diaryFor(orgId: string, callId: string, timezone: string): DiaryEntry[] {
  const fmt = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return simDb
    .rows("appointments")
    .filter((r) => r.organization_id === orgId)
    .sort((a, b) => Date.parse(String(a.start_time)) - Date.parse(String(b.start_time)))
    .map((r) => ({
      id: String(r.id),
      local: fmt.format(new Date(String(r.start_time))),
      status: String(r.status),
      attendeeName: String(r.attendee_name ?? ""),
      lastName: r.attendee_last_name == null ? null : String(r.attendee_last_name),
      madeThisCall: r.call_id === callId,
      rescheduledFromId: r.rescheduled_from_id == null ? null : String(r.rescheduled_from_id),
    }));
}

/** SCRUM-594 F5: the org's business_hours as one line for the judge. */
function describeHours(hours: unknown): string | undefined {
  if (!hours || typeof hours !== "object") return undefined;
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return days.map((d) => {
    const c = (hours as Record<string, { open?: string; close?: string; closed?: boolean } | undefined>)[d];
    return !c || c.closed || !c.open || !c.close ? `${d} closed` : `${d} ${c.open}–${c.close}`;
  }).join("; ");
}

/**
 * SCRUM-594 F5: every call runs as if it were `iso`, the clock still ticking
 * (a scenario's `clock`, or SIM_NOW). One clock per run: Date is global.
 */
function installSimClock(iso: string): void {
  const RealDate = Date;
  const target = RealDate.parse(iso);
  if (!Number.isFinite(target)) throw new Error(`sim: not a date: ${iso}`);
  const offset = target - RealDate.now();
  class SimDate extends RealDate {
    constructor(...args: unknown[]) {
      // @ts-expect-error Date takes these arguments; none means "now" on the sim clock
      super(...(args.length === 0 ? [RealDate.now() + offset] : args));
    }
    static now(): number {
      return RealDate.now() + offset;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = SimDate as unknown as DateConstructor;
}

async function runCall(o: { scenario: Scenario; run: number; fixture: Fixture; callerModel: string; noise: NoiseLevel; outDir: string }): Promise<CallRecord> {
  const { scenario, run } = o;
  const persona = PERSONA;
  const transcript: TranscriptLine[] = [];
  const activeAfterTurn: number[] = [];
  const { orgId, calledNumber } = seedBusiness(o.fixture);
  const timezone = String((o.fixture.organizations?.[0]?.timezone as string) || "Australia/Sydney");
  seedEarlierBookings(scenario, orgId, timezone);
  const callSid = `CAsim${scenario.id}r${run}${crypto.randomBytes(4).toString("hex")}`;
  const record: CallRecord = {
    scenario,
    persona,
    run,
    callTime: new Date().toISOString(), // SIM_NOW / the scenario's clock when set
    businessHours: describeHours(o.fixture.organizations?.[0]?.business_hours),
    transcript,
    toolTrace: [],
    diary: [],
    activeAfterTurn,
    ending: "max-turns",
    anomalies: [],
    logs: [],
    llm: { calls: 0, medianMs: 0, p90Ms: 0 },
    turns: 0,
  };
  try {
    const call = await startSimCall({ calledNumber, callerPhone: persona.phone, callSid });
    // The receptionist's whole system prompt, once per run set (only ids and the date differ between calls).
    const promptFile = path.join(o.outDir, "system-prompt.txt");
    if (!fs.existsSync(promptFile)) fs.writeFileSync(promptFile, call.systemPrompt);
    record.toolTrace = call.toolTrace;
    record.logs = call.logs;
    record.anomalies = call.anomalies;
    for (const line of call.opening) transcript.push({ who: "ai", text: line.text, kind: line.kind, voice: line.voice });
    const caller = new SimCaller(persona, scenario.goal, o.callerModel);
    let aiSaid = call.opening.map((l) => l.text).join(" ");
    for (let turn = 0; turn < scenario.maxTurns; turn++) {
      const { said, hangUp } = await caller.next(aiSaid);
      const clean = said.replace(HANGUP, "").trim();
      record.turns = turn + 1;
      if (clean) {
        const heard = hearAs(clean, persona, o.noise, turn);
        transcript.push({ who: "caller", said: clean, heard });
        const spoken = await call.callerSays(heard);
        for (const s of spoken) transcript.push({ who: "ai", text: s.text, kind: s.kind, voice: s.voice });
        aiSaid = spoken.map((s) => s.text).join(" ");
      }
      activeAfterTurn.push(activeCount(orgId));
      if (call.ended()) {
        record.ending = "end_call";
        break;
      }
      if (hangUp) {
        record.ending = "caller-hangup";
        break;
      }
    }
    record.diary = diaryFor(orgId, call.session.callRecordId, timezone);
    record.languages = call.session.languagesUsed || ["en"];
    record.finalLanguage = call.session.fastLanguage || "en";
    record.llm = llmStats(call.llmStats.ms, call.llmStats.calls);
  } catch (err) {
    record.ending = "error";
    record.error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 2000) : String(err);
  }
  return record;
}

/** SIM_RESCORE=<run dir>: score that run's saved calls again (a changed rubric or scorer), into report-rescored.md. */
async function rescore(dir: string): Promise<void> {
  const gateway = simGateway();
  const judgeModel = process.env.SIM_JUDGE_MODEL || SESSION_JUDGE;
  if (judgeModel !== SESSION_JUDGE) {
    // The session's grades need no API.
    assertApiModel(judgeModel, gateway);
    ensureApiKey(gateway);
  }
  sandboxFetch(gateway);
  const records = loadRecords(dir);
  const startedAt = new Date();
  // A call the session hasn't graded is no pass: it fails the re-score.
  const scored: ScoredCall[] = await pool(records, Number(process.env.SIM_CONCURRENCY || 4), (record) => scoreRecord(record, judgeModel, dir, true));
  const ids = [...new Set(records.map((r) => r.scenario.id))];
  const report = renderReport({
    label: `${process.env.SIM_LABEL || path.basename(dir)} (re-scored)`,
    scenarios: SCENARIOS.filter((s) => ids.includes(s.id)),
    calls: scored,
    models: { receptionist: "as recorded", caller: "as recorded", judge: modelLabel(judgeModel, gateway) },
    noise: "as recorded",
    usage,
    startedAt,
    finishedAt: new Date(),
  });
  fs.writeFileSync(path.join(dir, "report-rescored.md"), report);
  process.stdout.write(`\nsim re-scored report: ${path.join(dir, "report-rescored.md")}\n`);
  expectNoneBroken(scored);
}

/** Fails the vitest run (after the report is written) when a call failed, was anomalous or couldn't be scored. */
function expectNoneBroken(scored: ScoredCall[]): void {
  const broken = scored.filter((s) => s.record.error || s.scoreError || s.record.anomalies.length > 0);
  expect(broken.map((s) => `${s.record.scenario.id} run ${s.record.run}: ${s.record.error ?? s.scoreError ?? s.record.anomalies[0]}`)).toEqual([]);
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

it("simulated demo-line calls", async () => {
  if (process.env.SIM_RESCORE) return rescore(process.env.SIM_RESCORE);
  const fixturePath = process.env.SIM_FIXTURE;
  if (!fixturePath) throw new Error("SIM_FIXTURE is required: a JSON dump of the demo org's rows (see README.md)");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
  const wanted = (process.env.SIM_SCENARIOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // A clocked scenario (S8) is left out of a default run unless SIM_NOW sets one clock for all.
  const scenarios = wanted.length > 0 ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS.filter((s) => !s.clock || process.env.SIM_NOW);
  if (scenarios.length === 0) throw new Error(`no scenarios match SIM_SCENARIOS=${process.env.SIM_SCENARIOS}`);
  // SCRUM-594 F5: a clocked scenario (S8) runs at its own time — on its own, since Date is global.
  const clocks = [...new Set(scenarios.map((s) => s.clock).filter((c): c is string => Boolean(c)))];
  const clock = process.env.SIM_NOW || (clocks.length === 1 && scenarios.every((s) => s.clock) ? clocks[0] : null);
  if (!process.env.SIM_NOW && clocks.length > 0 && !clock) {
    throw new Error(`sim: ${scenarios.filter((s) => s.clock).map((s) => s.id).join(", ")} must run at their own time: run them on their own (SIM_SCENARIOS=…) or set SIM_NOW`);
  }
  // The default run folder is named from the real time: on a sim clock every clocked run would get the same name.
  const runStamp = new Date().toISOString();
  if (clock) installSimClock(clock);
  const runs = Number(process.env.SIM_RUNS || 2);
  const concurrency = Number(process.env.SIM_CONCURRENCY || 4);
  const gateway = simGateway();
  const callerModel = process.env.SIM_CALLER_MODEL || "claude-haiku-5-5";
  const judgeModel = process.env.SIM_JUDGE_MODEL || SESSION_JUDGE;
  assertApiModel(callerModel, gateway);
  if (judgeModel !== SESSION_JUDGE) assertApiModel(judgeModel, gateway);
  const noise = (process.env.SIM_NOISE || "phone") as NoiseLevel;
  const label = process.env.SIM_LABEL || "unlabelled run";
  const startedAt = new Date();
  const outDir = process.env.SIM_OUT || path.resolve(VOICE_DIR, "..", ".sim-calls", runStamp.replace(/[:.]/g, "-"));
  assertFreshRunDir(outDir);
  fs.mkdirSync(path.join(outDir, "runs"), { recursive: true });

  ensureApiKey(gateway);
  process.env.INTERNAL_API_SECRET = SIM_INTERNAL_SECRET; // the route checks it; loadVoiceServer sets the same
  const processLog = fs.createWriteStream(path.join(outDir, "process.log"));
  routeConsole((line) => processLog.write(`${line}\n`));
  sandboxFetch(gateway);
  const vs = loadVoiceServer();
  assertApiModel(vs.FAST_LLM_MODEL, gateway);

  const jobs = scenarios.flatMap((scenario) => Array.from({ length: runs }, (_, i) => ({ scenario, run: i + 1 })));
  const scored: ScoredCall[] = await pool(jobs, concurrency, async (job) => {
    const record = await runCall({ ...job, fixture, callerModel, noise, outDir });
    const result = await scoreRecord(record, judgeModel, outDir, false); // the session grades afterwards (SIM_RESCORE)
    fs.writeFileSync(path.join(outDir, "runs", runFileName(record)), renderRun(result));
    // The whole record, so a changed rubric can re-score this run without re-simulating it (SIM_RESCORE).
    fs.writeFileSync(path.join(outDir, "runs", runFileName(record).replace(/\.md$/, ".json")), JSON.stringify(record));
    processLog.write(`[sim] ${record.scenario.id} run ${record.run}: ${record.ending}, ${record.turns} turns\n`);
    return result;
  });

  const finishedAt = new Date();
  const report = renderReport({
    label,
    scenarios,
    calls: scored,
    models: { receptionist: modelLabel(vs.FAST_LLM_MODEL, gateway), caller: modelLabel(callerModel, gateway), judge: modelLabel(judgeModel, gateway) },
    noise,
    usage,
    startedAt,
    finishedAt,
  });
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify(scored.map((s) => ({ scenario: s.record.scenario.id, run: s.record.run, ending: s.record.ending, turns: s.record.turns, languages: s.record.languages, anomalies: s.record.anomalies, error: s.record.error, score: s.score, scoreError: s.scoreError })), null, 2),
  );
  processLog.end();
  process.stdout.write(`\nsim report: ${path.join(outDir, "report.md")}\n`);
  const ungraded = scored.filter((s) => s.score?.pending).length;
  if (ungraded > 0) process.stdout.write(`Ungraded calls: ${ungraded}. Grade runs/*.judge-prompt.md into runs/*.judge.json, then SIM_RESCORE=${outDir}\n`);

  expectNoneBroken(scored);
}, 3 * 60 * 60 * 1000);
