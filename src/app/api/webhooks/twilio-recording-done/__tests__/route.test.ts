import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// SCRUM-545: the recording webhook had zero tests. It gates a Supabase write,
// so pin: signature/field guards, the non-completed ack (200 so Twilio stops
// retrying) + metadata merge, the https://api.twilio.com/ URL allowlist, and
// the transient(503)-vs-terminal(200) contract on store failures.

const h = vi.hoisted(() => ({
  sigValid: true,
  validateCalls: [] as any[],
  storeResult: { ok: true, callId: "c1" } as any,
  storeArgs: [] as any[],
  metaRow: { id: "call-1", metadata: { foo: "bar" } } as any,
  selectEq: null as any, // { col, val }
  selectThrows: null as any,
  metaUpdates: [] as any[], // { payload, col, val }
  sentry: [] as any[],
  // SCRUM-550: captures the fire-and-forget retranscribe trigger.
  afterWork: null as null | (() => Promise<unknown>),
  fetchCalls: [] as any[], // { url, init }
}));

vi.mock("twilio", () => ({
  default: {
    validateRequest: vi.fn((_token: string, _sig: string, _url: string, _params: any) => {
      h.validateCalls.push({ url: _url });
      return h.sigValid;
    }),
  },
}));

vi.mock("@/lib/call-recordings/download-and-store", () => ({
  downloadAndStoreRecording: vi.fn(async (args: any) => {
    h.storeArgs.push(args);
    return h.storeResult;
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            if (h.selectThrows) throw h.selectThrows;
            h.selectEq = { col, val };
            return { data: h.metaRow, error: null };
          },
        }),
      }),
      update: (payload: any) => ({
        eq: async (col: string, val: string) => {
          h.metaUpdates.push({ payload, col, val });
          return { error: null };
        },
      }),
    }),
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: any) => fn({ setTag: () => {}, setExtras: () => {} }),
  captureMessage: (msg: string, level?: any) => h.sentry.push({ kind: "message", msg, level }),
  captureException: (err: any) => h.sentry.push({ kind: "exception", err }),
}));

// SCRUM-550: capture the work fn instead of scheduling it, so tests can decide
// whether the trigger was registered and (optionally) drive it to assert fetch.
vi.mock("@/lib/utils/after-response", () => ({
  runAfterResponse: (work: () => Promise<unknown>) => {
    h.afterWork = work;
  },
}));

import { POST } from "../route";
import * as store from "@/lib/call-recordings/download-and-store";

function makeReq(params: Record<string, string>, sig = "sig") {
  const body = new URLSearchParams(params).toString();
  return new NextRequest("https://app.phondo.ai/api/webhooks/twilio-recording-done", {
    method: "POST",
    headers: {
      "x-twilio-signature": sig,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

const COMPLETED = {
  CallSid: "CA1",
  RecordingSid: "RE1",
  RecordingStatus: "completed",
  RecordingUrl: "https://api.twilio.com/2010/Accounts/AC/Recordings/RE1",
};

let origToken: string | undefined;
let origAppUrl: string | undefined;
let origVoiceUrl: string | undefined;
let origSecret: string | undefined;
let origRetranscribe: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  h.sigValid = true;
  h.validateCalls = [];
  h.storeResult = { ok: true, callId: "c1" };
  h.storeArgs = [];
  h.metaRow = { id: "call-1", metadata: { foo: "bar" } };
  h.selectEq = null;
  h.selectThrows = null;
  h.metaUpdates = [];
  h.sentry = [];
  h.afterWork = null;
  h.fetchCalls = [];
  origToken = process.env.TWILIO_AUTH_TOKEN;
  origAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  origVoiceUrl = process.env.VOICE_SERVER_PUBLIC_URL;
  origSecret = process.env.INTERNAL_API_SECRET;
  origRetranscribe = process.env.RETRANSCRIBE_ENABLED;
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
  // SCRUM-550: trigger is enabled by default (env present, flag unset==on).
  process.env.VOICE_SERVER_PUBLIC_URL = "https://voice.phondo.ai";
  process.env.INTERNAL_API_SECRET = "int_secret";
  delete process.env.RETRANSCRIBE_ENABLED;
  // Default: unset, so the signature is computed over req.url unless a test
  // opts in. Restored in afterEach.
  delete process.env.NEXT_PUBLIC_APP_URL;
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    h.fetchCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as any;
  }) as any;
});

