import { describe, it, expect, vi, beforeEach } from "vitest";

// SCRUM-597: one live voice session per tab. The owner's bubble is on every
// dashboard page; a receptionist test call (or the demo) started meanwhile must end
// it rather than run a second AI over the same speakers.

import { claimVoiceSession, releaseVoiceSession, activeVoiceSessionForTests } from "../session-registry";

beforeEach(() => {
  const held = activeVoiceSessionForTests();
  if (held) releaseVoiceSession(held);
});

describe("the voice session registry", () => {
  it("claiming stops whichever other session holds the tab, once, and takes its place", () => {
    const a = { stop: vi.fn() };
    const b = { stop: vi.fn() };
    claimVoiceSession(a);
    expect(activeVoiceSessionForTests()).toBe(a);
    claimVoiceSession(b);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).not.toHaveBeenCalled();
    expect(activeVoiceSessionForTests()).toBe(b);
  });

  it("re-claiming by the holder stops nothing", () => {
    const a = { stop: vi.fn() };
    claimVoiceSession(a);
    claimVoiceSession(a);
    expect(a.stop).not.toHaveBeenCalled();
  });

  it("releasing frees the tab only for the holder", () => {
    const a = { stop: vi.fn() };
    const b = { stop: vi.fn() };
    claimVoiceSession(a);
    releaseVoiceSession(b);
    expect(activeVoiceSessionForTests()).toBe(a);
    releaseVoiceSession(a);
    expect(activeVoiceSessionForTests()).toBeNull();
    claimVoiceSession(b);
    expect(a.stop).not.toHaveBeenCalled(); // a released session is never stopped again
  });

  it("a previous session whose stop throws doesn't stop the new one starting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    claimVoiceSession({ stop: () => { throw new Error("already closed"); } });
    const b = { stop: vi.fn() };
    expect(() => claimVoiceSession(b)).not.toThrow();
    expect(activeVoiceSessionForTests()).toBe(b);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
