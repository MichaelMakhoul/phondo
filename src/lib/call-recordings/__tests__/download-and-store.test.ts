import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-545: pin the recording reconciliation invariant that the voice-server
// side depends on. The kill-switch raw-URL fallback is guarded by
// `.is('recording_storage_path', null)`, which is only meaningful because THIS
// function sets recording_storage_path AND nulls recording_url in the same
// update, keyed by `sh_${CallSid}`. If the update triple or the sh_ prefix
// ever drifts, the voice-server tests stay green — so we lock it here.

const h = vi.hoisted(() => ({
  // queue of {data,error} returned per select().eq().maybeSingle() attempt.
  lookup: [] as any[],
  lookupKeys: [] as string[], // captured vapi_call_id lookup values
  uploadError: null as any,
  updateError: null as any,
  uploads: [] as any[], // { path, audio, opts }
  updates: [] as any[], // { table, payload, col, val }
  // fetch behaviour
  fetchBuffer: new ArrayBuffer(0) as ArrayBuffer,
  fetchResponse: { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } as any,
  fetchThrows: null as any,
  fetchCalls: [] as any[], // { url, headers }
  sentry: [] as any[], // { kind, msg?, level?, err? }
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            if (col === "vapi_call_id") h.lookupKeys.push(val);
            return h.lookup.length ? h.lookup.shift() : { data: null, error: null };
          },
        }),
      }),
      update: (payload: any) => ({
        eq: async (col: string, val: string) => {
          h.updates.push({ table, payload, col, val });
          return { error: h.updateError };
        },
      }),
    }),
    storage: {
      from: (_bucket: string) => ({
        upload: async (path: string, audio: any, opts: any) => {
          h.uploads.push({ path, audio, opts });
          return { error: h.uploadError };
        },
      }),
    },
  }),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: any) => fn({ setTag: () => {}, setExtras: () => {} }),
  captureMessage: (msg: string, level?: any) => h.sentry.push({ kind: "message", msg, level }),
  captureException: (err: any) => h.sentry.push({ kind: "exception", err }),
}));

import { downloadAndStoreRecording } from "../download-and-store";

const CALL_ROW = {
  id: "call-1",
  organization_id: "org-1",
  recording_sid: null,
  recording_storage_path: null,
};

let origSid: string | undefined;
let origToken: string | undefined;
let origTelnyx: string | undefined;

beforeEach(() => {
  h.lookup = [];
  h.lookupKeys = [];
  h.uploadError = null;
  h.updateError = null;
  h.uploads = [];
  h.updates = [];
  h.fetchBuffer = new ArrayBuffer(8);
  h.fetchResponse = { ok: true, status: 200, arrayBuffer: async () => h.fetchBuffer };
  h.fetchThrows = null;
  h.fetchCalls = [];
  h.sentry = [];

  origSid = process.env.TWILIO_ACCOUNT_SID;
  origToken = process.env.TWILIO_AUTH_TOKEN;
  origTelnyx = process.env.TELNYX_API_KEY;
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "tok_test";
  process.env.TELNYX_API_KEY = "telnyx_test";

  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    h.fetchCalls.push({ url, headers: init?.headers });
    if (h.fetchThrows) throw h.fetchThrows;
    return h.fetchResponse;
  }) as any;
});

afterEach(() => {
  process.env.TWILIO_ACCOUNT_SID = origSid;
  process.env.TWILIO_AUTH_TOKEN = origToken;
  process.env.TELNYX_API_KEY = origTelnyx;
  vi.useRealTimers();
});

function params(overrides: Partial<Parameters<typeof downloadAndStoreRecording>[0]> = {}) {
  return {
    provider: "twilio" as const,
    recordingUrl: "https://api.twilio.com/2010/Accounts/AC/Recordings/RE1.mp3",
    recordingSid: "RE1",
    callSid: "CA123",
    ...overrides,
  };
}

