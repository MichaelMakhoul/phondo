import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Source-pins for the browser playback wiring. The repo's vitest env (node, no
// DOM) can't run the hook, and the failure modes here are silent: audio still
// plays, just with a seam at every chunk or a blip of pre-interrupt speech, so
// nothing in a type check or a console log would flag a regression.

const hookSource = readFileSync(join(process.cwd(), "src/lib/voice-test/use-voice-test.ts"), "utf-8");

function functionBody(name: string): string {
  const start = hookSource.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return hookSource.slice(start, hookSource.indexOf("}, []);", start));
}

describe("useVoiceTest: browser playback of the assistant's voice", () => {
  it("receives audio as ArrayBuffers, so chunks reach the stateful decoder in order", () => {
    expect(hookSource).toMatch(/ws\.binaryType\s*=\s*"arraybuffer"/);
    expect(hookSource).toMatch(/event\.data instanceof ArrayBuffer/);
    // The old async Blob path could decode out of order or after a barge-in.
    expect(hookSource).not.toMatch(/\.arrayBuffer\(\)\.then/);
  });

  it("builds one decoder per call at the AudioContext's real sample rate", () => {
    expect(hookSource).toMatch(/createMulawPlaybackDecoder\(ctx\.sampleRate\)/);
    // A per-chunk decode would restart the filter at every network frame.
    expect(hookSource).not.toMatch(/mulawToAudioBuffer/);
  });

  it("drops the decoder's buffered look-ahead on barge-in", () => {
    expect(functionBody("flushPlayback")).toMatch(/playbackDecoderRef\.current\?\.reset\(\)/);
  });

  it("flushes playback (and so the decoder) when the server sends clear", () => {
    // Slice the case body: a lazy regex would match the flushPlayback() in cleanup().
    const at = hookSource.indexOf('case "clear":');
    expect(at, 'case "clear" not found').toBeGreaterThan(-1);
    expect(hookSource.slice(at, hookSource.indexOf("break;", at))).toMatch(/flushPlayback\(\)/);
  });

  it("never schedules an empty buffer while the filter fills", () => {
    expect(hookSource).toMatch(/if \(pcm\.length === 0\) return;/);
  });
});

// SCRUM-597: one live session per tab, and the bookings-changed relay.
describe("useVoiceTest: one live session per tab, and bookings_changed", () => {
  const hook = readFileSync(join(process.cwd(), "src/lib/voice-test/use-voice-test.ts"), "utf-8");
  it("claims the tab right after tearing down its own previous session, and releases it in cleanup()", () => {
    const start = hook.indexOf("const start = useCallback(async () => {");
    const ownCleanup = hook.indexOf("cleanup();", start);
    const claim = hook.indexOf("claimVoiceSession(sessionHandleRef.current);", start);
    expect(claim).toBeGreaterThan(ownCleanup);
    expect(claim).toBeLessThan(hook.indexOf('updateStatus("connecting");', start));
    const cleanupFn = hook.slice(hook.indexOf("function cleanup() {"));
    expect(cleanupFn.slice(0, 200)).toContain("releaseVoiceSession(sessionHandleRef.current);");
  });
  it("the registry reaches the latest stop() through a stable handle", () => {
    expect(hook).toMatch(/const sessionHandleRef = useRef<VoiceSessionHandle>\(\{ stop: \(\) => stopRef\.current\(\) \}\);/);
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*stopRef\.current = stop;\s*\}, \[stop\]\);/);
  });
  it("relays bookings_changed from the voice server as a window event", () => {
    expect(hook).toMatch(/case "bookings_changed":\s*\/\/[^\n]*\n\s*announceBookingsChanged\(\);\s*break;/);
  });
});

// SCRUM-597 round 2 (silent + code lenses): a start() stopped while connecting gives up.
describe("useVoiceTest: a start stopped mid-way gives up", () => {
  const hook = readFileSync(join(process.cwd(), "src/lib/voice-test/use-voice-test.ts"), "utf-8");
  const start = hook.slice(hook.indexOf("const start = useCallback(async () => {"), hook.indexOf("}, [assistantId, tokenUrl"));
  it("cleanup() bumps the start generation; start() takes its number after its own cleanup and claim", () => {
    const cleanupFn = hook.slice(hook.indexOf("function cleanup() {"));
    expect(cleanupFn.slice(0, 300)).toContain("startGenRef.current += 1;");
    expect(start.indexOf("const gen = startGenRef.current;")).toBeGreaterThan(start.indexOf("claimVoiceSession(sessionHandleRef.current);"));
  });
  it("checks after the token, the microphone (releasing it) and the worklet, and a superseded start's error is no error", () => {
    expect(start).toMatch(/const \{ token, wsUrl \} = await tokenRes\.json\(\);\s*if \(superseded\(\)\) return;/);
    expect(start).toMatch(/if \(superseded\(\)\) \{[^}]*stream\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\);\s*return;\s*\}\s*mediaStreamRef\.current = stream;/);
    expect(start).toMatch(/await ctx\.audioWorklet\.addModule\([^)]*\);\s*if \(superseded\(\)\) return;/);
    expect(start).toMatch(/\} catch \(err\) \{\s*(\/\/[^\n]*\n\s*)*if \(superseded\(\)\) return;/);
    expect(start.indexOf("superseded()")).toBeLessThan(start.indexOf("new WebSocket("));
  });
});
