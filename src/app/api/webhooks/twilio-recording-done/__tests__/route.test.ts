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
  origToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
});

afterEach(() => {
  process.env.TWILIO_AUTH_TOKEN = origToken;
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
