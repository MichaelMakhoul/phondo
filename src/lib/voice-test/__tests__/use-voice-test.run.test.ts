// SCRUM-619: useVoiceTest run for real in the node env — no jsdom, no new dependency.
// React's hooks become plain functions (one render), and the browser's AudioContext /
// AudioWorkletNode / WebSocket / getUserMedia / fetch are fakes that record what it does.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPcm16PlaybackDecoder } from "@/lib/voice-test/playback-format";
import { createMulawPlaybackDecoder } from "@/lib/voice-test/mulaw";

// Every value the hook hands a state setter, in order (read lazily: vi.mock is hoisted).
const stateSets: unknown[] = [];
vi.mock("react", () => ({
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, (next: unknown) => { stateSets.push(next); }],
  useRef: (current: unknown) => ({ current }),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));
const bookingsChanged = vi.fn();
vi.mock("@/lib/voice-test/events", () => ({ announceBookingsChanged: () => bookingsChanged() }));
vi.mock("@/lib/analytics", () => ({
  trackTestCallStarted: () => {},
  trackTestCallCompleted: () => {},
  trackTestCallMicGateBypassed: () => {},
}));

import { useVoiceTest } from "@/lib/voice-test/use-voice-test";

class FakeParam {
  value = 1;
  targets: number[] = [];
  setTargetAtTime(value: number) {
    this.targets.push(value);
    this.value = value;
  }
}
class FakeGain {
  gain = new FakeParam();
  connectedTo: unknown = null;
  constructor(readonly context: FakeCtx) {}
  connect(target: unknown) {
    this.connectedTo = target;
  }
  disconnect() {}
}
class FakeCtx {
  static rate = 48000;
  static all: FakeCtx[] = [];
  sampleRate = FakeCtx.rate;
  currentTime = 0;
  state = "running";
  destination = { destination: true };
  audioWorklet = { addModule: async () => {} };
  gains: FakeGain[] = [];
  buffers: Float32Array[] = [];
  sources: Array<{ connectedTo: unknown }> = [];
  constructor() {
    FakeCtx.all.push(this);
  }
  createGain() {
    const gain = new FakeGain(this);
    this.gains.push(gain);
    return gain;
  }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    this.buffers.push(data);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const source = {
      buffer: null,
      connectedTo: null as unknown,
      onended: null,
      connect(target: unknown) {
        this.connectedTo = target;
      },
      start() {},
      stop() {},
      disconnect() {},
    };
    this.sources.push(source);
    return source;
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}
class FakeWorkletNode {
  port = { onmessage: null, postMessage() {} };
  onprocessorerror = null;
  connect() {}
  disconnect() {}
}
class FakeWs {
  static OPEN = 1;
  static CONNECTING = 0;
  static all: FakeWs[] = [];
  readyState = 1;
  binaryType = "";
  sent: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose = null;
  onerror = null;
  onopen = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

vi.stubGlobal("AudioContext", FakeCtx);
vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
vi.stubGlobal("WebSocket", FakeWs);
vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
vi.stubGlobal("navigator", {
  mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ enabled: true }] }) },
});
vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ token: "tok", wsUrl: "wss://voice.test/ws/test" }) }));

/** 16-bit little-endian PCM bytes. */
function pcm(samples: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return buf;
}
const tone = (n: number, from = 0) => Array.from({ length: n }, (_, i) => Math.round(9000 * Math.sin((i + from) / 5)));
const json = (msg: unknown) => JSON.stringify(msg);

async function startSession(rate = 48000) {
  FakeCtx.rate = rate;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- React is mocked above: the hook runs as a plain function
  const hook = useVoiceTest({ assistantId: "asst-1", tokenUrl: "/api/owner-token", trackingSource: "owner_assistant" });
  await hook.start();
  const ws = FakeWs.all.at(-1)!;
  const ctx = FakeCtx.all.at(-1)!;
  return { hook, ws, ctx, receive: (data: unknown) => ws.onmessage!({ data }) };
}

