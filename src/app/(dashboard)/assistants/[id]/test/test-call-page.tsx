"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Loader2,
  CheckCircle2,
  Volume2,
  AlertCircle,
  Settings,
  ChevronDown,
  Play,
  Square,
  ArrowLeft,
  Moon,
} from "lucide-react";
import { useVoiceTest } from "@/lib/voice-test";
import { VoiceWaveform } from "@/components/ui/voice-waveform";
import {
  playVoicePreview,
  stopVoicePreview,
  isVoicePreviewPlaying,
  getVoiceById,
  VOICE_OPTIONS,
} from "@/lib/audio/voice-preview";

interface TestCallPageProps {
  assistantId: string;
  assistantData: {
    assistantName: string;
    systemPrompt: string;
    firstMessage: string;
    voiceId: string;
    hasAfterHoursHandling: boolean;
  };
}

export function TestCallPage({ assistantId, assistantData }: TestCallPageProps) {
  const router = useRouter();
  const [duration, setDuration] = useState(0);

  // Settings state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxDuration, setMaxDuration] = useState(3); // minutes
  const [simulateAfterHours, setSimulateAfterHours] = useState(false);

  // Voice preview state
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const tokenBody = useMemo(
    () => (simulateAfterHours ? { simulateAfterHours: true } : undefined),
    [simulateAfterHours]
  );

  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const {
    status,
    isMuted,
    transcript,
    error,
    isAssistantSpeaking,
    start,
    stop,
    toggleMute,
    reset,
  } = useVoiceTest({ assistantId, tokenBody });

  // Handle duration tracking and auto-end
  useEffect(() => {
    if (status === "active") {
      durationIntervalRef.current = setInterval(() => {
        setDuration((d) => {
          const newDuration = d + 1;
          if (newDuration >= maxDuration * 60) {
            stop();
          }
          return newDuration;
        });
      }, 1000);
    } else {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    }

    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
    };
  }, [status, maxDuration, stop]);

  // Clean up voice preview on unmount
  useEffect(() => {
    return () => {
      stopVoicePreview();
    };
  }, []);

  const handleVoicePreview = useCallback(async () => {
    if (isPreviewPlaying) {
      stopVoicePreview();
      setIsPreviewPlaying(false);
      return;
    }

    setPreviewError(null);
    await playVoicePreview(assistantData.voiceId || "EXAVITQu4vr4xnSDxMaL", {
      onStart: () => setIsPreviewPlaying(true),
      onEnd: () => setIsPreviewPlaying(false),
      onError: (err) => {
        setIsPreviewPlaying(false);
        setPreviewError(err);
      },
    });
  }, [assistantData.voiceId, isPreviewPlaying]);

  const handleStartCall = async () => {
    setDuration(0);
    await start();
  };

  const handleEndCall = () => {
    stop();
  };

  const handleTryAgain = () => {
    setDuration(0);
    reset();
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const selectedVoice = getVoiceById(assistantData.voiceId) || VOICE_OPTIONS[0];
  const maxDurationSeconds = maxDuration * 60;
  const remainingSeconds = Math.max(0, maxDurationSeconds - duration);
  const isNearingLimit = status === "active" && remainingSeconds <= 30;
  const displayStatus = status === "error" ? "idle" : status;

  return (
    <div className="container max-w-2xl py-8">
      {/* Header */}
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/assistants/${assistantId}`)}
          className="mb-4"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Assistant
        </Button>
        <h1 className="text-2xl font-bold">Test {assistantData.assistantName}</h1>
        <p className="text-muted-foreground">
          Have a conversation with your AI to make sure it sounds right
        </p>
      </div>

      <div className="space-y-6">
        {/* Voice Preview */}
        {displayStatus === "idle" && (
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Volume2 className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">{selectedVoice.name}</p>
                  <p className="text-sm text-muted-foreground">{selectedVoice.description}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVoicePreview}
                disabled={isPreviewPlaying && !isVoicePreviewPlaying()}
              >
                {isPreviewPlaying ? (
                  <>
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Preview
                  </>
                )}
              </Button>
            </div>
            {previewError && (
              <p className="mt-2 text-sm text-destructive">{previewError}</p>
            )}
          </Card>
        )}

        {/* Settings Panel */}
        {displayStatus === "idle" && (
          <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  <span>Settings</span>
                </div>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${
                    settingsOpen ? "rotate-180" : ""
                  }`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Card className="mt-2 p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Max Duration</Label>
                    <span className="text-sm text-muted-foreground">
                      {maxDuration} min
                    </span>
                  </div>
                  <Slider
                    value={[maxDuration]}
                    onValueChange={(value) => setMaxDuration(value[0])}
                    min={1}
                    max={5}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">
                    Call will auto-end when limit is reached
                  </p>
                </div>
                {assistantData.hasAfterHoursHandling && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="after-hours-toggle" className="flex items-center gap-2">
                        <Moon className="h-4 w-4" />
                        Simulate After Hours
                      </Label>
                      <Switch
                        id="after-hours-toggle"
                        checked={simulateAfterHours}
                        onCheckedChange={setSimulateAfterHours}
                        disabled={status !== "idle"}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Test your after-hours greeting and behavior as if calling outside business hours
                    </p>
                  </div>
                )}
              </Card>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Call Status Card */}
        <Card className="p-6">
          <div className="flex flex-col items-center space-y-4">
            {displayStatus === "idle" && (
              <>
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
                  <Phone className="h-10 w-10 text-primary" />
                </div>
                <p className="text-center text-muted-foreground">
                  Click the button below to start a test call
                </p>
                <Button size="lg" onClick={handleStartCall}>
                  <Phone className="mr-2 h-5 w-5" />
                  Start Test Call
                </Button>
              </>
            )}

            {displayStatus === "connecting" && (
              <>
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-yellow-500/10">
                  <Loader2 className="h-10 w-10 animate-spin text-yellow-500" />
                </div>
                <p className="text-center text-muted-foreground">
                  Connecting to your AI receptionist...
                </p>
                <Badge variant="secondary">Requesting microphone access</Badge>
              </>
            )}

            {displayStatus === "active" && (
              <>
                <div className="flex flex-col items-center gap-3">
                  <div
                    className={`flex h-20 w-20 items-center justify-center rounded-full transition-all ${
                      isAssistantSpeaking
                        ? "bg-green-500/20 scale-105"
                        : "bg-green-500/10"
                    }`}
                  >
                    <Phone className="h-10 w-10 text-green-500" />
                  </div>
                  <VoiceWaveform
                    isActive={isAssistantSpeaking}
                    className="text-green-500 h-6"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="default" className="bg-green-500">
                    Call Active
                  </Badge>
                  <Badge variant={isNearingLimit ? "destructive" : "outline"}>
                    {formatDuration(duration)} / {maxDuration}:00
                  </Badge>
                </div>

                {isNearingLimit && (
                  <p className="text-sm text-destructive">
                    Call ending in {remainingSeconds} seconds
                  </p>
                )}

                <div className="flex gap-2">
                  <Button variant="outline" size="icon" onClick={toggleMute}>
                    {isMuted ? (
                      <MicOff className="h-5 w-5 text-destructive" />
                    ) : (
                      <Mic className="h-5 w-5" />
                    )}
                  </Button>
                  <Button variant="destructive" onClick={handleEndCall}>
                    <PhoneOff className="mr-2 h-5 w-5" />
                    End Call
                  </Button>
                </div>
              </>
            )}

            {displayStatus === "ended" && (
              <>
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
                  <CheckCircle2 className="h-10 w-10 text-primary" />
                </div>
                <p className="text-center font-medium">Test call completed!</p>
                <p className="text-center text-sm text-muted-foreground">
                  Duration: {formatDuration(duration)}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={handleTryAgain}>
                    Try Again
                  </Button>
                  <Button onClick={() => router.push(`/assistants/${assistantId}`)}>
                    Back to Assistant
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* Transcript */}
        {transcript.length > 0 && (
          <Card className="p-4">
            <h4 className="mb-3 text-sm font-medium">Conversation Transcript</h4>
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {transcript.map((message, index) => (
                <div
                  key={index}
                  className={`rounded-lg p-2 text-sm ${
                    message.role === "assistant"
                      ? "bg-primary/10 text-primary"
                      : "bg-muted"
                  }`}
                >
                  <span className="font-medium">
                    {message.role === "assistant" ? "AI: " : "You: "}
                  </span>
                  {message.content}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