function restoreEnv(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

afterEach(() => {
  process.env.TWILIO_AUTH_TOKEN = origToken;
  restoreEnv("NEXT_PUBLIC_APP_URL", origAppUrl);
  restoreEnv("VOICE_SERVER_PUBLIC_URL", origVoiceUrl);
  restoreEnv("INTERNAL_API_SECRET", origSecret);
  restoreEnv("RETRANSCRIBE_ENABLED", origRetranscribe);
});

describe("POST /api/webhooks/twilio-recording-done (SCRUM-545)", () => {
  it("returns 500 when TWILIO_AUTH_TOKEN is unset (never validates)", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(500);
    expect(h.validateCalls).toHaveLength(0);
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
  });

  it("returns 403 on invalid Twilio signature", async () => {
    h.sigValid = false;
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(403);
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
    expect(h.sentry.some((s) => s.level === "warning")).toBe(true);
  });

  // The signature is validated over the PUBLIC-facing URL. Behind Vercel,
  // req.url reflects the internal origin, so NEXT_PUBLIC_APP_URL must be used
  // to reconstruct it — if this regresses, EVERY recording webhook 403s and
  // recordings silently stop. These pin that reconstruction (route.ts:15-17).
  it("recomputes the signed URL over NEXT_PUBLIC_APP_URL + pathname + search (Vercel origin fix)", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://real.phondo.ai";
    const req = new NextRequest(
      "https://phondo-internal.vercel.app/api/webhooks/twilio-recording-done?x=1",
      {
        method: "POST",
        headers: {
          "x-twilio-signature": "sig",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(COMPLETED).toString(),
      },
    );
    await POST(req);
    expect(h.validateCalls).toHaveLength(1);
    // public origin + original pathname AND query — never the internal origin.
    expect(h.validateCalls[0].url).toBe(
      "https://real.phondo.ai/api/webhooks/twilio-recording-done?x=1",
    );
  });

  it("falls back to req.url for the signature when NEXT_PUBLIC_APP_URL is unset", async () => {
    await POST(makeReq(COMPLETED));
    expect(h.validateCalls[0].url).toBe(
      "https://app.phondo.ai/api/webhooks/twilio-recording-done",
    );
  });

  it("returns 400 when CallSid is missing", async () => {
    const { CallSid, ...rest } = COMPLETED;
    void CallSid;
    const res = await POST(makeReq(rest));
    expect(res.status).toBe(400);
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
  });

  it("non-completed status acks 200 and merges recording_status into metadata (keyed by sh_${CallSid})", async () => {
    const res = await POST(makeReq({ ...COMPLETED, RecordingStatus: "failed" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: "failed" });
    // never attempts to fetch/store a failed recording
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
    // looked the row up by the sh_ prefix
    expect(h.selectEq).toEqual({ col: "vapi_call_id", val: "sh_CA1" });
    // merged (not clobbered) — foo preserved, recording_status added
    expect(h.metaUpdates).toHaveLength(1);
    expect(h.metaUpdates[0].payload.metadata).toMatchObject({
      foo: "bar",
      recording_status: "failed",
    });
    expect(h.metaUpdates[0].payload.metadata.recording_failed_at).toEqual(expect.any(String));
    expect(h.metaUpdates[0]).toMatchObject({ col: "id", val: "call-1" });
  });

  it("non-completed status still acks 200 even if the metadata update throws (Twilio must not retry forever)", async () => {
    h.selectThrows = new Error("db down");
    const res = await POST(makeReq({ ...COMPLETED, RecordingStatus: "absent" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, ignored: "absent" });
    expect(h.metaUpdates).toHaveLength(0);
    expect(h.sentry.some((s) => s.kind === "exception")).toBe(true);
  });

  it("non-completed status with no matching call row acks 200 without updating", async () => {
    h.metaRow = null;
    const res = await POST(makeReq({ ...COMPLETED, RecordingStatus: "failed" }));
    expect(res.status).toBe(200);
    expect(h.metaUpdates).toHaveLength(0);
  });

  it("returns 400 when a completed event is missing RecordingSid", async () => {
    const { RecordingSid, ...rest } = COMPLETED;
    void RecordingSid;
    const res = await POST(makeReq(rest));
    expect(res.status).toBe(400);
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
  });

  it("returns 400 when a completed event is missing RecordingUrl (guards the !RecordingUrl half)", async () => {
    // Without this branch, RecordingUrl.startsWith(...) at route.ts:97 throws
    // → a 500 instead of a clean 400.
    const { RecordingUrl, ...rest } = COMPLETED;
    void RecordingUrl;
    const res = await POST(makeReq(rest));
    expect(res.status).toBe(400);
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
  });

  it("returns 400 and does NOT fetch when RecordingUrl is off the api.twilio.com allowlist (SSRF guard)", async () => {
    const res = await POST(makeReq({ ...COMPLETED, RecordingUrl: "https://evil.example.com/RE1" }));
    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toMatch(/invalid recording url/);
    expect(store.downloadAndStoreRecording).not.toHaveBeenCalled();
    expect(h.sentry.some((s) => s.level === "warning")).toBe(true);
  });

  it("completed happy path stores the .mp3 URL and returns the callId", async () => {
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, callId: "c1" });
    expect(h.storeArgs).toEqual([
      {
        provider: "twilio",
        recordingUrl: "https://api.twilio.com/2010/Accounts/AC/Recordings/RE1.mp3",
        recordingSid: "RE1",
        callSid: "CA1",
      },
    ]);
  });

  it("transient store failure returns 503 so Twilio retries", async () => {
    h.storeResult = { ok: false, error: "Upload failed: timeout", transient: true };
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(503);
    expect(h.sentry.some((s) => s.level === "error")).toBe(true);
  });

  it("terminal store failure returns 200 to stop the retry loop", async () => {
    h.storeResult = { ok: false, error: "recording_sid conflict", transient: false };
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "recording_sid conflict" });
  });
});

