import { describe, it, expect, vi, afterEach } from "vitest";
import type { VoiceTestStatus } from "@/lib/voice-test";
import {
  ASSISTANT_LINE_PATH,
  DEFAULT_PANEL_STATE,
  PANEL_STATE_STORAGE_KEY,
  TRANSCRIPT_FOLLOW_THRESHOLD_PX,
  VOLUME_STORAGE_KEY,
  describeBubbleState,
  getBrowserStorage,
  isNearBottom,
  readPanelState,
  readVolume,
  shouldShowFloatingBubble,
  writePanelState, writeVolume, isSessionLive } from "../bubble-state";

// SCRUM-597: the always-on bubble's pure logic. The components that use it can't
// run in the repo's node vitest env (no DOM, JSX left as "preserve"); their wiring
// is pinned in owner-assistant.source.test.ts.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

const blocked = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("readPanelState", () => {
  it("defaults to minimised, so the panel never opens over a page uninvited", () => {
    expect(DEFAULT_PANEL_STATE).toBe("minimised");
  });

  it.each(["open", "minimised"] as const)("returns a remembered %s", (state) => {
    expect(readPanelState(memoryStorage({ [PANEL_STATE_STORAGE_KEY]: state }))).toBe(state);
  });

  it("reads its own namespaced key", () => {
    const storage = memoryStorage({ [PANEL_STATE_STORAGE_KEY]: "open" });
    readPanelState(storage);
    expect(PANEL_STATE_STORAGE_KEY).toBe("phondo:owner-assistant-panel");
    expect(storage.getItem).toHaveBeenCalledWith(PANEL_STATE_STORAGE_KEY);
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readPanelState(memoryStorage())).toBe("minimised");
  });

  it.each(["", "OPEN", " open", "closed", "true", "null", '{"open":true}'])(
    "falls back to the default for a value it didn't write: %j",
    (value) => {
      expect(readPanelState(memoryStorage({ [PANEL_STATE_STORAGE_KEY]: value }))).toBe("minimised");
    },
  );

  it("falls back to the default when there is no storage", () => {
    expect(readPanelState(null)).toBe("minimised");
  });

  it("falls back to the default, without throwing, when storage throws (site data blocked)", () => {
    expect(() => readPanelState({ getItem: blocked })).not.toThrow();
    expect(readPanelState({ getItem: blocked })).toBe("minimised");
  });
});

