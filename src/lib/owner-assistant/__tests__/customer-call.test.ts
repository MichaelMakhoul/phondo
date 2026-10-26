import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-598: the website's client for the voice server's customer-call endpoints.
// Every failure to reach the voice server is "no call" — and a placement that went
// out without an answer is "not sure", never "not placed" (the call may be ringing).
import {
  CALL_PURPOSES,
  VOICE_CALL_BLOCK_REASONS,
  callNote,
  callWhy,
  callablePhone,
  checkCustomerCall,
  placeCustomerCall,
  type CallBlockReason,
  type CustomerCallRequest,
} from "../customer-call";

const ORG = "11111111-2222-4333-a444-555555555555";
const APPT = "44444444-5555-4666-8777-888888888888";
const OWNER_CALL = "99999999-8888-4777-8666-555555555555";
const DEPS = { voiceServerUrl: "https://voice.example", internalSecret: "s3cret" };
const req = (over: Partial<CustomerCallRequest> = {}): CustomerCallRequest => ({
  organizationId: ORG, appointmentId: APPT, purpose: "confirm", phone: "0412 345 678", requestedByCallId: OWNER_CALL, ...over,
});
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("callablePhone", () => {
  it("an AU mobile or landline in any stored form becomes +61…; anything else is null", () => {
    for (const raw of ["0412 345 678", "+61 412 345 678", "+61 (0) 412 345 678", "(02) 9555 1234"]) expect(callablePhone(raw)).toMatch(/^\+61[23478]\d{8}$/);
    for (const raw of ["+1 555 123 4567", "1300 123 456", "13 12 34", "0512 345 678", "", null, undefined, "abc"]) expect(callablePhone(raw)).toBeNull();
  });
});