describe("POST /api/webhooks/twilio-recording-done — retranscribe trigger (SCRUM-550)", () => {
  it("registers a fire-and-forget retranscribe call after a successful store; running it POSTs to the voice server", async () => {
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(200);
    expect(typeof h.afterWork).toBe("function");
    // nothing fetched until the after-response work actually runs
    expect(h.fetchCalls).toHaveLength(0);
    await h.afterWork!();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe("https://voice.phondo.ai/internal/retranscribe");
    expect(h.fetchCalls[0].init.method).toBe("POST");
    expect(h.fetchCalls[0].init.headers["x-internal-secret"]).toBe("int_secret");
    // Must be the resolved DB UUID (storeResult.callId="c1"), NOT the Twilio
    // CallSid ("CA1"): the voice-server handler looks up calls by primary key.
    // Passing CallSid would silently no-op every re-transcription (no row).
    expect(JSON.parse(h.fetchCalls[0].init.body)).toEqual({ callId: "c1" });
    expect(JSON.parse(h.fetchCalls[0].init.body).callId).not.toBe("CA1");
  });

  it("does NOT trigger when the store failed (transient)", async () => {
    h.storeResult = { ok: false, error: "x", transient: true };
    await POST(makeReq(COMPLETED));
    expect(h.afterWork).toBeNull();
  });

  it("does NOT trigger when the store failed (terminal)", async () => {
    h.storeResult = { ok: false, error: "x", transient: false };
    await POST(makeReq(COMPLETED));
    expect(h.afterWork).toBeNull();
  });

  it("does NOT trigger when RETRANSCRIBE_ENABLED=false (kill-switch) — still 200s", async () => {
    process.env.RETRANSCRIBE_ENABLED = "false";
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(200);
    expect(h.afterWork).toBeNull();
  });

  it("does NOT trigger when VOICE_SERVER_PUBLIC_URL is unset", async () => {
    delete process.env.VOICE_SERVER_PUBLIC_URL;
    const res = await POST(makeReq(COMPLETED));
    expect(res.status).toBe(200);
    expect(h.afterWork).toBeNull();
  });

  it("a failing trigger fetch never escapes, but IS captured to Sentry (voice server unreachable)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("voice server down");
    }) as any;
    await POST(makeReq(COMPLETED));
    expect(typeof h.afterWork).toBe("function");
    await expect(h.afterWork!()).resolves.toBeUndefined();
    // A globally-unreachable voice server silently disables re-transcription —
    // the owner must be paged, not left blind.
    const exc = h.sentry.find((s) => s.kind === "exception");
    expect(exc).toBeTruthy();
    expect(String(exc.err)).toContain("voice server down");
  });

  it("captures a Sentry warning when the trigger responds non-ok (e.g. 401 INTERNAL_API_SECRET drift)", async () => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      h.fetchCalls.push({ url, init });
      return { ok: false, status: 401, json: async () => ({}), text: async () => "" } as any;
    }) as any;
    await POST(makeReq(COMPLETED));
    await h.afterWork!();
    expect(h.fetchCalls).toHaveLength(1);
    // A non-ok response RESOLVES (no throw) — without an explicit check it would
    // be fully silent. Pin that it escalates to Sentry with the status.
    const msg = h.sentry.find((s) => s.kind === "message");
    expect(msg).toBeTruthy();
    expect(msg.level).toBe("warning");
    expect(String(msg.msg)).toContain("401");
  });
});