describe("writePanelState", () => {
  it.each(["open", "minimised"] as const)("stores %s under its key and reports success", (state) => {
    const storage = memoryStorage();
    expect(writePanelState(storage, state)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(PANEL_STATE_STORAGE_KEY, state);
  });

  it("round-trips through readPanelState", () => {
    const storage = memoryStorage();
    writePanelState(storage, "open");
    expect(readPanelState(storage)).toBe("open");
    writePanelState(storage, "minimised");
    expect(readPanelState(storage)).toBe("minimised");
  });

  it("reports false, without throwing, when storage refuses the write (quota, private mode)", () => {
    const refuse = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    expect(() => writePanelState({ setItem: refuse }, "open")).not.toThrow();
    expect(writePanelState({ setItem: refuse }, "open")).toBe(false);
  });

  it("reports false when there is no storage", () => {
    expect(writePanelState(null, "open")).toBe(false);
  });
});

// SCRUM-619: the assistant's volume on this device, remembered like the panel state.
describe("readVolume", () => {
  it("reads its own namespaced key", () => {
    const storage = memoryStorage({ [VOLUME_STORAGE_KEY]: "0.4" });
    expect(readVolume(storage)).toBe(0.4);
    expect(VOLUME_STORAGE_KEY).toBe("phondo:owner-assistant-volume");
    expect(storage.getItem).toHaveBeenCalledWith(VOLUME_STORAGE_KEY);
  });

  it.each([
    ["0", 0],
    ["1", 1],
    ["0.25", 0.25],
    ["7", 1],
    ["-3", 0],
  ])("returns %j as %d (kept between 0 and 1)", (stored, volume) => {
    expect(readVolume(memoryStorage({ [VOLUME_STORAGE_KEY]: stored }))).toBe(volume);
  });

  it.each(["", "  ", "loud", "NaN", "Infinity", "{}"])("has nothing for a value it didn't write: %j", (value) => {
    expect(readVolume(memoryStorage({ [VOLUME_STORAGE_KEY]: value }))).toBeNull();
  });

  it("has nothing when nothing is stored, there is no storage, or reading it throws", () => {
    expect(readVolume(memoryStorage())).toBeNull();
    expect(readVolume(null)).toBeNull();
    expect(readVolume({ getItem: blocked })).toBeNull();
  });
});

describe("writeVolume", () => {
  it("stores the volume, kept between 0 and 1, and round-trips through readVolume", () => {
    const storage = memoryStorage();
    expect(writeVolume(storage, 0.35)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(VOLUME_STORAGE_KEY, "0.35");
    expect(readVolume(storage)).toBe(0.35);
    writeVolume(storage, 2);
    expect(readVolume(storage)).toBe(1);
  });

  it("reports false, without throwing, when storage refuses the write or there is none", () => {
    const refuse = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    expect(writeVolume({ setItem: refuse }, 0.5)).toBe(false);
    expect(writeVolume(null, 0.5)).toBe(false);
  });
});

describe("getBrowserStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is null on the server, where there is no window", () => {
    expect(typeof window).toBe("undefined");
    expect(getBrowserStorage()).toBeNull();
  });

  it("returns the browser's localStorage when it is allowed", () => {
    const localStorage = memoryStorage();
    vi.stubGlobal("window", { localStorage });
    expect(getBrowserStorage()).toBe(localStorage);
  });

  it("is null, without throwing, when merely reading window.localStorage throws", () => {
    const win = {};
    Object.defineProperty(win, "localStorage", { get: blocked });
    vi.stubGlobal("window", win);
    expect(() => getBrowserStorage()).not.toThrow();
    expect(getBrowserStorage()).toBeNull();
  });

  it("is null when the browser hands back no storage at all", () => {
    vi.stubGlobal("window", { localStorage: null });
    expect(getBrowserStorage()).toBeNull();
  });
});

describe("shouldShowFloatingBubble", () => {
  it("knows the page that shows the session inline", () => {
    expect(ASSISTANT_LINE_PATH).toBe("/assistant-line");
  });

  it.each(["/assistant-line", "/assistant-line/", "/assistant-line/anything"])(
    "hides on %s, which renders the same session inline",
    (pathname) => {
      expect(shouldShowFloatingBubble(pathname)).toBe(false);
    },
  );

  it.each(["/dashboard", "/assistants", "/assistants/abc/test", "/assistant-lines", "/settings", "/calls/123", "/"])(
    "shows on %s",
    (pathname) => {
      expect(shouldShowFloatingBubble(pathname)).toBe(true);
    },
  );

  it("shows when the path is unknown, so the owner can always reach the assistant", () => {
    expect(shouldShowFloatingBubble(null)).toBe(true);
    expect(shouldShowFloatingBubble("")).toBe(true);
  });
});

