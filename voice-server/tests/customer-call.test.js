// voice-server/tests/customer-call.test.js
"use strict";
const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-598: the AI's call to a customer. Every check fails closed, the number rung
// is always the booking's own, and the request must come from an owner session of
// the same org.
const cc = require("../lib/customer-call");

const SECRET = "test-internal-secret";
const ORG = "11111111-1111-4111-8111-111111111111";
const APPT = "22222222-2222-4222-8222-222222222222";
const OWNER_CALL = "33333333-3333-4333-8333-333333333333";
const NUMBER_ID = "44444444-4444-4444-8444-444444444444";
const CALL_ID = "55555555-5555-4555-8555-555555555555";
const ASSISTANT = "66666666-6666-4666-8666-666666666666";
const DEMO_ORG = "d0000000-0000-4000-a000-000000000001";
const PHONE = "+61412345678";
// 2026-10-27 is a Tuesday; 03:00Z is 14:00 in Sydney (AEDT, UTC+11).
const NOW = Date.parse("2026-10-27T03:00:00Z");
const FUTURE = "2026-10-29T01:30:00Z";

/**
 * A recording fake of the supabase-js builder. Every query is captured (table, op,
 * filters, payload) and answered by `respond(query)` when awaited or finished with
 * maybeSingle/single.
 */
function fakeSupabase(respond) {
  const queries = [];
  return {
    queries,
    from(table) {
      const q = { table, op: "select", cols: null, filters: [], payload: null, returning: false, limitN: null, order: null };
      const answer = async () => {
        queries.push(q);
        const r = respond(q);
        if (r instanceof Error) throw r;
        return r ?? { data: null, error: null };
      };
      const chain = {
        select(cols) {
          if (q.op === "select") q.cols = cols;
          else q.returning = cols;
          return chain;
        },
        insert(payload) { q.op = "insert"; q.payload = payload; return chain; },
        update(payload) { q.op = "update"; q.payload = payload; return chain; },
        eq(col, val) { q.filters.push(["eq", col, val]); return chain; },
        gte(col, val) { q.filters.push(["gte", col, val]); return chain; },
        lt(col, val) { q.filters.push(["lt", col, val]); return chain; },
        is(col, val) { q.filters.push(["is", col, val]); return chain; },
        not(col, op, val) { q.filters.push(["not", col, op, val]); return chain; },
        in(col, vals) { q.filters.push(["in", col, vals]); return chain; },
        order(col, opts) { q.order = [col, opts]; return chain; },
        limit(n) { q.limitN = n; return chain; },
        maybeSingle: answer,
        single: answer,
        then(resolve, reject) { return answer().then(resolve, reject); },
      };
      return chain;
    },
  };
}

const has = (q, ...filter) => q.filters.some((f) => JSON.stringify(f) === JSON.stringify(filter));

/** The rows a passing check reads, overridable per test. */
function world(over = {}) {
  return {
    ownerCall: { id: OWNER_CALL, metadata: { call_type: "owner" } },
    org: { id: ORG, name: "Bob's Plumbing", timezone: "Australia/Sydney", country: "AU" },
    appt: { id: APPT, status: "confirmed", start_time: FUTURE, attendee_phone: "0412 345 678" },
    numbers: [{ id: NUMBER_ID, phone_number: "+61257015064", assistant_id: ASSISTANT }],
    recent: [],
    dnc: [],
    ...over,
  };
}

/** Answers the check's queries from a world; `extra` handles anything else (inserts, updates). */
function responder(w, extra = () => undefined) {
  return (q) => {
    const e = extra(q);
    if (e !== undefined) return e;
    if (q.table === "calls" && q.op === "select" && has(q, "eq", "id", OWNER_CALL)) {
      return w.ownerCallError ? { data: null, error: w.ownerCallError } : { data: w.ownerCall, error: null };
    }
    if (q.table === "organizations") return w.orgError ? { data: null, error: w.orgError } : { data: w.org, error: null };
    if (q.table === "appointments") return w.apptError ? { data: null, error: w.apptError } : { data: w.appt, error: null };
    if (q.table === "phone_numbers") return w.numbersError ? { data: null, error: w.numbersError } : { data: w.numbers, error: null };
    if (q.table === "calls" && q.op === "select" && q.filters.some((f) => f[0] === "gte" && f[1] === "created_at")) {
      return w.recentError ? { data: null, error: w.recentError } : { data: w.recent, error: null };
    }
    if (q.table === "calls" && q.op === "select" && has(q, "eq", "metadata->notify->>outcome", "do_not_call")) {
      return w.dncError ? { data: null, error: w.dncError } : { data: w.dnc, error: null };
    }
    return { data: null, error: { message: `unexpected query on ${q.table}` } };
  };
}

function req(over = {}) {
  return { organizationId: ORG, appointmentId: APPT, purpose: "confirm", phone: PHONE, requestedByCallId: OWNER_CALL, ...over };
}

function checkDeps(supabase, over = {}) {
  return {
    supabase,
    env: { OWNER_CUSTOMER_CALLS_ENABLED: "true" },
    now: () => NOW,
    pipelineAvailable: () => true,
    demoOrgId: DEMO_ORG,
    ...over,
  };
}

let spies;
beforeEach(() => {
  cc.resetPlacementGuards();
  spies = Object.fromEntries(["log", "info", "warn", "error"].map((m) => [m, mock.method(console, m, () => {})]));
});
afterEach(() => mock.restoreAll());
const alerts = () => spies.error.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes("[ALERT:error]"));