beforeEach(() => {
  stateSets.length = 0;
  bookingsChanged.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("useVoiceTest, run for real: the server's audio format", () => {
  it("after audio_format, every chunk decodes as wideband PCM — past the greeting, 'ready', and a barge-in clear", () => {
    return startSession().then(({ ws, ctx, receive }) => {
      expect(ws.url).toBe("wss://voice.test/ws/test?token=tok&playback=linear16");
      receive(json({ type: "audio_format", encoding: "linear16", sampleRate: 24000 }));
      const reference = createPcm16PlaybackDecoder(24000, 48000);

      const greeting = pcm(tone(2400));
      receive(greeting);
      expect(ctx.buffers.at(-1)).toEqual(reference.decode(new Uint8Array(greeting)));

      receive(json({ type: "ready" })); // the server sends ready after the greeting's audio
      const reply = pcm(tone(2400, 2400));
      receive(reply);
      expect(ctx.buffers.at(-1)).toEqual(reference.decode(new Uint8Array(reply)));

      receive(json({ type: "clear" })); // the owner talked over the reply
      reference.reset();
      const next = pcm(tone(2400));
      receive(next);
      expect(ctx.buffers.at(-1)).toEqual(reference.decode(new Uint8Array(next)));

      expect(bookingsChanged).not.toHaveBeenCalled(); // an audio_format isn't a bookings change
    });
  });

  it("before any announcement the page plays the phone's mu-law", async () => {
    const { ctx, receive } = await startSession();
    const mulaw = new Uint8Array(800).fill(0x7f);
    receive(mulaw.buffer);
    expect(ctx.buffers.at(-1)).toEqual(createMulawPlaybackDecoder(48000).decode(mulaw));
  });

  it("an announcement it can't play ends the session where the owner sees it — nothing more is played as noise", async () => {
    const { ws, ctx, receive } = await startSession();
    expect(ws.url).toContain("&playback=linear16");
    receive(json({ type: "audio_format", encoding: "opus", sampleRate: 48000 }));
    expect(console.error).toHaveBeenCalledWith("[VoiceTest] Unplayable audio format announced:", "opus", 48000);
    // …and the voice server is told, so ops see it (the console reaches no one).
    expect(ws.sent).toContainEqual(JSON.stringify({ type: "client_error", reason: "unplayable_audio_format" }));
    expect(ws.onmessage).toBeNull(); // the socket is let go: no more audio reaches a decoder
    expect(ctx.state).toBe("closed");
    const statuses = stateSets.filter((v) => typeof v === "string" && ["idle", "connecting", "active", "ended", "error"].includes(v));
    expect(statuses.at(-1)).toBe("error"); // left on the error, never flipped to "ended"
    expect(stateSets).toContain("Your browser couldn't play your assistant's voice. Please reload the page and try again.");
  });

  it("a context too slow for wideband never asks for it", async () => {
    const slow = await startSession(22050);
    expect(slow.ws.url).toBe("wss://voice.test/ws/test?token=tok");
  });
});

describe("useVoiceTest, run for real: the page's volume", () => {
  it("every chunk plays through one gain stage at the chosen volume; changes glide, clamped; the next session keeps it", async () => {
    FakeCtx.rate = 48000;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- React is mocked above: the hook runs as a plain function
    const hook = useVoiceTest({ assistantId: "asst-1", tokenUrl: "/api/owner-token", trackingSource: "owner_assistant" });
    hook.setVolume(0.4);
    await hook.start();
    const ctx = FakeCtx.all.at(-1)!;
    const ws = FakeWs.all.at(-1)!;
    expect(ctx.gains).toHaveLength(1);
    const gain = ctx.gains[0];
    expect(gain.gain.value).toBeCloseTo(0.16, 10); // the slider's square
    expect(gain.connectedTo).toBe(ctx.destination);
    ws.onmessage!({ data: new Uint8Array(800).fill(0x7f).buffer });
    expect(ctx.sources.at(-1)!.connectedTo).toBe(gain);
    hook.setVolume(1.7);
    expect(gain.gain.targets).toEqual([1]);
    hook.setVolume(0.5);
    expect(gain.gain.targets).toEqual([1, 0.25]); // half way glides to its square, live too
    expect(stateSets.at(-1)).toBe(0.5); // the slider shows where it was put, not the gain
    hook.stop();
    hook.setVolume(0.2); // after the session: nothing left to glide
    expect(gain.gain.targets).toEqual([1, 0.25]);
    await hook.start();
    expect(FakeCtx.all.at(-1)!.gains[0].gain.value).toBeCloseTo(0.04, 10);
  });
});