describe("checkCustomerCall", () => {
  it("asks the voice server with the internal secret, the normalised number and the request's ids", async () => {
    const fetch = vi.fn(async () => jsonResponse({ canCall: true }));
    expect(await checkCustomerCall(req(), { ...DEPS, fetch })).toEqual({ canCall: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://voice.example/internal/customer-call/check");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Internal-Secret"]).toBe("s3cret");
    expect(JSON.parse(String(init.body))).toEqual({ organizationId: ORG, appointmentId: APPT, purpose: "confirm", phone: "+61412345678", requestedByCallId: OWNER_CALL });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("the window rides only with find_new_time, as structured fields", async () => {
    const fetch = vi.fn(async () => jsonResponse({ canCall: true }));
    const window = { earliest: "2026-11-02", latest: null, timeOfDay: "morning" as const };
    await checkCustomerCall(req({ purpose: "find_new_time", window }), { ...DEPS, fetch });
    await checkCustomerCall(req({ purpose: "confirm", window }), { ...DEPS, fetch });
    expect(JSON.parse(String((fetch.mock.calls[0] as any)[1].body)).window).toEqual(window);
    expect("window" in JSON.parse(String((fetch.mock.calls[1] as any)[1].body))).toBe(false);
  });

  it("no number is no_number; a number we may not ring (overseas, 1300…) is not_callable_number — and the voice server isn't asked", async () => {
    const fetch = vi.fn();
    expect(await checkCustomerCall(req({ phone: "+1 555 123 4567" }), { ...DEPS, fetch: fetch as any })).toEqual({ canCall: false, reason: "not_callable_number" });
    expect(await checkCustomerCall(req({ phone: "1300 123 456" }), { ...DEPS, fetch: fetch as any })).toEqual({ canCall: false, reason: "not_callable_number" });
    expect(await checkCustomerCall(req({ phone: null }), { ...DEPS, fetch: fetch as any })).toEqual({ canCall: false, reason: "no_number" });
    expect(await checkCustomerCall(req({ phone: "  " }), { ...DEPS, fetch: fetch as any })).toEqual({ canCall: false, reason: "no_number" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the voice server's refusal comes through; an answer it doesn't know is check_failed", async () => {
    expect(await checkCustomerCall(req(), { ...DEPS, fetch: async () => jsonResponse({ canCall: false, reason: "outside_hours" }) })).toEqual({ canCall: false, reason: "outside_hours" });
    expect(await checkCustomerCall(req(), { ...DEPS, fetch: async () => jsonResponse({ canCall: false, reason: "made_up" }) })).toEqual({ canCall: false, reason: "check_failed" });
    expect(await checkCustomerCall(req(), { ...DEPS, fetch: async () => jsonResponse({ canCall: "yes" }) })).toEqual({ canCall: false, reason: "check_failed" });
  });

  it("unreachable, refused, unconfigured or a junk body: voice_unreachable (no call), logged", async () => {
    const cases: Array<Parameters<typeof checkCustomerCall>[1]> = [
      { ...DEPS, fetch: async () => { throw new Error("ECONNREFUSED"); } },
      { ...DEPS, fetch: async () => jsonResponse({ error: "Unauthorized" }, 401) },
      { ...DEPS, fetch: async () => jsonResponse({}, 503) },
      { ...DEPS, fetch: async () => new Response("not json", { status: 200 }) },
      { voiceServerUrl: "", internalSecret: "s3cret", fetch: vi.fn() as any },
      { voiceServerUrl: "https://voice.example", internalSecret: "", fetch: vi.fn() as any },
    ];
    for (const deps of cases) expect(await checkCustomerCall(req(), deps)).toEqual({ canCall: false, reason: "voice_unreachable" });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("placeCustomerCall", () => {
  it("placed: the call's id comes back", async () => {
    const fetch = vi.fn(async () => jsonResponse({ placed: true, callId: "c-1", callSid: "CA1" }));
    expect(await placeCustomerCall(req(), { ...DEPS, fetch })).toEqual({ placed: true, callId: "c-1" });
    expect((fetch.mock.calls[0] as any)[0]).toBe("https://voice.example/internal/customer-call");
  });

  it("a refusal keeps its reason; an unknown one is place_failed", async () => {
    expect(await placeCustomerCall(req(), { ...DEPS, fetch: async () => jsonResponse({ placed: false, reason: "do_not_call" }) })).toEqual({ placed: false, reason: "do_not_call" });
    expect(await placeCustomerCall(req(), { ...DEPS, fetch: async () => jsonResponse({ placed: false, reason: "??" }) })).toEqual({ placed: false, reason: "place_failed" });
  });

  it("sent but unanswered (timeout, dropped, 5xx, junk) or 'placed' without an id: place_unconfirmed — the call may be ringing", async () => {
    for (const fetch of [
      async () => { throw new Error("The operation was aborted due to timeout"); },
      async () => jsonResponse({}, 502),
      async () => new Response("<html>", { status: 200 }),
      async () => jsonResponse({ placed: true }),
    ]) {
      expect(await placeCustomerCall(req(), { ...DEPS, fetch: fetch as any })).toEqual({ placed: false, reason: "place_unconfirmed" });
    }
  });

  it("never sent (unconfigured) or refused outright (4xx): voice_unreachable — definitely no call", async () => {
    expect(await placeCustomerCall(req(), { voiceServerUrl: "", internalSecret: "", fetch: vi.fn() as any })).toEqual({ placed: false, reason: "voice_unreachable" });
    expect(await placeCustomerCall(req(), { ...DEPS, fetch: async () => jsonResponse({ error: "Unauthorized" }, 401) })).toEqual({ placed: false, reason: "voice_unreachable" });
  });

  it("no AU number: no_number, nothing sent", async () => {
    const fetch = vi.fn();
    expect(await placeCustomerCall(req({ phone: "" }), { ...DEPS, fetch: fetch as any })).toEqual({ placed: false, reason: "no_number" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the owner's words", () => {
  const ALL: CallBlockReason[] = [...VOICE_CALL_BLOCK_REASONS, "no_number", "not_callable_number", "voice_unreachable", "place_unconfirmed"];
  it("every refusal has a reason to say", () => {
    for (const r of ALL) expect(callWhy(r).length, r).toBeGreaterThan(5);
    expect(CALL_PURPOSES).toEqual(["cancelled", "moved", "confirm", "find_new_time"]);
  });
  it("the read-back notes only what the owner can act on — never a fault, never a switched-off feature", () => {
    const noted = ALL.filter((r) => callNote(r) !== null).sort();
    expect(noted).toEqual(["already_called", "do_not_call", "no_caller_number", "not_au", "not_callable_number", "number_cap", "org_cap", "outside_hours"]);
    expect(callNote("outside_hours")).toBe("I can't call them now: it's outside calling hours (8 am to 8 pm).");
  });
});