describe("describeBubbleState", () => {
  const quiet = { isMuted: false, isAssistantSpeaking: false };

  it.each([
    ["idle", "ready", "Open your assistant"],
    ["connecting", "connecting", "Open your assistant (connecting)"],
    ["ended", "ended", "Open your assistant (session ended)"],
    ["error", "error", "Open your assistant (something went wrong)"],
  ] as const)("%s shows %s, labelled %j", (status, indicator, ariaLabel) => {
    expect(describeBubbleState({ status, ...quiet })).toMatchObject({ indicator, ariaLabel });
  });

  it("an active session is listening, or speaking while the assistant talks", () => {
    expect(describeBubbleState({ status: "active", ...quiet })).toMatchObject({
      indicator: "listening",
      ariaLabel: "Open your assistant (listening)",
    });
    expect(describeBubbleState({ status: "active", isMuted: false, isAssistantSpeaking: true })).toMatchObject({
      indicator: "speaking",
      ariaLabel: "Open your assistant (speaking)",
    });
  });

  it("a muted microphone shows as muted, even while the assistant is speaking", () => {
    for (const isAssistantSpeaking of [false, true]) {
      expect(describeBubbleState({ status: "active", isMuted: true, isAssistantSpeaking })).toMatchObject({
        indicator: "muted",
        ariaLabel: "Open your assistant (your microphone is muted)",
      });
    }
  });

  it("ignores mute and speaking flags left over outside an active session", () => {
    // The hook's stop() and error paths leave both flags as they were.
    const statuses: VoiceTestStatus[] = ["idle", "connecting", "ended", "error"];
    for (const status of statuses) {
      const { indicator } = describeBubbleState({ status, isMuted: true, isAssistantSpeaking: true });
      expect(["muted", "speaking", "listening"]).not.toContain(indicator);
    }
  });

  it("every accessible name says what clicking does first", () => {
    const statuses: VoiceTestStatus[] = ["idle", "connecting", "active", "ended", "error"];
    for (const status of statuses) {
      for (const isMuted of [false, true]) {
        for (const isAssistantSpeaking of [false, true]) {
          expect(describeBubbleState({ status, isMuted, isAssistantSpeaking }).ariaLabel).toMatch(
            /^Open your assistant( \(.+\))?$/,
          );
        }
      }
    }
  });

  it("announces session changes, with one line for listening and speaking so it doesn't chatter", () => {
    const listening = describeBubbleState({ status: "active", ...quiet }).announcement;
    const speaking = describeBubbleState({ status: "active", isMuted: false, isAssistantSpeaking: true }).announcement;
    expect(listening).toBe("Connected to your assistant.");
    expect(speaking).toBe(listening);
    expect(describeBubbleState({ status: "active", isMuted: true, isAssistantSpeaking: false }).announcement).toBe(
      "Connected to your assistant. Your microphone is muted.",
    );
    expect(describeBubbleState({ status: "connecting", ...quiet }).announcement).toBe("Connecting to your assistant.");
    expect(describeBubbleState({ status: "ended", ...quiet }).announcement).toBe("Your assistant session has ended.");
    expect(describeBubbleState({ status: "error", ...quiet }).announcement).toBe(
      "Something went wrong with your assistant.",
    );
  });

  it("has nothing to announce before a session starts", () => {
    expect(describeBubbleState({ status: "idle", ...quiet }).announcement).toBe("");
  });
});

describe("isNearBottom", () => {
  it("is true at the very end of the list", () => {
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 300, clientHeight: 200 })).toBe(true);
  });

  it("is true within the threshold, and false just past it", () => {
    expect(TRANSCRIPT_FOLLOW_THRESHOLD_PX).toBe(40);
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 260, clientHeight: 200 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 259, clientHeight: 200 })).toBe(false);
  });

  it("is false when the owner has scrolled up to reread", () => {
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 0, clientHeight: 240 })).toBe(false);
  });

  it("is true for a list too short to scroll", () => {
    expect(isNearBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 240 })).toBe(true);
  });

  it("takes a custom threshold", () => {
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 290, clientHeight: 200 }, 0)).toBe(false);
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 290, clientHeight: 200 }, 10)).toBe(true);
  });
});

describe("isSessionLive (SCRUM-597)", () => {
  it("only connecting and active are live", () => {
    expect(isSessionLive("connecting")).toBe(true);
    expect(isSessionLive("active")).toBe(true);
    for (const s of ["idle", "ended", "error", "", null, undefined, "ACTIVE"]) expect(isSessionLive(s as any)).toBe(false);
  });
});
