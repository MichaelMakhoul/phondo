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

  it("never schedules an empty buffer while the filter fills", () => {
    expect(hookSource).toMatch(/if \(pcm\.length === 0\) return;/);
  });
});
