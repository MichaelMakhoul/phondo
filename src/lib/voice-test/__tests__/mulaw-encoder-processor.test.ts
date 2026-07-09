import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ──────────────────────────────────────────────────────────────────────────
// The browser mic voice-activity gate (demo + test calls only; the production
// phone path never touches this file).
//
// It has two opposite failure modes and both are silent:
//   1. Gate too permissive → idle room "air" keeps interrupting the assistant,
//      the caller hears dead air. This is the bug the gate was added to fix.
//   2. Gate too strict, or the self-healing bypass fires when it shouldn't →
//      the caller is muted (or un-gated) for the whole session while the UI
//      still shows an active call. Nothing in any log explains it.
//
// Neither shows up in a type check or a lint. So we drive the REAL worklet
// source through node:vm — stubbing only the AudioWorklet globals — and assert
// on what actually reaches the socket. Loading the shipped file rather than a
// copy of its state machine is the point: a copy drifts, and the drift is
// exactly where these bugs live.
// ──────────────────────────────────────────────────────────────────────────

const WORKLET_SRC = readFileSync(
  path.resolve(process.cwd(), "public/audio-worklets/mulaw-encoder-processor.js"),
  "utf8"
);

const SAMPLE_RATE = 48000;
const QUANTUM = 128; // samples per process() call, per the Web Audio spec
const QUANTUM_S = QUANTUM / SAMPLE_RATE;

interface GateEvent {
  type: "gate";
  event: string;
  rms: number;
  floor: number;
}

/**
 * The worklet builds its Uint8Array inside the vm realm, so `instanceof
 * Uint8Array` from this realm is false. `ArrayBuffer.isView` checks an internal
 * slot and is realm-agnostic. (In a real browser `port.postMessage` structured-
 * clones into the receiving realm, so `instanceof` would work there — but the
 * realm-safe check is the honest one to assert with.)
 */
function isAudioChunk(m: unknown): m is Uint8Array {
  return ArrayBuffer.isView(m);
}

/** Deterministic uniform noise in [-1, 1] — no Math.random, so no flakes. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 0x100000000) * 2 - 1;
  };
}

/**
 * Drives the worklet with synthetic frames and records everything it posts.
 * `play(rms, seconds)` returns what the socket saw during just that phase.
 */
class GateHarness {
  private ctx: any;
  private proc: any;
  private posted: unknown[] = [];
  private rng = makeRng(0xc0ffee);
  private t = 0;

  readonly mulawSilence: number;

  constructor() {
    let Ctor: any = null;
    const posted = this.posted;

    this.ctx = {
      sampleRate: SAMPLE_RATE,
      currentTime: 0,
      registerProcessor: (_name: string, cls: any) => {
        Ctor = cls;
      },
      AudioWorkletProcessor: class {
        port = { postMessage: (m: unknown) => posted.push(m) };
      },
    };
    createContext(this.ctx);
    runInContext(WORKLET_SRC, this.ctx);

    if (!Ctor) throw new Error("worklet never called registerProcessor");
    this.proc = new Ctor();
    this.mulawSilence = runInContext("linearToMulaw(0)", this.ctx) as number;
  }

  /** One render quantum of noise at the given RMS. */
  private frame(rms: number): Float32Array {
    const f = new Float32Array(QUANTUM);
    // uniform noise scaled so E[rms] == rms
    for (let i = 0; i < QUANTUM; i++) f[i] = this.rng() * rms * Math.sqrt(3);
    return f;
  }

  /** Feed `seconds` of audio at `rms`; report what the socket received. */
  play(rms: number, seconds: number) {
    return this.playShaped(seconds, () => rms);
  }

  /** Feed `seconds` of audio whose RMS is a function of elapsed call time. */
  playShaped(seconds: number, rmsAt: (t: number) => number) {
    const start = this.posted.length;
    const quanta = Math.round(seconds / QUANTUM_S);
    for (let i = 0; i < quanta; i++) {
      this.ctx.currentTime = this.t;
      this.proc.process([[this.frame(rmsAt(this.t))]]);
      this.t += QUANTUM_S;
    }
    return this.audioStats(this.posted.slice(start));
  }

  private audioStats(chunks: unknown[]) {
    let bytes = 0;
    let audible = 0;
    for (const c of chunks) {
      if (!isAudioChunk(c)) continue;
      bytes += c.length;
      for (const b of c) if (b !== this.mulawSilence) audible++;
    }
    return { bytes, audible, audibleRatio: bytes ? audible / bytes : 0 };
  }

  get events(): GateEvent[] {
    return this.posted.filter(
      (m): m is GateEvent => !isAudioChunk(m) && (m as GateEvent)?.type === "gate"
    );
  }

  get bypassed(): boolean {
    return this.events.some((e) => e.event === "bypass");
  }

  /** Mirrors what the hook posts when the server reports assistant speech. */
  setAssistantSpeaking(speaking: boolean) {
    this.proc.port.onmessage({ data: { type: "assistant-speaking", speaking } });
  }
}

/** Real speech modulates: ~300ms of voice, ~150ms of breath. Noise doesn't. */
function speech(speechRms: number, ambientRms: number, startAt: number) {
  return (t: number) => {
    if (t < startAt) return ambientRms;
    const phase = (t - startAt) % 0.45;
    return phase < 0.3 ? speechRms : ambientRms;
  };
}

// The room the gate is designed for: laptop mic, quiet office.
const QUIET_ROOM = 0.002;
const NORMAL_SPEECH = 0.08;
// A breath or a chair creak: too quiet to open the gate (threshold is ~0.0056
// in a QUIET_ROOM) but loud enough to count as evidence toward the rescue
// hatch. Exactly the input that must never latch the gate open on its own.
const RUSTLE = 0.0045;

