"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Bot, CheckCircle2, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { VoiceWaveform } from "@/components/ui/voice-waveform";
import type { TranscriptMessage } from "@/lib/voice-test";
import { cn } from "@/lib/utils";
import { isNearBottom } from "./bubble-state";
import type { OwnerAssistantSession } from "./owner-assistant-provider";

// SCRUM-597: the owner assistant's session UI, shared by /assistant-line and the
// floating bubble so both drive the one session the same way.

interface OwnerAssistantControlsProps {
  session: OwnerAssistantSession;
  /** The floating panel's smaller layout; /assistant-line uses the full size. */
  compact?: boolean;
}

/** Start talking, Mute, End and Talk again, for whichever state the session is in. */
export function OwnerAssistantControls({ session, compact = false }: OwnerAssistantControlsProps) {
  const { status, isMuted, isAssistantSpeaking, start, stop, toggleMute, reset } = session;

  // Reset first: the hook keeps isMuted from a session that died while muted,
  // but the new session's microphone starts live, so the mute button would say
  // "muted" while the assistant hears everything.
  const handleStart = () => {
    reset();
    void start();
  };

  const handleTalkAgain = () => {
    reset();
  };

  const circle = cn("flex items-center justify-center rounded-full", compact ? "h-12 w-12" : "h-20 w-20");
  const circleIcon = compact ? "h-6 w-6" : "h-10 w-10";

  return (
    <div className={cn("flex flex-col items-center", compact ? "space-y-3" : "space-y-4")}>
      {(status === "idle" || status === "error") && (
        <>
          <div className={cn(circle, "bg-primary/10")}>
            <Bot className={cn(circleIcon, "text-primary")} />
          </div>
          <p className={cn("text-center text-muted-foreground", compact && "text-sm")}>
            Click below and allow the microphone when your browser asks.
          </p>
          <Button size={compact ? "default" : "lg"} onClick={handleStart} className="btn-primary-glow">
            <Mic className="mr-2 h-5 w-5" />
            Start talking
          </Button>
        </>
      )}

      {status === "connecting" && (
        <>
          <div className={cn(circle, "bg-yellow-500/10")}>
            <Loader2 className={cn(circleIcon, "text-yellow-500 motion-safe:animate-spin")} />
          </div>
          <p className={cn("text-center text-muted-foreground", compact && "text-sm")}>Connecting to your assistant...</p>
          <Badge variant="secondary">Requesting microphone access</Badge>
        </>
      )}

      {status === "active" && (
        <>
          <div className="flex flex-col items-center gap-3">
            <div
              className={cn(
                circle,
                "transition-all",
                isAssistantSpeaking ? "scale-105 bg-green-500/20" : "bg-green-500/10",
              )}
            >
              <Bot className={cn(circleIcon, "text-green-500")} />
            </div>
            <VoiceWaveform isActive={isAssistantSpeaking} className="h-6 text-green-500" />
          </div>
          <Badge variant="default" className="bg-green-500">
            {isAssistantSpeaking ? "Speaking" : "Listening"}
          </Badge>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={toggleMute}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
            >
              {isMuted ? <MicOff className="h-5 w-5 text-destructive" /> : <Mic className="h-5 w-5" />}
            </Button>
            <Button variant="destructive" onClick={stop}>
              <PhoneOff className="mr-2 h-5 w-5" />
              End
            </Button>
          </div>
        </>
      )}

      {status === "ended" && (
        <>
          <div className={cn(circle, "bg-primary/10")}>
            <CheckCircle2 className={cn(circleIcon, "text-primary")} />
          </div>
          <p className="text-center font-medium">Session ended</p>
          <p className="text-center text-sm text-muted-foreground">Any changes are in your call log.</p>
          <Button variant="outline" onClick={handleTalkAgain}>
            Talk again
          </Button>
        </>
      )}
    </div>
  );
}

interface OwnerAssistantTranscriptProps {
  transcript: TranscriptMessage[];
  /** h2 on /assistant-line, under the page's h1; h3 in the bubble, under its own h2. */
  headingLevel?: "h2" | "h3";
  /** Caps the list's height; it scrolls inside. */
  listClassName?: string;
}

/** The live conversation, following the newest line. Renders nothing until there is one. */
export function OwnerAssistantTranscript({
  transcript,
  headingLevel: Heading = "h2",
  listClassName,
}: OwnerAssistantTranscriptProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Follows the newest line unless the owner has scrolled up to reread. Setting
  // scrollTop moves only this box; scrollIntoView() would scroll the page too.
  const followRef = useRef(true);

  useEffect(() => {
    // A new session starts from an empty transcript: follow it from its first line.
    if (transcript.length === 0) {
      followRef.current = true;
      return;
    }
    const list = listRef.current;
    if (list && followRef.current) list.scrollTop = list.scrollHeight;
  }, [transcript]);

  if (transcript.length === 0) return null;

  return (
    <div>
      <Heading className="mb-3 text-sm font-medium">Conversation</Heading>
      <div
        ref={listRef}
        onScroll={(event) => {
          followRef.current = isNearBottom(event.currentTarget);
        }}
        className={cn("space-y-2 overflow-y-auto", listClassName)}
      >
        {transcript.map((message, index) => (
          <div
            key={index}
            className={`rounded-lg p-2 text-sm ${
              message.role === "assistant" ? "bg-primary/10 text-primary" : "bg-muted"
            }`}
          >
            <span className="font-medium">{message.role === "assistant" ? "Assistant: " : "You: "}</span>
            {message.content}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The session's error, if it has one. */
export function OwnerAssistantError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}
