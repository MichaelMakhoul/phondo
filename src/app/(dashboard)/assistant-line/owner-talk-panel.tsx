"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Bot, CheckCircle2, Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import { useVoiceTest } from "@/lib/voice-test";
import { VoiceWaveform } from "@/components/ui/voice-waveform";
import { OWNER_ASSISTANT_TOKEN_URL } from "@/lib/owner-assistant/web";

const EXAMPLE_ASKS = ["What's on today?", "Any messages for me?", "Move the 2pm to Thursday."];

interface OwnerTalkPanelProps {
  /** The org's first active assistant (its voice), or null when there is none. */
  assistantId: string | null;
  /** The assistants read failed: an error, not the "set one up" state. */
  loadFailed?: boolean;
}

/**
 * SCRUM-596: talk to the owner assistant in the browser. It is the phone line's
 * assistant, with the dashboard login instead of the PIN.
 */
export function OwnerTalkPanel({ assistantId, loadFailed = false }: OwnerTalkPanelProps) {
  if (loadFailed) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Couldn&apos;t load your assistant. Refresh the page to try again.</AlertDescription>
        </Alert>
      </PageShell>
    );
  }
  if (!assistantId) {
    return (
      <PageShell>
        <Card className="space-y-3 p-6 text-center">
          <p className="font-medium">Set up your AI receptionist first</p>
          <p className="text-sm text-muted-foreground">Your assistant talks in your receptionist&apos;s voice.</p>
          <Button asChild>
            <Link href="/assistants">Go to Assistants</Link>
          </Button>
        </Card>
      </PageShell>
    );
  }
  return (
    <PageShell>
      <OwnerTalk assistantId={assistantId} />
    </PageShell>
  );
}

function OwnerTalk({ assistantId }: { assistantId: string }) {
  const { status, isMuted, transcript, error, isAssistantSpeaking, start, stop, toggleMute, reset } =
    useVoiceTest({ assistantId, tokenUrl: OWNER_ASSISTANT_TOKEN_URL, trackingSource: "owner_assistant" });

  const handleTalkAgain = () => {
    reset();
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-sm font-medium">Things you can ask</p>
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {EXAMPLE_ASKS.map((ask) => (
            <li key={ask}>&ldquo;{ask}&rdquo;</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Changes are real: it reads every change back and waits for your yes. Customers aren&apos;t told automatically.
        </p>
      </div>

      <Card className="p-6">
        <div className="flex flex-col items-center space-y-4">
          {(status === "idle" || status === "error") && (
            <>
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
                <Bot className="h-10 w-10 text-primary" />
              </div>
              <p className="text-center text-muted-foreground">Click below and allow the microphone when your browser asks.</p>
              <Button size="lg" onClick={start} className="btn-primary-glow">
                <Mic className="mr-2 h-5 w-5" />
                Start talking
              </Button>
            </>
          )}

          {status === "connecting" && (
            <>
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-yellow-500/10">
                <Loader2 className="h-10 w-10 animate-spin text-yellow-500" />
              </div>
              <p className="text-center text-muted-foreground">Connecting to your assistant...</p>
              <Badge variant="secondary">Requesting microphone access</Badge>
            </>
          )}

          {status === "active" && (
            <>
              <div className="flex flex-col items-center gap-3">
                <div
                  className={`flex h-20 w-20 items-center justify-center rounded-full transition-all ${
                    isAssistantSpeaking ? "scale-105 bg-green-500/20" : "bg-green-500/10"
                  }`}
                >
                  <Bot className="h-10 w-10 text-green-500" />
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
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
                <CheckCircle2 className="h-10 w-10 text-primary" />
              </div>
              <p className="text-center font-medium">Session ended</p>
              <p className="text-center text-sm text-muted-foreground">Any changes are in your call log.</p>
              <Button variant="outline" onClick={handleTalkAgain}>
                Talk again
              </Button>
            </>
          )}
        </div>
      </Card>

      {transcript.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-medium">Conversation</h2>
          <div className="max-h-64 space-y-2 overflow-y-auto">
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
        </Card>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="container max-w-2xl py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Your assistant</h1>
        <p className="text-muted-foreground">
          Ask about your bookings and messages, or move or cancel a job. It&apos;s the same assistant as your phone
          line, without the PIN.
        </p>
      </div>
      {children}
    </div>
  );
}