describe("mic gate — keeps idle air off the wire", () => {
  it("sends pure silence while the room is merely breathing", () => {
    const h = new GateHarness();
    const out = h.play(QUIET_ROOM, 4);

    expect(out.bytes).toBeGreaterThan(0);
    expect(out.audible).toBe(0);
    expect(h.bypassed).toBe(false);
  });

  it("stays shut for a whole call when nobody ever speaks", () => {
    const h = new GateHarness();
    const out = h.play(0.0005, 15);

    expect(out.audible).toBe(0);
    // A silent caller must never look mis-calibrated.
    expect(h.bypassed).toBe(false);
  });

  it("does not stream a loud but speechless room (fan, aircon)", () => {
    // Ambient here (0.011) is far above the gate's seeded floor. If the gate
    // opens before it has learned the room, it holds itself open forever on
    // the hangover and every frame of air goes to the model.
    const h = new GateHarness();
    h.play(0.011, 2); // let it calibrate
    const out = h.play(0.011, 10);

    expect(out.audibleRatio).toBeLessThan(0.02);
    expect(h.bypassed).toBe(false);
  });
});

describe("mic gate — lets the caller be heard", () => {
  it("opens on ordinary speech", () => {
    const h = new GateHarness();
    h.play(QUIET_ROOM, 1.5);
    const out = h.play(NORMAL_SPEECH, 2);

    expect(out.audibleRatio).toBeGreaterThan(0.9);
    expect(h.events.some((e) => e.event === "first-open")).toBe(true);
    // The gate did its job, so the rescue hatch must not have been used.
    expect(h.bypassed).toBe(false);
  });

  it("hears a quiet speaker in a slightly noisy room", () => {
    // Speech at 0.018 never clears the open threshold once the floor has
    // learned a 0.0065 room. Before the watchdog was made reachable, this
    // caller was muted for the entire call with no signal anywhere.
    const h = new GateHarness();
    h.play(0.0065, 2);
    const out = h.playShaped(10, speech(0.018, 0.0065, 0));

    expect(out.audible).toBeGreaterThan(0);
  });

  it("hears a caller talking over a loud room", () => {
    const h = new GateHarness();
    h.play(0.011, 2);
    const out = h.playShaped(10, speech(0.022, 0.011, 0));

    expect(out.audible).toBeGreaterThan(0);
  });
});

describe("mic gate — the rescue hatch cannot fire by accident", () => {
  it("survives a lone sub-threshold transient during a long listening pause", () => {
    // The caller speaks, then listens to the assistant for 12s. One 2.7ms
    // rustle (a breath, a chair) lands mid-pause. Latching on that single
    // frame would disable the gate for the rest of the session and hand the
    // model a continuous stream of room air — the original dead-air bug.
    const h = new GateHarness();
    h.play(QUIET_ROOM, 1);
    h.play(NORMAL_SPEECH, 2);
    h.play(QUIET_ROOM, 2);
    h.play(RUSTLE, QUANTUM_S);
    const listening = h.play(QUIET_ROOM, 12);

    expect(h.bypassed).toBe(false);
    expect(listening.audible).toBe(0);
  });

  it("is not tripped by rare blips accumulating over a long call", () => {
    // Evidence for "the gate is broken" has to be *sustained*, not summed over
    // minutes. These blips total well over BYPASS_MIN_LOUD_S of above-bar time
    // (240 blips x 4 quanta ~= 2.6s), so without the decay term the watchdog
    // would latch — that is what makes this test load-bearing rather than
    // merely passing. At a ~1% duty cycle the decay wins and nothing fires.
    const h = new GateHarness();
    h.play(QUIET_ROOM, 1);
    const out = h.playShaped(120, (t) => (t % 0.5 < QUANTUM_S * 4 ? RUSTLE : QUIET_ROOM));

    expect(h.bypassed).toBe(false);
    expect(out.audible).toBe(0);
  });

  it("treats an abrupt sustained noise step as a room, not a muted caller", () => {
    // A compressor kicks on mid-call while the caller is silent. The rolling
    // minimum lags the step by up to two windows, so for a few seconds the new
    // level sits above the rescue bar. Counting that as "we are muting someone"
    // un-gates the mic for the rest of the session and streams the whole room
    // to the model — the dead-air bug, restored. Continuous above-bar audio
    // with no gaps is a room: speech pauses, compressors do not.
    const h = new GateHarness();
    h.play(0.004, 6); // quiet office; calibrates here
    const afterStep = h.play(0.009, 12); // 2.25x step, caller still silent

    expect(h.bypassed).toBe(false);
    expect(afterStep.audibleRatio).toBeLessThan(0.05);
  });

  it("survives a non-finite frame without poisoning the noise floor", () => {
    // NaN loses every comparison, so one bad sample folded into the floor mutes
    // the gate forever AND starves the rescue that would undo it. Drop the
    // frame; the caller must still be heard on the next word.
    const h = new GateHarness();
    h.play(QUIET_ROOM, 1.5);
    h.play(NaN, QUANTUM_S * 4);
    const speaking = h.play(NORMAL_SPEECH, 2);

    expect(speaking.audibleRatio).toBeGreaterThan(0.9);
  });

  it("ignores the echo of the assistant's own voice", () => {
    // AEC residue that lands in the narrow band between the rescue bar and the
    // open threshold looks exactly like a caller we are wrongly muting — and it
    // arrives while the assistant is greeting, the watchdog's first window.
    const h = new GateHarness();
    h.play(QUIET_ROOM, 1);
    h.setAssistantSpeaking(true);
    h.playShaped(10, (t) => (t % 0.4 < 0.25 ? 0.005 : QUIET_ROOM));
    h.setAssistantSpeaking(false);

    expect(h.bypassed).toBe(false);
  });
});
