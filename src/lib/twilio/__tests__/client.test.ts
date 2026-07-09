import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Twilio SDK fake ──────────────────────────────────────────────────
// `incomingPhoneNumbers` is BOTH callable (sid) => { update, remove } and a
// namespace with `.create`, mirroring the real SDK shape the client relies on.
type UpdateParams = Record<string, string>;

const state: {
  updateCalls: { sid: string; params: UpdateParams }[];
  updateImpl: (sid: string, params: UpdateParams) => Promise<unknown>;
  createCalls: Record<string, unknown>[];
  createResult: { sid: string; phoneNumber: string };
  listCalls: Record<string, unknown>[];
  listResult: Record<string, unknown>[];
} = {
  updateCalls: [],
  updateImpl: async () => ({}),
  createCalls: [],
  createResult: { sid: "PNfake", phoneNumber: "+61255550000" },
  listCalls: [],
  listResult: [],
};

const incomingPhoneNumbers = Object.assign(
  (sid: string) => ({
    update: (params: UpdateParams) => {
      state.updateCalls.push({ sid, params });
      return state.updateImpl(sid, params);
    },
    remove: async () => undefined,
  }),
  {
    create: async (params: Record<string, unknown>) => {
      state.createCalls.push(params);
      return state.createResult;
    },
  }
);

const fakeClient = {
  incomingPhoneNumbers,
  availablePhoneNumbers: (_countryCode: string) => ({
    local: {
      list: async (params: Record<string, unknown>) => {
        state.listCalls.push(params);
        return state.listResult;
      },
    },
  }),
};

vi.mock("twilio", () => ({ default: vi.fn(() => fakeClient) }));

import { configureVoiceWebhook, searchAvailableNumbers, purchaseNumber } from "../client";

const PRIMARY = "https://voice.example.com/twiml";
const FALLBACK = "https://app.example.com/api/twilio/voice-fallback";

beforeEach(() => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "token");
  state.updateCalls = [];
  state.updateImpl = async () => ({});
  state.createCalls = [];
  state.listCalls = [];
  state.listResult = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configureVoiceWebhook", () => {
  // The regression this guards: a single combined update carrying a bad
  // voiceFallbackUrl (Twilio 22105, e.g. a localhost URL in dev) failed the
  // WHOLE call, leaving brand-new numbers with no voiceUrl at all — every
  // inbound call dropped. Primary and fallback must be separate updates.
  it("sets the primary voiceUrl in its own update, with no fallback fields", async () => {
    await configureVoiceWebhook("PN123", PRIMARY);

    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].sid).toBe("PN123");
    expect(state.updateCalls[0].params).toEqual({ voiceUrl: PRIMARY, voiceMethod: "POST" });
  });

  it("issues the primary update BEFORE the fallback update", async () => {
    await configureVoiceWebhook("PN123", PRIMARY, FALLBACK);

    expect(state.updateCalls).toHaveLength(2);
    expect(state.updateCalls[0].params).toEqual({ voiceUrl: PRIMARY, voiceMethod: "POST" });
    expect(state.updateCalls[1].params).toEqual({
      voiceFallbackUrl: FALLBACK,
      voiceFallbackMethod: "POST",
    });
  });

  it("still resolves when the fallback update is rejected (primary already set)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.updateImpl = async (_sid, params) => {
      if (params.voiceFallbackUrl) throw new Error("Invalid URL provided for VoiceFallbackUrl");
      return {};
    };

    await expect(configureVoiceWebhook("PN123", PRIMARY, FALLBACK)).resolves.toBeUndefined();

    // The primary was attempted first and succeeded — that's the whole point.
    expect(state.updateCalls[0].params.voiceUrl).toBe(PRIMARY);
    expect(warn).toHaveBeenCalled();
  });

  it("throws when the PRIMARY update fails (caller must release the number)", async () => {
    state.updateImpl = async (_sid, params) => {
      if (params.voiceUrl) throw new Error("twilio down");
      return {};
    };

    await expect(configureVoiceWebhook("PN123", PRIMARY, FALLBACK)).rejects.toThrow("twilio down");
    // Fallback must not be attempted once the critical primary failed.
    expect(state.updateCalls).toHaveLength(1);
  });
});

describe("searchAvailableNumbers", () => {
  it("builds an anchored `contains` pattern for AU area codes (never `areaCode`)", async () => {
    // Twilio rejects a bare digit ("Invalid Pattern Provided") and does not
    // support `areaCode` outside US/CA, so "02" must become "612********".
    await searchAvailableNumbers("AU", "02", 5);

    expect(state.listCalls).toHaveLength(1);
    expect(state.listCalls[0]).toEqual({ limit: 5, contains: "612********" });
    expect(state.listCalls[0]).not.toHaveProperty("areaCode");
  });

  it("handles AU mobile prefixes the same way", async () => {
    await searchAvailableNumbers("AU", "04", 1);
    expect(state.listCalls[0].contains).toBe("614********");
  });

  it("uses the numeric `areaCode` param for US", async () => {
    await searchAvailableNumbers("US", "415", 1);
    expect(state.listCalls[0]).toEqual({ limit: 1, areaCode: 415 });
  });

  it("omits both params when no area code is given", async () => {
    await searchAvailableNumbers("US", undefined, 3);
    expect(state.listCalls[0]).toEqual({ limit: 3 });
  });

  it("rejects a non-numeric US area code", async () => {
    await expect(searchAvailableNumbers("US", "abc", 1)).rejects.toThrow(/Invalid area code/);
  });

  it("maps the Twilio response onto AvailableNumber", async () => {
    state.listResult = [
      { phoneNumber: "+61255551234", friendlyName: "(02) 5555 1234", locality: "Sydney", region: "NSW", isoCountry: "AU" },
    ];
    const result = await searchAvailableNumbers("AU", "02", 1);
    expect(result).toEqual([
      { number: "+61255551234", friendlyName: "(02) 5555 1234", locality: "Sydney", region: "NSW", isoCountry: "AU" },
    ]);
  });
});

describe("purchaseNumber", () => {
  it("attaches addressSid when TWILIO_ADDRESS_SID is set (AU requires it, error 21631)", async () => {
    vi.stubEnv("TWILIO_ADDRESS_SID", "ADabc123");

    const result = await purchaseNumber("+61255551234");

    expect(state.createCalls[0]).toEqual({ phoneNumber: "+61255551234", addressSid: "ADabc123" });
    expect(result).toEqual({ sid: "PNfake", number: "+61255550000" });
  });

  it("omits addressSid when the env var is unset", async () => {
    vi.stubEnv("TWILIO_ADDRESS_SID", "");

    await purchaseNumber("+12125551234");

    expect(state.createCalls[0]).toEqual({ phoneNumber: "+12125551234" });
    expect(state.createCalls[0]).not.toHaveProperty("addressSid");
  });
});