describe("downloadAndStoreRecording (SCRUM-545)", () => {
  it("happy path: looks up by sh_${CallSid}, uploads to org/call.mp3, writes the update triple", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    const result = await downloadAndStoreRecording(params());

    expect(result).toEqual({ ok: true, callId: "call-1", storagePath: "org-1/call-1.mp3" });
    // (1) lookup key — the sh_ prefix the guard depends on.
    expect(h.lookupKeys).toEqual(["sh_CA123"]);
    // storage path shape org_id/call_id.mp3
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0].path).toBe("org-1/call-1.mp3");
    expect(h.uploads[0].opts).toMatchObject({ contentType: "audio/mpeg", upsert: true });
    // the exact bytes fetched from the provider are what get uploaded (no swap/re-encode)
    expect(h.uploads[0].audio).toBe(h.fetchBuffer);
    // (2) THE UPDATE TRIPLE: storage path set, sid set, recording_url nulled —
    // keyed by the call id. Dropping recording_url:null here silently breaks
    // the voice-server fallback guard.
    expect(h.updates).toEqual([
      {
        table: "calls",
        payload: {
          recording_storage_path: "org-1/call-1.mp3",
          recording_sid: "RE1",
          recording_url: null,
        },
        col: "id",
        val: "call-1",
      },
    ]);
  });

  it("twilio download uses Basic auth over the given URL", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    await downloadAndStoreRecording(params());
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe("https://api.twilio.com/2010/Accounts/AC/Recordings/RE1.mp3");
    const expected = `Basic ${Buffer.from("AC_test:tok_test").toString("base64")}`;
    expect((h.fetchCalls[0].headers as any).Authorization).toBe(expected);
  });

  it("telnyx download uses Bearer auth", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    await downloadAndStoreRecording(
      params({ provider: "telnyx", recordingUrl: "https://api.telnyx.com/rec/RE1.mp3" }),
    );
    expect((h.fetchCalls[0].headers as any).Authorization).toBe("Bearer telnyx_test");
  });

  it("missing Telnyx API key surfaces as a transient download failure (not a crash)", async () => {
    delete process.env.TELNYX_API_KEY;
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    const result = await downloadAndStoreRecording(
      params({ provider: "telnyx", recordingUrl: "https://api.telnyx.com/rec/RE1.mp3" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/Download failed/);
  });

  it("idempotent: same recording_sid already stored short-circuits (no fetch/upload/update)", async () => {
    h.lookup = [
      {
        data: { ...CALL_ROW, recording_sid: "RE1", recording_storage_path: "org-1/call-1.mp3" },
        error: null,
      },
    ];
    const result = await downloadAndStoreRecording(params());
    expect(result).toEqual({ ok: true, callId: "call-1", storagePath: "org-1/call-1.mp3" });
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it("same recording_sid but NO stored path yet (interrupted prior write) does NOT short-circuit — completes the store", async () => {
    // Guards the `&& call.recording_storage_path` half of the idempotency check:
    // a row that claimed the SID but never finished uploading must still be
    // fetched/uploaded/updated, not falsely reported as stored with a null path.
    h.lookup = [
      { data: { ...CALL_ROW, recording_sid: "RE1", recording_storage_path: null }, error: null },
    ];
    const result = await downloadAndStoreRecording(params()); // recordingSid: RE1
    expect(result).toEqual({ ok: true, callId: "call-1", storagePath: "org-1/call-1.mp3" });
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.uploads).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
  });

  it("refuses to overwrite when a DIFFERENT recording_sid already exists on the call", async () => {
    h.lookup = [
      {
        data: { ...CALL_ROW, recording_sid: "RE_OLD", recording_storage_path: "org-1/call-1.mp3" },
        error: null,
      },
    ];
    const result = await downloadAndStoreRecording(params({ recordingSid: "RE_NEW" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(false); // terminal — do NOT retry
    expect(result.error).toMatch(/conflict/i);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.uploads).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
    expect(h.sentry.some((s) => s.kind === "message")).toBe(true);
  });

  it("no call row after all backoffs → transient failure, retried the full backoff schedule", async () => {
    vi.useFakeTimers();
    h.lookup = [
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const p = downloadAndStoreRecording(params());
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/No call row/);
    // three attempts (backoffs [0, 1500, 4000]) before giving up
    expect(h.lookupKeys).toEqual(["sh_CA123", "sh_CA123", "sh_CA123"]);
  });

  it("waits the [1500, 4000]ms schedule between attempts — not just N instant retries", async () => {
    // Pins the DELAYS, not only the count. The backoffs exist to ride out the
    // voice-server row-write race; zeroing them (instant ×3) must fail here.
    vi.useFakeTimers();
    h.lookup = [
      { data: null, error: null }, // attempt 0 (backoff 0)
      { data: null, error: null }, // attempt 1 (after 1500ms)
      { data: { ...CALL_ROW }, error: null }, // attempt 2 (after 4000ms)
    ];
    const p = downloadAndStoreRecording(params());

    await vi.advanceTimersByTimeAsync(0); // attempt 0 fires immediately
    expect(h.lookupKeys).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1499); // still inside the first backoff
    expect(h.lookupKeys).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // crosses 1500 → attempt 1
    expect(h.lookupKeys).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3999); // still inside the second backoff
    expect(h.lookupKeys).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // crosses 4000 → attempt 2 finds the row
    expect(h.lookupKeys).toHaveLength(3);

    const result = await p;
    expect(result.ok).toBe(true);
  });

  it("lookup DB error returns transient immediately (no further attempts)", async () => {
    h.lookup = [{ data: null, error: { message: "connection reset" } }];
    const result = await downloadAndStoreRecording(params());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/Call lookup failed/);
    expect(h.lookupKeys).toHaveLength(1); // did NOT loop through backoffs
  });

  it("download failure → transient, nothing uploaded", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    h.fetchThrows = new Error("socket hang up");
    const result = await downloadAndStoreRecording(params());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/Download failed/);
    expect(h.uploads).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it("non-OK provider response → transient download failure", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    h.fetchResponse = { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const result = await downloadAndStoreRecording(params());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/returned 404/);
  });

  it("upload failure → transient, no DB update", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    h.uploadError = { message: "bucket unavailable" };
    const result = await downloadAndStoreRecording(params());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/Upload failed/);
    expect(h.updates).toHaveLength(0);
  });

  it("DB update failure → transient", async () => {
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    h.updateError = { message: "deadlock detected" };
    const result = await downloadAndStoreRecording(params());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/DB update failed/);
  });

  it("missing Twilio credentials surface as a transient download failure (not a crash)", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    h.lookup = [{ data: { ...CALL_ROW }, error: null }];
    const result = await downloadAndStoreRecording(params());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.transient).toBe(true);
    expect(result.error).toMatch(/Download failed/);
  });
});