describe("the call token", () => {
  const data = { callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "moved", requestedByCallId: OWNER_CALL, phoneNumberId: NUMBER_ID };

  it("round-trips ids only — no name or number ever rides in a URL", () => {
    const token = cc.mintCustomerCallToken(data, SECRET, { now: () => NOW });
    const payload = cc.verifyCustomerCallToken(token, SECRET, { now: () => NOW });
    assert.deepEqual(payload, { v: 1, ...data, exp: NOW + cc.TOKEN_TTL_MS });
    assert.equal(cc.TOKEN_TTL_MS, 15 * 60 * 1000);
    assert.doesNotMatch(Buffer.from(token.split(".")[0], "base64url").toString(), /\+61|Bob|412345678/);
  });

  it("refuses a tampered payload, a wrong secret, an expired token and anything not shaped like one", () => {
    const token = cc.mintCustomerCallToken(data, SECRET, { now: () => NOW });
    const [b64, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b64, "base64url").toString()), organizationId: DEMO_ORG })).toString("base64url");
    assert.equal(cc.verifyCustomerCallToken(`${forged}.${mac}`, SECRET, { now: () => NOW }), null);
    assert.equal(cc.verifyCustomerCallToken(token, "other-secret", { now: () => NOW }), null);
    assert.equal(cc.verifyCustomerCallToken(token, SECRET, { now: () => NOW + cc.TOKEN_TTL_MS + 1 }), null);
    assert.notEqual(cc.verifyCustomerCallToken(token, SECRET, { now: () => NOW + cc.TOKEN_TTL_MS }), null, "valid up to its expiry");
    for (const bad of [null, 42, "", "a.b.c", `${b64}.`, `.${mac}`, token + "x"]) {
      assert.equal(cc.verifyCustomerCallToken(bad, SECRET, { now: () => NOW }), null, String(bad));
    }
    assert.equal(cc.verifyCustomerCallToken(token, "", { now: () => NOW }), null, "an empty secret verifies nothing");
    assert.equal(cc.verifyCustomerCallToken(token, undefined, { now: () => NOW }), null);
  });

  it("refuses a correctly signed token whose fields are wrong (version, ids, purpose)", () => {
    const crypto = require("crypto");
    const sign = (payload) => {
      const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${b64}.${crypto.createHmac("sha256", SECRET).update(`cc.${b64}`).digest("base64url")}`;
    };
    const good = { v: 1, ...data, exp: NOW + 1000 };
    assert.notEqual(cc.verifyCustomerCallToken(sign(good), SECRET, { now: () => NOW }), null, "the signer matches");
    assert.equal(cc.verifyCustomerCallToken(sign({ ...good, v: 2 }), SECRET, { now: () => NOW }), null);
    assert.equal(cc.verifyCustomerCallToken(sign({ ...good, callId: "not-a-uuid" }), SECRET, { now: () => NOW }), null);
    assert.equal(cc.verifyCustomerCallToken(sign({ ...good, purpose: "sell_them_something" }), SECRET, { now: () => NOW }), null);
    assert.equal(cc.verifyCustomerCallToken(sign({ ...good, exp: "never" }), SECRET, { now: () => NOW }), null);
    // The MAC is domain-separated: a bare HMAC of the payload (another use of the secret) doesn't verify.
    const b64 = Buffer.from(JSON.stringify(good)).toString("base64url");
    const bare = crypto.createHmac("sha256", SECRET).update(b64).digest("base64url");
    assert.equal(cc.verifyCustomerCallToken(`${b64}.${bare}`, SECRET, { now: () => NOW }), null);
  });
});

describe("calling hours and the booking's own number", () => {
  const at = (iso) => Date.parse(iso);
  it("8:00 to 20:00 org-local, the hour the call is placed", () => {
    // Sydney is UTC+11 in late October.
    assert.equal(cc.withinCallingHours(at("2026-10-26T20:59:00Z"), "Australia/Sydney"), false, "07:59");
    assert.equal(cc.withinCallingHours(at("2026-10-26T21:00:00Z"), "Australia/Sydney"), true, "08:00");
    assert.equal(cc.withinCallingHours(at("2026-10-27T08:59:00Z"), "Australia/Sydney"), true, "19:59");
    assert.equal(cc.withinCallingHours(at("2026-10-27T09:00:00Z"), "Australia/Sydney"), false, "20:00");
    assert.equal(cc.withinCallingHours(at("2026-10-27T15:00:00Z"), "Australia/Sydney"), false, "02:00");
    // Perth is UTC+8: 14:00Z is 22:00 there, while Sydney is already past midnight.
    assert.equal(cc.withinCallingHours(at("2026-10-27T05:00:00Z"), "Australia/Perth"), true, "13:00 Perth");
    assert.equal(cc.withinCallingHours(at("2026-10-27T13:00:00Z"), "Australia/Perth"), false, "21:00 Perth");
  });

  it("a zone Intl can't use (or none) means Sydney, never the server's UTC", () => {
    const sydney9am = at("2026-10-26T22:00:00Z"); // 09:00 Sydney, 22:00 UTC
    assert.equal(cc.withinCallingHours(sydney9am, "AEST"), true);
    assert.equal(cc.withinCallingHours(sydney9am, null), true);
    assert.equal(cc.withinCallingHours(at("2026-10-27T10:00:00Z"), "Not/AZone"), false, "21:00 Sydney");
  });

  it("matches the booking's stored number exactly, as AU E.164, whatever its format", () => {
    for (const stored of ["0412 345 678", "+61 412 345 678", "(04) 1234 5678", "412345678", "+61412345678", "+61 (0) 412 345 678", "+610412345678"]) {
      assert.equal(cc.matchesBookingPhone(PHONE, stored), true, stored);
    }
    assert.equal(cc.matchesBookingPhone(PHONE, "0412 345 679"), false);
    assert.equal(cc.matchesBookingPhone(PHONE, "345 678"), false, "too short");
    assert.equal(cc.matchesBookingPhone(PHONE, null), false);
    assert.equal(cc.matchesBookingPhone("+614", "0412 345 678"), false);
    // Security lens H2: a US number ending in the same nine digits is not this mobile.
    assert.equal(cc.matchesBookingPhone(PHONE, "+1 241 234 5678"), false);
    assert.equal(cc.matchesBookingPhone(PHONE, "+1 (412) 345-678"), false);
  });

  it("auE164Of: a stored AU number in E.164, or null for any other plan", () => {
    assert.equal(cc.auE164Of("(02) 9876 5432"), "+61298765432");
    assert.equal(cc.auE164Of("298765432"), "+61298765432");
    assert.equal(cc.auE164Of("+61 (0)2 9876 5432"), "+61298765432");
    for (const bad of ["+1 241 234 5678", "1300 123 456", "512345678", "", null, 42, "0061 412 345 678"]) assert.equal(cc.auE164Of(bad), null, String(bad));
  });
});

describe("parseTimeWindow (find_new_time's window — structured, never free text)", () => {
  it("dates and a time of day, each checked; a window that constrains nothing is none", () => {
    assert.deepEqual(cc.parseTimeWindow({ earliest: "2026-11-02", latest: "2026-11-06", timeOfDay: "morning" }), { window: { earliest: "2026-11-02", latest: "2026-11-06", timeOfDay: "morning" } });
    assert.deepEqual(cc.parseTimeWindow({ earliest: "2026-11-02" }), { window: { earliest: "2026-11-02", latest: null, timeOfDay: "any" } });
    assert.deepEqual(cc.parseTimeWindow({ timeOfDay: "evening" }), { window: { earliest: null, latest: null, timeOfDay: "evening" } });
    assert.deepEqual(cc.parseTimeWindow(undefined), { window: null });
    assert.deepEqual(cc.parseTimeWindow(null), { window: null });
    assert.deepEqual(cc.parseTimeWindow({}), { window: null });
    assert.deepEqual(cc.parseTimeWindow({ timeOfDay: "any" }), { window: null });
  });
  it("anything malformed is refused whole, never half-used", () => {
    for (const bad of [
      { earliest: "next week" },
      { earliest: "2026-02-30" },
      { latest: "2026-11-06T09:00" },
      { timeOfDay: "lunchtime" },
      { earliest: "2026-11-06", latest: "2026-11-02" },
      { earliest: 20261102 },
      "next week, mornings",
      ["2026-11-02"],
    ]) {
      assert.equal(cc.parseTimeWindow(bad), null, JSON.stringify(bad));
    }
  });
});

describe("twilioErrorSummary", () => {
  it("a Twilio error's code and status, never its message (it can carry the number dialled)", () => {
    const err = Object.assign(new Error("Account not authorized to call +61412345678"), { code: 21215, status: 400 });
    assert.equal(cc.twilioErrorSummary(err), "code=21215 status=400");
    assert.equal(cc.twilioErrorSummary(new Error("boom +61412345678")), "code=none status=none");
    assert.equal(cc.twilioErrorSummary(null), "code=none status=none");
  });
});

describe("checkCustomerCall", () => {
  it("passes with everything in place, and hands back what placing the call needs", async () => {
    const sb = fakeSupabase(responder(world()));
    const r = await cc.checkCustomerCall(req(), "check", checkDeps(sb));
    assert.deepEqual(r, {
      ok: true,
      plan: {
        organizationId: ORG,
        orgName: "Bob's Plumbing",
        timezone: "Australia/Sydney",
        purpose: "confirm",
        phone: PHONE,
        requestedByCallId: OWNER_CALL,
        window: null,
        appointment: { id: APPT, status: "confirmed", start_time: FUTURE },
        fromNumber: { id: NUMBER_ID, phone_number: "+61257015064", assistant_id: ASSISTANT },
      },
    });
  });

  it("is off unless the Fly flag is exactly 'true' — and asks the database nothing", async () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      const sb = fakeSupabase(responder(world()));
      const r = await cc.checkCustomerCall(req(), "check", checkDeps(sb, { env: { OWNER_CUSTOMER_CALLS_ENABLED: value } }));
      assert.deepEqual(r, { ok: false, reason: "calls_disabled" }, String(value));
      assert.equal(sb.queries.length, 0);
    }
  });

  it("never without a Gemini Live session to run it", async () => {
    const sb = fakeSupabase(responder(world()));
    const r = await cc.checkCustomerCall(req(), "check", checkDeps(sb, { pipelineAvailable: () => false }));
    assert.deepEqual(r, { ok: false, reason: "pipeline_unavailable" });
  });

  it("refuses a malformed request before any query", async () => {
    const bad = [
      req({ organizationId: "x" }),
      req({ appointmentId: undefined }),
      req({ requestedByCallId: "' or 1=1" }),
      req({ purpose: "survey" }),
      req({ phone: 61412345678 }),
      null,
    ];
    for (const r of bad) {
      const sb = fakeSupabase(responder(world()));
      assert.deepEqual(await cc.checkCustomerCall(r, "check", checkDeps(sb)), { ok: false, reason: "invalid_request" });
      assert.equal(sb.queries.length, 0);
    }
  });

  it("find_new_time with a malformed window is invalid; other purposes ignore a window", async () => {
    const sb = fakeSupabase(responder(world()));
    assert.deepEqual(await cc.checkCustomerCall(req({ purpose: "find_new_time", window: { earliest: "soon" } }), "check", checkDeps(sb)), { ok: false, reason: "invalid_request" });
    assert.equal(sb.queries.length, 0);
    const ok = await cc.checkCustomerCall(req({ purpose: "find_new_time", window: { earliest: "2026-11-02", timeOfDay: "morning" } }), "check", checkDeps(fakeSupabase(responder(world()))));
    assert.deepEqual(ok.plan.window, { earliest: "2026-11-02", latest: null, timeOfDay: "morning" });
    const confirm = await cc.checkCustomerCall(req({ purpose: "confirm", window: { earliest: "soon" } }), "check", checkDeps(fakeSupabase(responder(world()))));
    assert.equal(confirm.ok, true);
    assert.equal(confirm.plan.window, null);
  });

  it("never from the demo org, and only to AU numbers we may ring (mobiles and landlines)", async () => {
    const sb = fakeSupabase(responder(world()));
    assert.deepEqual(await cc.checkCustomerCall(req({ organizationId: DEMO_ORG }), "check", checkDeps(sb)), { ok: false, reason: "demo_org" });
    for (const phone of ["+15551234567", "+447911123456", "+611300123456", "+61512345678", "0412345678", "+6141234567"]) {
      assert.deepEqual(await cc.checkCustomerCall(req({ phone }), "check", checkDeps(sb)), { ok: false, reason: "not_au" }, phone);
    }
    assert.equal(sb.queries.length, 0);
    const landline = fakeSupabase(responder(world({ appt: { ...world().appt, attendee_phone: "(02) 9876 5432" } })));
    assert.equal((await cc.checkCustomerCall(req({ phone: "+61298765432" }), "check", checkDeps(landline))).ok, true, "a landline can be called (it can't be texted)");
  });

  it("only on an owner's request: the session must be this org's owner call", async () => {
    const cases = [
      [{ ownerCall: null }, "not_owner_session"],
      [{ ownerCall: { id: OWNER_CALL, metadata: { call_type: "customer_notify" } } }, "not_owner_session"],
      [{ ownerCall: { id: OWNER_CALL, metadata: null } }, "not_owner_session"],
      [{ ownerCallError: { message: "boom" } }, "check_failed"],
    ];
    for (const [over, reason] of cases) {
      const sb = fakeSupabase(responder(world(over)));
      assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason });
    }
    const sb = fakeSupabase(responder(world()));
    await cc.checkCustomerCall(req(), "check", checkDeps(sb));
    const owner = sb.queries[0];
    assert.ok(has(owner, "eq", "id", OWNER_CALL) && has(owner, "eq", "organization_id", ORG), "org-scoped: another org's owner call doesn't count");
  });

  it("an Australian org only, and a missing or unreadable org means no call", async () => {
    for (const [over, reason] of [
      [{ org: { ...world().org, country: "US" } }, "not_au"],
      [{ org: { ...world().org, country: null } }, "not_au"],
      [{ org: null }, "not_found"],
      [{ orgError: { message: "x" } }, "check_failed"],
    ]) {
      const sb = fakeSupabase(responder(world(over)));
      assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason });
    }
    const lower = fakeSupabase(responder(world({ org: { ...world().org, country: "au" } })));
    assert.equal((await cc.checkCustomerCall(req(), "check", checkDeps(lower))).ok, true);
  });

  it("the booking must be the org's, still ahead, and the number rung its own", async () => {
    const appt = world().appt;
    for (const [over, reason] of [
      [{ appt: null }, "not_found"],
      [{ apptError: { message: "x" } }, "check_failed"],
      [{ appt: { ...appt, start_time: "2026-10-27T02:00:00Z" } }, "wrong_state"],
      [{ appt: { ...appt, start_time: "garbage" } }, "wrong_state"],
      [{ appt: { ...appt, attendee_phone: "0499 999 999" } }, "number_mismatch"],
      [{ appt: { ...appt, attendee_phone: null } }, "number_mismatch"],
    ]) {
      const sb = fakeSupabase(responder(world(over)));
      assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason });
    }
    const sb = fakeSupabase(responder(world()));
    await cc.checkCustomerCall(req(), "check", checkDeps(sb));
    const q = sb.queries.find((x) => x.table === "appointments");
    assert.ok(has(q, "eq", "id", APPT) && has(q, "eq", "organization_id", ORG));
  });

  it("the booking's state fits the purpose and the phase", async () => {
    const run = async (purpose, phase, status) => {
      const sb = fakeSupabase(responder(world({ appt: { ...world().appt, status } })));
      return (await cc.checkCustomerCall(req({ purpose }), phase, checkDeps(sb))).ok;
    };
    // A cancel's read-back comes before the cancel; its call after it.
    assert.equal(await run("cancelled", "check", "confirmed"), true);
    assert.equal(await run("cancelled", "check", "cancelled"), false);
    assert.equal(await run("cancelled", "place", "cancelled"), true);
    assert.equal(await run("cancelled", "place", "confirmed"), false, "never 'it's been cancelled' about a live booking");
    for (const purpose of ["moved", "confirm", "find_new_time"]) {
      for (const phase of ["check", "place"]) {
        assert.equal(await run(purpose, phase, "confirmed"), true, `${purpose}/${phase}`);
        assert.equal(await run(purpose, phase, "pending"), true, `${purpose}/${phase}`);
        for (const status of ["cancelled", "rescheduled", "completed", "no_show"]) {
          assert.equal(await run(purpose, phase, status), false, `${purpose}/${phase}/${status}`);
        }
      }
    }
  });

  it("8:00 to 20:00 in the org's zone", async () => {
    const sb = fakeSupabase(responder(world()));
    const late = Date.parse("2026-10-27T09:30:00Z"); // 20:30 Sydney
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb, { now: () => late })), { ok: false, reason: "outside_hours" });
  });

  it("needs an active Twilio number with the assistant on, to ring from", async () => {
    for (const [over, reason] of [
      [{ numbers: [] }, "no_caller_number"],
      [{ numbers: null }, "no_caller_number"],
      [{ numbers: [{ id: NUMBER_ID, phone_number: null, assistant_id: ASSISTANT }] }, "no_caller_number"],
      [{ numbers: [{ id: NUMBER_ID, phone_number: "+61257015064", assistant_id: null }] }, "no_caller_number"],
      [{ numbersError: { message: "x" } }, "check_failed"],
    ]) {
      const sb = fakeSupabase(responder(world(over)));
      assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason });
    }
    const sb = fakeSupabase(responder(world()));
    await cc.checkCustomerCall(req(), "check", checkDeps(sb));
    const q = sb.queries.find((x) => x.table === "phone_numbers");
    for (const f of [
      ["eq", "organization_id", ORG],
      ["eq", "is_active", true],
      ["eq", "ai_enabled", true],
      ["eq", "telephony_provider", "twilio"],
      ["is", "released_at", null],
      ["not", "assistant_id", "is", null],
    ]) {
      assert.ok(has(q, ...f), JSON.stringify(f));
    }
  });

  it("caps over the last 24 hours: 20 per org, 2 per number, one per booking and purpose", async () => {
    const call = (over = {}) => ({ id: "c", caller_phone: "+61400000000", status: "completed", outcome: "answered", metadata: { notify: { appointment_id: "other", purpose: "confirm" } }, ...over });
    const sbCap = fakeSupabase(responder(world({ recent: Array.from({ length: 20 }, () => call()) })));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sbCap)), { ok: false, reason: "org_cap" });
    const sbUnder = fakeSupabase(responder(world({ recent: Array.from({ length: 19 }, () => call()) })));
    assert.equal((await cc.checkCustomerCall(req(), "check", checkDeps(sbUnder))).ok, true);

    const sbNum = fakeSupabase(responder(world({ recent: [call({ caller_phone: PHONE }), call({ caller_phone: PHONE })] })));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sbNum)), { ok: false, reason: "number_cap" });

    const about = { appointment_id: APPT, purpose: "confirm" };
    for (const over of [
      { status: "queued", outcome: null },
      { status: "ringing", outcome: null },
      { status: "in-progress", outcome: null },
      { status: "completed", outcome: "answered" },
      { status: "completed", outcome: "voicemail" },
    ]) {
      const sb = fakeSupabase(responder(world({ recent: [call({ ...over, metadata: { notify: about } })] })));
      assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason: "already_called" }, JSON.stringify(over));
    }
    // A call that never got through doesn't stop a retry; another purpose isn't "the same thing".
    for (const over of [
      { status: "no-answer", outcome: null, metadata: { notify: about } },
      { status: "busy", outcome: null, metadata: { notify: about } },
      { status: "failed", outcome: "failed", metadata: { notify: about } },
      { status: "completed", outcome: "answered", metadata: { notify: { appointment_id: APPT, purpose: "find_new_time" } } },
    ]) {
      const sb = fakeSupabase(responder(world({ recent: [call(over)] })));
      assert.equal((await cc.checkCustomerCall(req(), "check", checkDeps(sb))).ok, true, JSON.stringify(over));
    }

    const sb = fakeSupabase(responder(world()));
    await cc.checkCustomerCall(req(), "check", checkDeps(sb));
    const q = sb.queries.find((x) => x.table === "calls" && x.filters.some((f) => f[0] === "gte"));
    assert.ok(has(q, "eq", "organization_id", ORG) && has(q, "eq", "metadata->>call_type", "customer_notify"));
    assert.ok(has(q, "gte", "created_at", new Date(NOW - 86_400_000).toISOString()), "the last 24 hours");
    assert.ok(q.limitN > cc.ORG_CALLS_PER_DAY - 1, "reads enough rows to see the cap");
    const unreadable = fakeSupabase(responder(world({ recentError: { message: "x" } })));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(unreadable)), { ok: false, reason: "check_failed" });
  });

  it("never a number that asked not to be called again — at any time, for this org", async () => {
    const sb = fakeSupabase(responder(world({ dnc: [{ id: "x" }] })));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason: "do_not_call" });
    const q = sb.queries.find((x) => has(x, "eq", "metadata->notify->>outcome", "do_not_call"));
    assert.ok(has(q, "eq", "organization_id", ORG) && has(q, "eq", "caller_phone", PHONE));
    assert.ok(!q.filters.some((f) => f[0] === "gte"), "not limited to the last day");
    const unreadable = fakeSupabase(responder(world({ dncError: { message: "x" } })));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(unreadable)), { ok: false, reason: "check_failed" });
  });

  it("a query that throws is check_failed, never a call", async () => {
    const sb = fakeSupabase(() => new Error("socket hang up"));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason: "check_failed" });
  });
});

describe("placeCustomerCall", () => {
  function placeDeps(sb, over = {}) {
    const twilio = {
      created: [],
      cancelled: [],
      createCall: async (params) => { twilio.created.push(params); return { sid: "CA123" }; },
      cancelCall: async (sid) => { twilio.cancelled.push(sid); },
    };
    return { ...checkDeps(sb), twilio, publicUrl: "https://voice.example", secret: SECRET, randomUUID: () => CALL_ID, ...over };
  }

  it("re-checks at the moment of dialling, rings from the org's number with AMD and caps, then writes the row", async () => {
    const sb = fakeSupabase(responder(world({ appt: { ...world().appt, status: "cancelled" } }), (q) => (q.op === "insert" ? { data: null, error: null } : undefined)));
    const deps = placeDeps(sb);
    const r = await cc.placeCustomerCall(req({ purpose: "cancelled" }), deps);
    assert.deepEqual(r, { placed: true, callId: CALL_ID, callSid: "CA123" });

    assert.equal(deps.twilio.created.length, 1);
    const p = deps.twilio.created[0];
    assert.equal(p.to, PHONE);
    assert.equal(p.from, "+61257015064");
    assert.equal(p.machineDetection, "DetectMessageEnd");
    assert.equal(p.timeout, 25);
    assert.equal(p.timeLimit, 300, "a hard 5-minute ceiling on every call");
    assert.deepEqual(p.statusCallbackEvent, ["completed"]);
    const token = p.url.replace("https://voice.example/twiml/customer-call/", "");
    assert.equal(p.statusCallback, `https://voice.example/twiml/customer-call-status/${token}`);
    assert.deepEqual(cc.verifyCustomerCallToken(token, SECRET, { now: () => NOW }), {
      v: 1, callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "cancelled", requestedByCallId: OWNER_CALL, phoneNumberId: NUMBER_ID, exp: NOW + cc.TOKEN_TTL_MS,
    });

    const insert = sb.queries.find((q) => q.op === "insert");
    assert.deepEqual(insert.payload, {
      id: CALL_ID,
      organization_id: ORG,
      assistant_id: ASSISTANT,
      phone_number_id: NUMBER_ID,
      vapi_call_id: "sh_CA123",
      caller_phone: PHONE,
      direction: "outbound",
      status: "queued",
      metadata: {
        voice_provider: "self_hosted",
        call_type: "customer_notify",
        notify: { purpose: "cancelled", appointment_id: APPT, requested_by_call_id: OWNER_CALL },
      },
    });
  });

  it("finding a new time keeps its window (structured fields only) on the row; other purposes keep none", async () => {
    const insertOk = (q) => (q.op === "insert" ? { data: null, error: null } : undefined);
    const sb = fakeSupabase(responder(world(), insertOk));
    await cc.placeCustomerCall(req({ purpose: "find_new_time", window: { earliest: "2026-11-02", latest: "2026-11-06", timeOfDay: "morning" } }), placeDeps(sb));
    assert.deepEqual(sb.queries.find((q) => q.op === "insert").payload.metadata.notify.window, { earliest: "2026-11-02", latest: "2026-11-06", timeOfDay: "morning" });
    cc.resetPlacementGuards();
    const sb2 = fakeSupabase(responder(world(), insertOk));
    await cc.placeCustomerCall(req({ purpose: "confirm", window: { earliest: "2026-11-02" } }), placeDeps(sb2));
    assert.equal("window" in sb2.queries.find((q) => q.op === "insert").payload.metadata.notify, false);
    cc.resetPlacementGuards();
    const sb3 = fakeSupabase(responder(world(), insertOk));
    await cc.placeCustomerCall(req({ purpose: "find_new_time" }), placeDeps(sb3));
    assert.equal("window" in sb3.queries.find((q) => q.op === "insert").payload.metadata.notify, false, "no window, none kept");
  });

  it("a failed check rings nobody and passes its reason on", async () => {
    const sb = fakeSupabase(responder(world({ ownerCall: null })));
    const deps = placeDeps(sb);
    assert.deepEqual(await cc.placeCustomerCall(req(), deps), { placed: false, reason: "not_owner_session" });
    assert.equal(deps.twilio.created.length, 0);
  });

  it("a cancel's call needs the booking cancelled by now (phase 'place')", async () => {
    const sb = fakeSupabase(responder(world()));
    const deps = placeDeps(sb);
    assert.deepEqual(await cc.placeCustomerCall(req({ purpose: "cancelled" }), deps), { placed: false, reason: "wrong_state" });
    assert.equal(deps.twilio.created.length, 0);
  });

  it("Twilio refusing the call, or answering without a sid, is place_failed — with no row", async () => {
    for (const createCall of [async () => { throw new Error("21215 geo permission"); }, async () => ({}), async () => null]) {
      cc.resetPlacementGuards();
      const sb = fakeSupabase(responder(world()));
      const deps = placeDeps(sb);
      deps.twilio.createCall = createCall;
      assert.deepEqual(await cc.placeCustomerCall(req(), deps), { placed: false, reason: "place_failed" });
      assert.equal(sb.queries.filter((q) => q.op === "insert").length, 0);
    }
    assert.ok(alerts().length >= 3, "each one pages");
  });

  it("a Twilio refusal pages with its code — never its message, which can carry the customer's number", async () => {
    const sb = fakeSupabase(responder(world()));
    const deps = placeDeps(sb);
    deps.twilio.createCall = async () => { throw Object.assign(new Error("Account not authorized to call +61412345678"), { code: 21215, status: 400 }); };
    await cc.placeCustomerCall(req(), deps);
    const line = alerts().find((m) => m.includes("Twilio refused the call"));
    assert.ok(line.includes("code=21215 status=400"), line);
    const everything = spies.error.mock.calls.map((c) => c.arguments.map(String).join(" ")).join("\n");
    assert.ok(!everything.includes("412345678"), "no number in any error line");
  });

  it("a Twilio that doesn't answer in time is a refusal, never a hang (the placement sits inside the owner's tool call)", async () => {
    assert.equal(cc.TWILIO_CREATE_TIMEOUT_MS, 9000);
    const sb = fakeSupabase(responder(world()));
    const deps = placeDeps(sb, { createTimeoutMs: 20 });
    let accept;
    deps.twilio.createCall = () => new Promise((resolve) => { accept = resolve; });
    assert.deepEqual(await cc.placeCustomerCall(req(), deps), { placed: false, reason: "place_failed" });
    assert.equal(sb.queries.filter((q) => q.op === "insert").length, 0);
    assert.ok(alerts().some((m) => m.includes("Twilio refused the call")));
    // Twilio accepts it after all: that call has no row, so it is cancelled at once.
    accept({ sid: "CA-late" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(deps.twilio.cancelled, ["CA-late"]);
    assert.ok(alerts().some((m) => m.includes("after the timeout — cancelling it")));
  });

  it("a call accepted in time is never cancelled by the timeout", async () => {
    const sb = fakeSupabase(responder(world(), (q) => (q.op === "insert" ? { data: null, error: null } : undefined)));
    const deps = placeDeps(sb, { createTimeoutMs: 50 });
    assert.equal((await cc.placeCustomerCall(req(), deps)).placed, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(deps.twilio.cancelled, []);
  });

  it("a row that can't be written cancels the call before anyone answers it", async () => {
    const sb = fakeSupabase(responder(world(), (q) => (q.op === "insert" ? { data: null, error: { message: "unique violation" } } : undefined)));
    const deps = placeDeps(sb);
    assert.deepEqual(await cc.placeCustomerCall(req(), deps), { placed: false, reason: "place_failed" });
    assert.deepEqual(deps.twilio.cancelled, ["CA123"]);
    assert.ok(alerts().some((m) => m.includes("cancelling the call")));

    cc.resetPlacementGuards();
    const deps2 = placeDeps(fakeSupabase(responder(world(), (q) => (q.op === "insert" ? { data: null, error: { message: "x" } } : undefined))));
    deps2.twilio.cancelCall = async () => { throw new Error("already answered"); };
    assert.deepEqual(await cc.placeCustomerCall(req(), deps2), { placed: false, reason: "place_failed" });
    assert.ok(alerts().some((m) => m.includes("may ring with no record")));
  });

  it("without the public URL or the secret nothing rings", async () => {
    for (const over of [{ publicUrl: "" }, { secret: "" }]) {
      cc.resetPlacementGuards();
      const sb = fakeSupabase(responder(world()));
      const deps = placeDeps(sb, over);
      assert.deepEqual(await cc.placeCustomerCall(req(), deps), { placed: false, reason: "place_failed" });
      assert.equal(deps.twilio.created.length, 0);
    }
  });

  it("two placements for the same booking and purpose at once: only one rings", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const sb = fakeSupabase(responder(world(), (q) => (q.op === "insert" ? { data: null, error: null } : undefined)));
    const deps = placeDeps(sb);
    const slowCreate = deps.twilio.createCall;
    deps.twilio.createCall = async (p) => { await gate; return slowCreate(p); };
    const first = cc.placeCustomerCall(req(), deps);
    const second = await cc.placeCustomerCall(req(), deps);
    assert.deepEqual(second, { placed: false, reason: "already_called" });
    release();
    assert.equal((await first).placed, true);
    assert.equal(deps.twilio.created.length, 1);
    // Once settled, the key is free again (the database check takes over).
    const third = await cc.placeCustomerCall(req(), placeDeps(fakeSupabase(responder(world({ ownerCall: null })))));
    assert.deepEqual(third, { placed: false, reason: "not_owner_session" });
  });

  it("a process-wide backstop: after 30 placements in 10 minutes, every org is refused", async () => {
    const sb = fakeSupabase(responder(world(), (q) => (q.op === "insert" ? { data: null, error: null } : undefined)));
    for (let i = 0; i < cc.PLACEMENTS_PER_WINDOW; i++) {
      const r = await cc.placeCustomerCall(req({ appointmentId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}` }), placeDeps(fakeSupabase(responder(world({ appt: { ...world().appt, id: "x" } }), (q) => (q.op === "insert" ? { data: null, error: null } : undefined)))));
      assert.equal(r.placed, true, `placement ${i}`);
    }
    const deps = placeDeps(sb);
    assert.deepEqual(await cc.placeCustomerCall(req(), deps), { placed: false, reason: "busy" });
    assert.equal(deps.twilio.created.length, 0);
    assert.ok(alerts().some((m) => m.includes("backstop")));
    const later = placeDeps(sb, { now: () => NOW + 10 * 60 * 1000 + 1 });
    assert.equal((await cc.placeCustomerCall(req(), later)).placed, true, "the window slides");
  });
});

describe("handleCustomerCallTwiml", () => {
  const token = () => cc.mintCustomerCallToken({ callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "moved", requestedByCallId: OWNER_CALL, phoneNumberId: NUMBER_ID }, SECRET, { now: () => NOW });
  const row = { id: CALL_ID, vapi_call_id: "sh_CA123", caller_phone: PHONE, status: "queued", metadata: { voice_provider: "self_hosted", call_type: "customer_notify", notify: { purpose: "moved" } } };
  function twimlDeps(sb, over = {}) {
    const issued = [];
    return {
      issued,
      supabase: sb,
      secret: SECRET,
      env: { OWNER_CUSTOMER_CALLS_ENABLED: "true" },
      now: () => NOW,
      issueStreamToken: (...args) => { issued.push(args); return "stream&token"; },
      wsUrl: "wss://voice.example/ws/audio",
      escapeXml: (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
      ...over,
    };
  }
  const respondRow = (r = row, num = { id: NUMBER_ID, phone_number: "+61257015064" }, claim = { data: [{ id: CALL_ID }], error: null }) => (q) => {
    if (q.table === "calls" && q.op === "select") return { data: r, error: null };
    if (q.table === "phone_numbers") return { data: num, error: null };
    if (q.op === "update" && has(q, "eq", "status", "queued")) return claim;
    if (q.op === "update") return { data: null, error: null };
    return undefined;
  };

  it("a person (or a result AMD can't call) gets the conversation, streamed with the notify context", async () => {
    for (const answeredBy of ["human", "unknown", undefined, ""]) {
      const sb = fakeSupabase(respondRow());
      const deps = twimlDeps(sb);
      const xml = await cc.handleCustomerCallTwiml({ params: { token: token() }, body: { CallSid: "CA123", AnsweredBy: answeredBy } }, deps);
      assert.match(xml, /<Connect>\s*<Stream url="wss:\/\/voice\.example\/ws\/audio">\s*<Parameter name="auth_token" value="stream&amp;token" \/>/);
      assert.deepEqual(deps.issued, [[
        "+61257015064",
        PHONE,
        undefined,
        null,
        { notify: { callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "moved", requestedByCallId: OWNER_CALL, mode: "conversation", answeredBy: answeredBy || "unknown", window: null } },
      ]], String(answeredBy));
    }
  });

  it("the end of a voicemail greeting gets the voicemail", async () => {
    for (const answeredBy of ["machine_end_beep", "machine_end_silence", "machine_end_other"]) {
      const deps = twimlDeps(fakeSupabase(respondRow()));
      await cc.handleCustomerCallTwiml({ params: { token: token() }, body: { CallSid: "CA123", AnsweredBy: answeredBy } }, deps);
      assert.equal(deps.issued[0][4].notify.mode, "voicemail", answeredBy);
    }
  });

  it("a fax or anything else is hung up, and noted on the row", async () => {
    for (const answeredBy of ["fax", "machine_start", "something_new"]) {
      const sb = fakeSupabase(respondRow());
      const deps = twimlDeps(sb);
      const xml = await cc.handleCustomerCallTwiml({ params: { token: token() }, body: { CallSid: "CA123", AnsweredBy: answeredBy } }, deps);
      assert.equal(xml, cc.HANGUP_TWIML);
      assert.equal(deps.issued.length, 0);
      const upd = sb.queries.find((q) => q.op === "update");
      assert.equal(upd.payload.metadata.notify.answered_by, answeredBy);
      assert.equal(upd.payload.metadata.call_type, "customer_notify", "the rest of the metadata is kept");
    }
  });

  it("hangs up on a bad token, the flag off, a row that isn't this call's, or the org's number gone", async () => {
    const cases = [
      [{ params: { token: "nope" }, body: { CallSid: "CA123" } }, respondRow(), {}],
      [{ params: { token: token() }, body: { CallSid: "CA123" } }, respondRow(), { env: { OWNER_CUSTOMER_CALLS_ENABLED: "false" } }],
      [{ params: { token: token() }, body: { CallSid: "CA999" } }, respondRow(), {}],
      [{ params: { token: token() }, body: { CallSid: "CA123" } }, respondRow(null), {}],
      [{ params: { token: token() }, body: { CallSid: "CA123" } }, respondRow({ ...row, caller_phone: null }), {}],
      [{ params: { token: token() }, body: { CallSid: "CA123" } }, respondRow(row, null), {}],
      [{ params: { token: token() }, body: { CallSid: "CA123" } }, () => new Error("db down"), {}],
    ];
    for (const [request, respond, over] of cases) {
      const deps = twimlDeps(fakeSupabase(respond), over);
      assert.equal(await cc.handleCustomerCallTwiml(request, deps), cc.HANGUP_TWIML);
      assert.equal(deps.issued.length, 0);
    }
  });

  it("serves the stream ONCE: the row moves queued → ringing first, and a replayed fetch is hung up", async () => {
    const sb = fakeSupabase(respondRow());
    const deps = twimlDeps(sb);
    await cc.handleCustomerCallTwiml({ params: { token: token() }, body: { CallSid: "CA123", AnsweredBy: "human" } }, deps);
    const claim = sb.queries.find((q) => q.op === "update");
    assert.deepEqual(claim.payload, { status: "ringing" });
    assert.ok(has(claim, "eq", "id", CALL_ID) && has(claim, "eq", "status", "queued"));
    assert.equal(deps.issued.length, 1, "the stream token is minted after the claim");
    for (const lost of [{ data: [], error: null }, { data: null, error: { message: "x" } }]) {
      const replay = twimlDeps(fakeSupabase(respondRow(row, undefined, lost)));
      assert.equal(await cc.handleCustomerCallTwiml({ params: { token: token() }, body: { CallSid: "CA123", AnsweredBy: "human" } }, replay), cc.HANGUP_TWIML);
      assert.equal(replay.issued.length, 0, JSON.stringify(lost));
    }
  });

  it("find_new_time's window rides from this read of the row into the notify context (re-checked); never another purpose's", async () => {
    const tokenFor = (purpose) => cc.mintCustomerCallToken({ callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose, requestedByCallId: OWNER_CALL, phoneNumberId: NUMBER_ID }, SECRET, { now: () => NOW });
    const withWindow = (w) => ({ ...row, metadata: { ...row.metadata, notify: { purpose: "find_new_time", window: w } } });
    const run = async (purpose, r) => {
      const deps = twimlDeps(fakeSupabase(respondRow(r)));
      await cc.handleCustomerCallTwiml({ params: { token: tokenFor(purpose) }, body: { CallSid: "CA123", AnsweredBy: "human" } }, deps);
      return deps.issued[0][4].notify.window;
    };
    assert.deepEqual(await run("find_new_time", withWindow({ earliest: "2026-11-02", timeOfDay: "morning" })), { earliest: "2026-11-02", latest: null, timeOfDay: "morning" });
    assert.equal(await run("find_new_time", withWindow({ earliest: "next week" })), null, "a malformed window is none");
    assert.equal(await run("confirm", withWindow({ earliest: "2026-11-02" })), null);
  });

  it("reads the row and the number org-scoped", async () => {
    const sb = fakeSupabase(respondRow());
    await cc.handleCustomerCallTwiml({ params: { token: token() }, body: { CallSid: "CA123", AnsweredBy: "human" } }, twimlDeps(sb));
    const callQ = sb.queries.find((q) => q.table === "calls");
    const numQ = sb.queries.find((q) => q.table === "phone_numbers");
    assert.ok(has(callQ, "eq", "id", CALL_ID) && has(callQ, "eq", "organization_id", ORG));
    assert.ok(has(numQ, "eq", "id", NUMBER_ID) && has(numQ, "eq", "organization_id", ORG) && has(numQ, "eq", "is_active", true));
  });
});

describe("markCustomerCallStarted", () => {
  const notify = { callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "confirm", requestedByCallId: OWNER_CALL, mode: "conversation", answeredBy: "human" };
  it("moves only the row its TwiML fetch claimed (ringing) to in-progress, with the metadata it must keep", async () => {
    const sb = fakeSupabase((q) => (q.op === "update" ? { data: [{ id: CALL_ID }], error: null } : undefined));
    assert.deepEqual(await cc.markCustomerCallStarted(sb, notify, () => NOW), { marked: true, startedAt: new Date(NOW).toISOString(), reason: "ok" });
    const q = sb.queries[0];
    assert.ok(has(q, "eq", "id", CALL_ID) && has(q, "eq", "organization_id", ORG) && has(q, "eq", "status", "ringing"));
    assert.deepEqual(q.payload, {
      status: "in-progress",
      started_at: new Date(NOW).toISOString(),
      metadata: {
        voice_provider: "self_hosted",
        call_type: "customer_notify",
        notify: { purpose: "confirm", appointment_id: APPT, requested_by_call_id: OWNER_CALL, mode: "conversation", answered_by: "human", stream_started_at: new Date(NOW).toISOString() },
      },
    });
  });

  it("a row in another state is not_claimable; a failed write is db_error (never a throw) — the start time still comes back", async () => {
    const at = new Date(NOW).toISOString();
    assert.deepEqual(await cc.markCustomerCallStarted(fakeSupabase(() => ({ data: [], error: null })), notify, () => NOW), { marked: false, startedAt: at, reason: "not_claimable" });
    assert.deepEqual(await cc.markCustomerCallStarted(fakeSupabase(() => ({ data: null, error: { message: "x" } })), notify, () => NOW), { marked: false, startedAt: at, reason: "db_error" });
    assert.deepEqual(await cc.markCustomerCallStarted(fakeSupabase(() => new Error("down")), notify, () => NOW), { marked: false, startedAt: at, reason: "db_error" });
  });
});

describe("handleCustomerCallStatus", () => {
  const token = () => cc.mintCustomerCallToken({ callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "confirm", requestedByCallId: OWNER_CALL, phoneNumberId: NUMBER_ID }, SECRET, { now: () => NOW });
  const baseRow = {
    id: CALL_ID,
    organization_id: ORG,
    assistant_id: ASSISTANT,
    vapi_call_id: "sh_CA123",
    caller_phone: PHONE,
    status: "queued",
    metadata: { voice_provider: "self_hosted", call_type: "customer_notify", notify: { purpose: "confirm", appointment_id: APPT, requested_by_call_id: OWNER_CALL } },
  };
  function statusDeps(sb, over = {}) {
    const notified = [];
    return {
      notified,
      supabase: sb,
      secret: SECRET,
      now: () => NOW,
      hasLiveSession: () => false,
      notifyCallCompleted: async (p) => { notified.push(p); },
      ...over,
    };
  }
  const respondWith = (row, updated = [{ id: CALL_ID }], updErr = null) => (q) => {
    if (q.op === "select") return { data: row, error: null };
    if (q.op === "update") return { data: updErr ? null : updated, error: updErr };
    return undefined;
  };
  const body = (over = {}) => ({ CallSid: "CA123", CallStatus: "no-answer", CallDuration: "0", ...over });

  it("a call that never streamed is finished from Twilio's status, and call-completed runs once", async () => {
    const table = [
      ["no-answer", "no-answer", "missed"],
      ["busy", "busy", "missed"],
      ["failed", "failed", "failed"],
      ["canceled", "failed", "failed"],
      ["completed", "completed", "missed"],
    ];
    for (const [twilio, rowStatus, webhookStatus] of table) {
      const sb = fakeSupabase(respondWith(baseRow));
      const deps = statusDeps(sb);
      const r = await cc.handleCustomerCallStatus({ params: { token: token() }, body: body({ CallStatus: twilio, CallDuration: "4" }) }, deps);
      assert.deepEqual(r, { finalized: true, reason: `customer-call-${twilio}` });
      const upd = sb.queries.find((q) => q.op === "update");
      assert.ok(has(upd, "eq", "status", "queued"), "conditional: a session that started meanwhile wins");
      assert.equal(upd.payload.status, rowStatus);
      assert.equal(upd.payload.duration_seconds, 4);
      assert.equal(upd.payload.metadata.call_type, "customer_notify", "metadata kept");
      assert.equal(upd.payload.metadata.notify.purpose, "confirm");
      assert.equal(upd.payload.metadata.notify.twilio_status, twilio);
      assert.deepEqual(deps.notified, [{
        callId: CALL_ID,
        organizationId: ORG,
        assistantId: ASSISTANT,
        callerPhone: PHONE,
        status: webhookStatus,
        durationSeconds: 4,
        transcript: "",
        endedReason: `customer-call-${twilio}`,
        callType: "customer_notify",
      }], twilio);
    }
  });

  it("a call whose session is live here is left to that session", async () => {
    const sb = fakeSupabase(respondWith({ ...baseRow, status: "in-progress" }));
    const deps = statusDeps(sb, { hasLiveSession: (sid) => sid === "CA123" });
    assert.deepEqual(await cc.handleCustomerCallStatus({ params: { token: token() }, body: body({ CallStatus: "completed" }) }, deps), { finalized: false, reason: "live_session" });
    assert.equal(sb.queries.filter((q) => q.op === "update").length, 0);
    assert.equal(deps.notified.length, 0);
  });

  it("streamed but with no live session (a restart mid-call): finished as cut off, so the owner still hears", async () => {
    const sb = fakeSupabase(respondWith({ ...baseRow, status: "in-progress" }));
    const deps = statusDeps(sb);
    const r = await cc.handleCustomerCallStatus({ params: { token: token() }, body: body({ CallStatus: "completed", CallDuration: "95" }) }, deps);
    assert.deepEqual(r, { finalized: true, reason: "customer-call-cut-off" });
    const upd = sb.queries.find((q) => q.op === "update");
    assert.ok(has(upd, "eq", "status", "in-progress"));
    assert.equal(upd.payload.status, "completed");
    assert.equal(upd.payload.metadata.notify.cut_off, true);
    assert.equal(deps.notified[0].status, "completed");
  });

  it("a call its session already finished is left alone", async () => {
    for (const status of ["completed", "failed", "no-answer"]) {
      const sb = fakeSupabase(respondWith({ ...baseRow, status }));
      const deps = statusDeps(sb);
      assert.deepEqual(await cc.handleCustomerCallStatus({ params: { token: token() }, body: body({ CallStatus: "completed" }) }, deps), { finalized: false, reason: "already_finished" });
      assert.equal(deps.notified.length, 0);
    }
  });

  it("a lost race or a failed write sends no call-completed (the failed write pages)", async () => {
    const raced = statusDeps(fakeSupabase(respondWith(baseRow, [])));
    assert.deepEqual(await cc.handleCustomerCallStatus({ params: { token: token() }, body: body() }, raced), { finalized: false, reason: "raced" });
    assert.equal(raced.notified.length, 0);
    const failed = statusDeps(fakeSupabase(respondWith(baseRow, null, { message: "x" })));
    assert.deepEqual(await cc.handleCustomerCallStatus({ params: { token: token() }, body: body() }, failed), { finalized: false, reason: "update_failed" });
    assert.equal(failed.notified.length, 0);
    assert.ok(alerts().some((m) => m.includes("no outcome email")));
  });

  it("ignores a bad token, a non-terminal status, a missing row and another call's sid", async () => {
    const cases = [
      [{ params: { token: "bad" }, body: body() }, respondWith(baseRow), "invalid_token"],
      [{ params: { token: token() }, body: body({ CallStatus: "ringing" }) }, respondWith(baseRow), "not_terminal"],
      [{ params: { token: token() }, body: body({ CallStatus: "in-progress" }) }, respondWith(baseRow), "not_terminal"],
      [{ params: { token: token() }, body: body() }, respondWith(null), "no_row"],
      [{ params: { token: token() }, body: body({ CallSid: "CA999" }) }, respondWith(baseRow), "sid_mismatch"],
      [{ params: { token: token() }, body: body() }, () => ({ data: null, error: { message: "x" } }), "row_unreadable"],
      [{ params: { token: token() }, body: body() }, () => new Error("down"), "threw"],
    ];
    for (const [request, respond, reason] of cases) {
      const deps = statusDeps(fakeSupabase(respond));
      assert.deepEqual(await cc.handleCustomerCallStatus(request, deps), { finalized: false, reason });
      assert.equal(deps.notified.length, 0, reason);
    }
  });

  it("a duration Twilio didn't send (or sent badly) is 0, never NaN", async () => {
    for (const d of [undefined, "", "abc", "-5"]) {
      const sb = fakeSupabase(respondWith(baseRow));
      const deps = statusDeps(sb);
      await cc.handleCustomerCallStatus({ params: { token: token() }, body: body({ CallDuration: d }) }, deps);
      assert.equal(deps.notified[0].durationSeconds, 0, String(d));
    }
  });
});

describe("loadNotifyBriefing", () => {
  const notify = (purpose) => ({ callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose, requestedByCallId: OWNER_CALL, mode: "conversation", answeredBy: "human" });
  const PREV = "77777777-7777-4777-8777-777777777777";
  const responderFor = ({ appt, apptErr, prev, prevErr, row, rowErr } = {}) => (q) => {
    if (q.table === "appointments" && has(q, "eq", "id", APPT)) return { data: appt === undefined ? { id: APPT, attendee_name: "Jane Smith", start_time: FUTURE, rescheduled_from_id: PREV } : appt, error: apptErr || null };
    if (q.table === "appointments" && has(q, "eq", "id", PREV)) return { data: prev === undefined ? { start_time: "2026-10-28T22:00:00Z" } : prev, error: prevErr || null };
    if (q.table === "calls") return { data: row === undefined ? { metadata: { notify: { window: { earliest: "2026-11-02", latest: null, timeOfDay: "morning" } } } } : row, error: rowErr || null };
    return undefined;
  };

  it("the name and time on the booking, org-scoped; a move adds the time it came from", async () => {
    const sb = fakeSupabase(responderFor());
    assert.deepEqual(await cc.loadNotifyBriefing(sb, notify("moved")), { customerName: "Jane Smith", startTime: FUTURE, previousStartTime: "2026-10-28T22:00:00Z", window: null });
    for (const q of sb.queries) assert.ok(has(q, "eq", "organization_id", ORG), q.table);
    assert.deepEqual(await cc.loadNotifyBriefing(fakeSupabase(responderFor()), notify("confirm")), { customerName: "Jane Smith", startTime: FUTURE, previousStartTime: null, window: null }, "only a move reads the old leg");
  });

  it("the window comes with the notify context — the briefing never re-reads the call row for it", async () => {
    const window = { earliest: "2026-11-02", latest: null, timeOfDay: "morning" };
    const sb = fakeSupabase(responderFor());
    assert.deepEqual((await cc.loadNotifyBriefing(sb, { ...notify("find_new_time"), window })).window, window);
    assert.equal(sb.queries.some((q) => q.table === "calls"), false);
    assert.equal((await cc.loadNotifyBriefing(fakeSupabase(responderFor()), notify("find_new_time"))).window, null);
  });

  it("an unreadable old leg is only a nicety lost; an unreadable booking is null", async () => {
    assert.equal((await cc.loadNotifyBriefing(fakeSupabase(responderFor({ prevErr: { message: "x" } })), notify("moved"))).previousStartTime, null);
    assert.equal(await cc.loadNotifyBriefing(fakeSupabase(responderFor({ appt: null })), notify("moved")), null);
    assert.equal(await cc.loadNotifyBriefing(fakeSupabase(responderFor({ apptErr: { message: "x" } })), notify("moved")), null);
    assert.equal(await cc.loadNotifyBriefing(fakeSupabase(responderFor({ appt: { id: APPT, attendee_name: "J", start_time: null } })), notify("moved")), null);
    assert.equal(await cc.loadNotifyBriefing(fakeSupabase(() => new Error("down")), notify("moved")), null);
  });
});

describe("notifyMetadata", () => {
  it("keeps the request's ids, the window and how the call was answered, plus what the session adds", () => {
    const window = { earliest: "2026-11-02", latest: null, timeOfDay: "morning" };
    const n = { callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "find_new_time", requestedByCallId: OWNER_CALL, mode: "voicemail", answeredBy: "machine_end_beep", window };
    assert.deepEqual(cc.notifyMetadata(n, { outcome: "will_call_back" }), {
      purpose: "find_new_time", appointment_id: APPT, requested_by_call_id: OWNER_CALL, window, mode: "voicemail", answered_by: "machine_end_beep", outcome: "will_call_back",
    });
    assert.equal("window" in cc.notifyMetadata({ ...n, window: null }), false);
  });
});

describe("SCRUM-598 review fixes: the row stamps a session makes mid-call", () => {
  const notify = { callId: CALL_ID, organizationId: ORG, appointmentId: APPT, purpose: "confirm", requestedByCallId: OWNER_CALL, mode: "conversation", answeredBy: "human" };
  const rowWith = (metadata) => (q) => {
    if (q.op === "select") return { data: { id: CALL_ID, metadata }, error: null };
    if (q.op === "update") return { data: null, error: null };
    return undefined;
  };
  it("do_not_call is merged into the row's notify at once, keeping everything else (silent lens N3)", async () => {
    const sb = fakeSupabase(rowWith({ call_type: "customer_notify", notify: { purpose: "confirm", appointment_id: APPT } }));
    assert.equal(await cc.recordDoNotCall(sb, notify), true);
    const read = sb.queries.find((q) => q.op === "select");
    assert.ok(has(read, "eq", "id", CALL_ID) && has(read, "eq", "organization_id", ORG));
    assert.deepEqual(sb.queries.find((q) => q.op === "update").payload, { metadata: { call_type: "customer_notify", notify: { purpose: "confirm", appointment_id: APPT, outcome: "do_not_call" } } });
  });
  it("our own setup failure is said on the row (silent lens N4)", async () => {
    const sb = fakeSupabase(rowWith({ call_type: "customer_notify", notify: { purpose: "confirm" } }));
    assert.equal(await cc.markSetupFailed(sb, notify, "no-briefing"), true);
    assert.equal(sb.queries.find((q) => q.op === "update").payload.metadata.notify.setup_failed, "no-briefing");
  });
  it("a stamp that can't read or write pages and returns false (never throws)", async () => {
    for (const respond of [() => ({ data: null, error: { message: "x" } }), () => ({ data: null, error: null }), (q) => (q.op === "select" ? { data: { id: CALL_ID, metadata: {} }, error: null } : { data: null, error: { message: "x" } }), () => new Error("down")]) {
      assert.equal(await cc.recordDoNotCall(fakeSupabase(respond), notify), false);
    }
    assert.ok(alerts().length >= 4);
  });
});

describe("SCRUM-598 review fixes: a failed check read is logged with its stage (silent lens N5)", () => {
  it("names the read that failed", async () => {
    const sb = fakeSupabase(responder(world({ apptError: { message: "permission denied", code: "42501" } })));
    assert.deepEqual(await cc.checkCustomerCall(req(), "check", checkDeps(sb)), { ok: false, reason: "check_failed" });
    const lines = spies.error.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(lines.some((l) => l.includes("the booking read failed (code=42501): permission denied")), lines.join("\n"));
  });
});

describe("sweepStuckCustomerCalls (silent lens N1 — a lost status callback)", () => {
  const OLD = new Date(NOW - cc.STUCK_AFTER_MS - 60_000).toISOString();
  const stuck = (over = {}) => ({ id: CALL_ID, organization_id: ORG, assistant_id: ASSISTANT, vapi_call_id: "sh_CA123", caller_phone: PHONE, status: "queued", created_at: OLD, metadata: { call_type: "customer_notify", notify: { purpose: "confirm" } }, ...over });
  function sweepDeps(rows, over = {}) {
    const notified = [];
    const sb = fakeSupabase((q) => {
      if (q.op === "select") return { data: rows, error: null };
      if (q.op === "update") return { data: [{ id: CALL_ID }], error: null };
      return undefined;
    });
    return { notified, sb, deps: { supabase: sb, now: () => NOW, hasLiveSession: () => false, fetchTwilioCall: async () => ({ status: "no-answer", duration: "0" }), notifyCallCompleted: async (p) => { notified.push(p); }, ...over } };
  }

  it("finishes an open call from Twilio's own record of it, once, and runs call-completed", async () => {
    const { deps, sb, notified } = sweepDeps([stuck()]);
    assert.deepEqual(await cc.sweepStuckCustomerCalls(deps), { swept: 1, checked: 1 });
    const q = sb.queries.find((x) => x.op === "select");
    assert.ok(has(q, "eq", "metadata->>call_type", "customer_notify"));
    assert.ok(q.filters.some((f) => f[0] === "in" && f[1] === "status"));
    assert.ok(has(q, "lt", "created_at", new Date(NOW - cc.STUCK_AFTER_MS).toISOString()), "only calls past any possible end");
    const upd = sb.queries.find((x) => x.op === "update");
    assert.equal(upd.payload.status, "no-answer");
    assert.equal(upd.payload.metadata.notify.swept, true);
    assert.ok(has(upd, "eq", "status", "queued"), "conditional, like every finish");
    assert.equal(notified.length, 1);
    assert.equal(notified[0].status, "missed");
  });

  it("leaves a live session, a call Twilio says is still going, and (until 2 h) one Twilio can't tell us about", async () => {
    for (const over of [
      { hasLiveSession: () => true },
      { fetchTwilioCall: async () => ({ status: "in-progress" }) },
      { fetchTwilioCall: async () => { throw Object.assign(new Error("x +61412345678"), { code: 20404 }); } },
      { fetchTwilioCall: async () => null },
    ]) {
      const { deps, notified } = sweepDeps([stuck()], over);
      assert.equal((await cc.sweepStuckCustomerCalls(deps)).swept, 0);
      assert.equal(notified.length, 0);
    }
    const veryOld = new Date(NOW - cc.GIVE_UP_AFTER_MS - 60_000).toISOString();
    const { deps, sb, notified } = sweepDeps([stuck({ created_at: veryOld })], { fetchTwilioCall: async () => null });
    assert.equal((await cc.sweepStuckCustomerCalls(deps)).swept, 1, "after 2 hours it is finished as failed anyway");
    assert.equal(sb.queries.find((x) => x.op === "update").payload.metadata.notify.twilio_status, "unknown");
    assert.equal(notified[0].status, "failed");
  });

  it("an in-progress row with no live session is finished as cut off", async () => {
    const { deps, sb, notified } = sweepDeps([stuck({ status: "in-progress" })], { fetchTwilioCall: async () => ({ status: "completed", duration: "88" }) });
    await cc.sweepStuckCustomerCalls(deps);
    const upd = sb.queries.find((x) => x.op === "update");
    assert.equal(upd.payload.metadata.notify.cut_off, true);
    assert.equal(upd.payload.duration_seconds, 88);
    assert.equal(notified[0].status, "completed");
  });

  it("an unreadable list pages; it never throws", async () => {
    const sb = fakeSupabase(() => ({ data: null, error: { message: "x" } }));
    assert.deepEqual(await cc.sweepStuckCustomerCalls({ supabase: sb, hasLiveSession: () => false, fetchTwilioCall: async () => null, notifyCallCompleted: async () => {} }), { swept: 0, checked: 0 });
    assert.ok(alerts().some((m) => m.includes("sweep")));
  });
});
