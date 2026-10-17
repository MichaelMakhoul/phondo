/**
 * SCRUM-594 simulated calls — the runner. See scripts/sim-calls/README.md.
 *
 *   SIM_FIXTURE=path/to/demo-line.json npx vitest run --config scripts/sim-calls/vitest.config.mts
 *
 * Scripted callers (an LLM with a goal) phone the demo line's REAL
 * conversation logic — server.js's turn handler, its guards, the real tool
 * executor, the real Next.js calendar handlers — over an in-memory diary, and
 * every call is scored against docs/call-scorecard.md. Network access is
 * limited to the Anthropic API: nothing here can touch production.
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
import { llmStats, scoreCall, type CallRecord, type DiaryEntry, type TranscriptLine } from "./score";
import { renderReport, renderRun, runFileName, type ScoredCall } from "./report";
import { usage } from "./anthropic";

/** The API key from the environment, else from voice-server/.env or SIM_ENV_FILE (never printed). */
function ensureAnthropicKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const envFile = process.env.SIM_ENV_FILE || path.join(VOICE_DIR, ".env");
  if (!fs.existsSync(envFile)) return;
  const line = fs.readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (line) process.env.ANTHROPIC_API_KEY = line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

/** Only the in-process tool-call route and the Anthropic API are reachable. */
function sandboxFetch(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${SIM_INTERNAL_URL}/api/internal/tool-call`) return POST(new Request(url, init));
    if (url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    throw new Error(`sim: blocked network call to ${url}`);
  }) as typeof fetch;
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

async function runCall(o: { scenario: Scenario; run: number; fixture: Fixture; callerModel: string; noise: NoiseLevel; outDir: string }): Promise<CallRecord> {
  const { scenario, run } = o;
  const persona = PERSONA;
  const transcript: TranscriptLine[] = [];
  const activeAfterTurn: number[] = [];
  const { orgId, calledNumber } = seedBusiness(o.fixture);
  const timezone = String((o.fixture.organizations?.[0]?.timezone as string) || "Australia/Sydney");
  const callSid = `CAsim${scenario.id}r${run}${crypto.randomBytes(4).toString("hex")}`;
  const record: CallRecord = {
    scenario,
    persona,
    run,
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
    for (const line of call.opening) transcript.push({ who: "ai", text: line.text, kind: line.kind });
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
        for (const s of spoken) transcript.push({ who: "ai", text: s.text, kind: s.kind });
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
    record.llm = llmStats(call.llmStats.ms, call.llmStats.calls);
  } catch (err) {
    record.ending = "error";
    record.error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 2000) : String(err);
  }
  return record;
}

/** SIM_RESCORE=<run dir>: score that run's saved calls again (a changed rubric or scorer), into report-rescored.md. */
async function rescore(dir: string): Promise<void> {
  ensureAnthropicKey();
  sandboxFetch();
  const judgeModel = process.env.SIM_JUDGE_MODEL || "claude-opus-5-5";
  const files = fs.readdirSync(path.join(dir, "runs")).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error(`no saved records in ${dir}/runs (runs before records were saved can't be re-scored)`);
  const records = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, "runs", f), "utf8")) as CallRecord);
  const startedAt = new Date();
  const scored: ScoredCall[] = await pool(records, Number(process.env.SIM_CONCURRENCY || 4), async (record) => {
    if (record.error) return { record, score: null, scoreError: "not scored: the call failed" };
    try {
      return { record, score: await scoreCall(record, judgeModel) };
    } catch (err) {
      return { record, score: null, scoreError: err instanceof Error ? err.message : String(err) };
    }
  });
  const ids = [...new Set(records.map((r) => r.scenario.id))];
  const report = renderReport({
    label: `${process.env.SIM_LABEL || path.basename(dir)} (re-scored)`,
    scenarios: SCENARIOS.filter((s) => ids.includes(s.id)),
    calls: scored,
    models: { receptionist: "as recorded", caller: "as recorded", judge: judgeModel },
    noise: "as recorded",
    usage,
    startedAt,
    finishedAt: new Date(),
  });
  fs.writeFileSync(path.join(dir, "report-rescored.md"), report);
  process.stdout.write(`\nsim re-scored report: ${path.join(dir, "report-rescored.md")}\n`);
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
  const scenarios = wanted.length > 0 ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`no scenarios match SIM_SCENARIOS=${process.env.SIM_SCENARIOS}`);
  const runs = Number(process.env.SIM_RUNS || 2);
  const concurrency = Number(process.env.SIM_CONCURRENCY || 4);
  const callerModel = process.env.SIM_CALLER_MODEL || "claude-sonnet-5-5";
  const judgeModel = process.env.SIM_JUDGE_MODEL || "claude-opus-5-5";
  const noise = (process.env.SIM_NOISE || "phone") as NoiseLevel;
  const label = process.env.SIM_LABEL || "unlabelled run";
  const startedAt = new Date();
  const outDir = process.env.SIM_OUT || path.resolve(VOICE_DIR, "..", ".sim-calls", startedAt.toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(path.join(outDir, "runs"), { recursive: true });

  ensureAnthropicKey();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (env or voice-server/.env)");
  process.env.INTERNAL_API_SECRET = SIM_INTERNAL_SECRET; // the route checks it; loadVoiceServer sets the same
  const processLog = fs.createWriteStream(path.join(outDir, "process.log"));
  routeConsole((line) => processLog.write(`${line}\n`));
  sandboxFetch();
  const vs = loadVoiceServer();

  const jobs = scenarios.flatMap((scenario) => Array.from({ length: runs }, (_, i) => ({ scenario, run: i + 1 })));
  const scored: ScoredCall[] = await pool(jobs, concurrency, async (job) => {
    const record = await runCall({ ...job, fixture, callerModel, noise, outDir });
    let result: ScoredCall;
    if (record.error) {
      result = { record, score: null, scoreError: "not scored: the call failed" };
    } else {
      try {
        result = { record, score: await scoreCall(record, judgeModel) };
      } catch (err) {
        result = { record, score: null, scoreError: err instanceof Error ? err.message : String(err) };
      }
    }
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
    models: { receptionist: vs.FAST_LLM_MODEL, caller: callerModel, judge: judgeModel },
    noise,
    usage,
    startedAt,
    finishedAt,
  });
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify(scored.map((s) => ({ scenario: s.record.scenario.id, run: s.record.run, ending: s.record.ending, turns: s.record.turns, anomalies: s.record.anomalies, error: s.record.error, score: s.score, scoreError: s.scoreError })), null, 2),
  );
  processLog.end();
  process.stdout.write(`\nsim report: ${path.join(outDir, "report.md")}\n`);

  const broken = scored.filter((s) => s.record.error || s.scoreError || s.record.anomalies.length > 0);
  expect(broken.map((s) => `${s.record.scenario.id} run ${s.record.run}: ${s.record.error ?? s.scoreError ?? s.record.anomalies[0]}`)).toEqual([]);
}, 3 * 60 * 60 * 1000);
