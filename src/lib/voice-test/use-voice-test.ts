"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { mulawToAudioBuffer } from "./mulaw";
import {
  trackTestCallStarted,
  trackTestCallCompleted,
  trackTestCallMicGateBypassed,
} from "@/lib/analytics";

export interface TranscriptMessage {
  role: "assistant" | "user";
  content: string;
  timestamp?: Date;
}

export type VoiceTestStatus = "idle" | "connecting" | "active" | "ended" | "error";

interface UseVoiceTestOptions {
  assistantId: string;
  tokenUrl?: string;
  tokenBody?: Record<string, unknown>;
  trackingSource?: "dashboard" | "onboarding";
}

export function useVoiceTest({ assistantId, tokenUrl, tokenBody, trackingSource = "dashboard" }: UseVoiceTestOptions) {
  const [status, setStatus] = useState<VoiceTestStatus>("idle");
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAssistantSpeaking, setIsAssistantSpeaking] = useState(false);

  // Ref tracks latest status for use in WebSocket callbacks (avoids stale closures)
  const statusRef = useRef<VoiceTestStatus>("idle");
  const updateStatus = useCallback((newStatus: VoiceTestStatus) => {
    statusRef.current = newStatus;
    setStatus(newStatus);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Gapless playback: audio chunks are scheduled back-to-back on the
  // AudioContext timeline. The previous approach chained buffers with
  // `source.onended`, which left a small silent gap at every chunk boundary and
  // made the assistant's voice sound choppy / "breaking".
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef(0);
  const callStartTimeRef = useRef<number | null>(null);
  // Bumped on every flush. Decoding a chunk is async, so a chunk that arrived
  // just before a barge-in can finish decoding *after* flushPlayback() and would
  // otherwise schedule a stale blip of pre-interrupt audio.
  const playbackGenerationRef = useRef(0);

  const enqueueAudio = useCallback((buffer: AudioBuffer) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    // A short lookahead absorbs network jitter so we don't start a chunk before
    // the next one has arrived (an underrun also sounds like a glitch).
    const JITTER_BUFFER = 0.1; // seconds
    const now = ctx.currentTime;
    if (nextStartTimeRef.current < now + 0.02) {
      // First chunk, or the buffer drained and we fell behind — reset the clock.
      nextStartTimeRef.current = now + JITTER_BUFFER;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += buffer.duration;

    scheduledSourcesRef.current.add(source);
    source.onended = () => {
      scheduledSourcesRef.current.delete(source);
    };
  }, []);

  // Stop and drop all scheduled audio immediately. Used on barge-in (the server
  // sends a "clear" when the caller interrupts) and on teardown.
  const flushPlayback = useCallback(() => {
    scheduledSourcesRef.current.forEach((source) => {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped.
      }
    });
    scheduledSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    playbackGenerationRef.current += 1;
  }, []);

  const start = useCallback(async () => {
    updateStatus("connecting");
    setError(null);
    setTranscript([]);
    setIsAssistantSpeaking(false);
    scheduledSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    trackTestCallStarted(trackingSource);

    try {
      // 1. Get token from API
      const tokenRes = await fetch(tokenUrl || "/api/v1/test-call/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId, ...tokenBody }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to get test call token");
      }

      const { token, wsUrl } = await tokenRes.json();

      if (!token || !wsUrl) {
        throw new Error("Failed to initialize call — please try again");
      }

      // 2. Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // 3. Set up AudioContext and worklet for mulaw encoding
      const ctx = new AudioContext({ sampleRate: 48000 });
      audioContextRef.current = ctx;

      await ctx.audioWorklet.addModule("/audio-worklets/mulaw-encoder-processor.js");
      const workletNode = new AudioWorkletNode(ctx, "mulaw-encoder-processor");
      workletNodeRef.current = workletNode;

      // Registered before the node is connected — once audio flows the processor
      // can throw, and a throw stops it permanently: the caller's mic goes dead
      // mid-call with no other signal. Surface it and tear the call down, so the
      // browser's recording indicator and the server session don't outlive it.
      workletNode.onprocessorerror = () => {
        console.error("[VoiceTest] Mic processor crashed");
        setError("Microphone stopped working. Please restart the call.");
        updateStatus("error");
        cleanup();
      };

      const sourceNode = ctx.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      sourceNode.connect(workletNode);
      // Worklet doesn't produce output — it sends data via port

      // 4. Connect WebSocket
      const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      // Forward mulaw audio from worklet to WebSocket. The worklet also posts
      // plain-object gate diagnostics, which must never be sent as audio.
      workletNode.port.onmessage = (event: MessageEvent) => {
        const payload = event.data;
        // ArrayBuffer.isView, not `instanceof Uint8Array`: the worklet runs in
        // its own realm, and while postMessage structured-clones into ours, an
        // identity check on the constructor is the kind of thing that fails
        // silently — and failing here means the caller's mic goes nowhere.
        if (ArrayBuffer.isView(payload)) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
          }
          return;
        }
        if (payload?.type === "gate") {
          // The mic gate can only mute a caller by mis-calibrating; log both the
          // healthy first-open and the self-healing bypass so a "the AI can't
          // hear me" report is diagnosable rather than invisible.
          if (payload.event === "bypass") {
            console.warn(
              `[VoiceTest] Mic gate bypassed (mis-calibrated): peak=${payload.rms?.toFixed(4)} floor=${payload.floor?.toFixed(4)}`
            );
            // A console warning lives in the prospect's devtools, where nobody
            // on this team will ever read it.
            trackTestCallMicGateBypassed(trackingSource, payload.rms ?? 0, payload.floor ?? 0);
          } else {
            console.info(
              `[VoiceTest] Mic gate opened: rms=${payload.rms?.toFixed(4)} floor=${payload.floor?.toFixed(4)}`
            );
          }
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        if (event.data instanceof Blob) {
          // Binary audio data — decode mulaw and play
          const generation = playbackGenerationRef.current;
          event.data.arrayBuffer().then((ab) => {
            // A barge-in ("clear") landed while this chunk was decoding — it is
            // pre-interrupt audio and must not be scheduled.
            if (generation !== playbackGenerationRef.current) return;
            const mulawData = new Uint8Array(ab);
            if (mulawData.length > 0 && audioContextRef.current) {
              const audioBuffer = mulawToAudioBuffer(mulawData, audioContextRef.current);
              enqueueAudio(audioBuffer);
            }
          }).catch((err) => {
            console.warn("[VoiceTest] Failed to process audio data:", err);
          });
          return;
        }

        // JSON message
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return; // Non-JSON text message — ignore
        }

        switch (msg.type) {
          case "ready":
            updateStatus("active");
            callStartTimeRef.current = Date.now();
            break;

          case "clear":
            // Barge-in: the caller interrupted, so drop any audio buffered ahead.
            flushPlayback();
            break;

          case "transcript":
            if (msg.isFinal && msg.content?.trim()) {
              setTranscript((prev) => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.role === msg.role) {
                  return [
                    ...prev.slice(0, -1),
                    { role: msg.role, content: msg.content, timestamp: new Date() },
                  ];
                }
                return [...prev, { role: msg.role, content: msg.content, timestamp: new Date() }];
              });
            }
            break;

          case "speaking":
            setIsAssistantSpeaking(msg.speaking);
            // The mic gate must not mistake the echo of our own voice for a
            // caller it is wrongly muting.
            workletNode.port.postMessage({
              type: "assistant-speaking",
              speaking: msg.speaking,
            });
            break;

          case "ended": {
            const startTime = callStartTimeRef.current;
            callStartTimeRef.current = null; // Null first to prevent duplicate tracking from stop()
            const duration = startTime
              ? Math.round((Date.now() - startTime) / 1000)
              : 0;
            if (duration > 0) trackTestCallCompleted(duration, trackingSource);
            updateStatus("ended");
            break;
          }

          case "error":
            setError(msg.message || "An error occurred");
            updateStatus("error");
            break;
        }
      };

      ws.onerror = () => {
        setError("Connection error");
        updateStatus("error");
      };

      ws.onclose = (event) => {
        // SCRUM-341: the voice server rejects with close code 4029 when a
        // concurrency cap is hit (token already in use / too many sessions).
        // Surface the reason instead of silently landing in "ended".
        if (event.code === 4029 && statusRef.current !== "error") {
          setError(event.reason || "Too many active test sessions. Please try again shortly.");
          updateStatus("error");
        } else if (statusRef.current !== "ended" && statusRef.current !== "error") {
          updateStatus("ended");
        }
        cleanup();
      };
    } catch (err) {
      console.error("Failed to start test call:", err);
      setError(err instanceof Error ? err.message : "Failed to start test call");
      updateStatus("error");
      cleanup();
    }
  }, [assistantId, tokenUrl, tokenBody, trackingSource, enqueueAudio, flushPlayback, updateStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    const startTime = callStartTimeRef.current;
    callStartTimeRef.current = null; // Null first to prevent duplicate tracking from "ended" message
    const duration = startTime
      ? Math.round((Date.now() - startTime) / 1000)
      : 0;
    if (duration > 0) trackTestCallCompleted(duration, trackingSource);
    setStatus("ended");
    cleanup();
  }, [trackingSource]);

  const toggleMute = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (stream) {
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        setIsMuted(!track.enabled);
      }
    }
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setStatus("idle");
    setIsMuted(false);
    setTranscript([]);
    setError(null);
    setIsAssistantSpeaking(false);
  }, []);

  function cleanup() {
    // Stop any scheduled/playing audio
    flushPlayback();

    // Disconnect worklet
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    // Disconnect source
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status,
    isMuted,
    transcript,
    error,
    isAssistantSpeaking,
    start,
    stop,
    toggleMute,
    reset,
  };
}
