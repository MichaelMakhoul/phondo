"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Stethoscope,
  Scale,
  Wrench,
  Loader2,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { useVoiceTest, type TranscriptMessage } from "@/lib/voice-test/use-voice-test";
import { DEMO_INDUSTRIES, DEMO_RATE_LIMIT_ERROR, type DemoIndustry } from "@/lib/demo/config";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";

const INDUSTRY_CARDS: {
  id: DemoIndustry;
  label: string;
  icon: typeof Stethoscope;
  color: string;
  description: string;
  suggestions: string[];
}[] = [
  {
    id: "dental",
    label: "Dental Practice",
    icon: Stethoscope,
    color: "bg-rose-500/10 text-rose-500",
    description: DEMO_INDUSTRIES.dental.description,
    suggestions: [
      "I'd like to schedule a cleaning",
      "Do you accept my insurance?",
      "My tooth has been hurting",
    ],
  },
  {
    id: "legal",
    label: "Law Firm",
    icon: Scale,
    color: "bg-blue-500/10 text-blue-500",
    description: DEMO_INDUSTRIES.legal.description,
    suggestions: [
      "I need help with a personal injury case",
      "How much does a consultation cost?",
      "Can I speak with an attorney?",
    ],
  },
  {
    id: "home_services",
    label: "Home Services",
    icon: Wrench,
    color: "bg-amber-500/10 text-amber-500",
    description: DEMO_INDUSTRIES.home_services.description,
    suggestions: [
      "My hot water system isn't working",
      "Can someone come out today?",
      "How much do you charge for a service call?",
    ],
  },
];

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function supportsAudioWorklet(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window.AudioContext && typeof AudioWorkletNode !== "undefined");
}

type DemoState = "select" | "calling" | "ended";

function getHeroSubtitle(demoState: DemoState, selectedIndustry: DemoIndustry | null): string {
  switch (demoState) {
    case "select":
      return "Pick an industry and have a real conversation with our AI. No signup needed \u2014 just your microphone.";
    case "calling":
      return `Speaking with ${selectedIndustry ? DEMO_INDUSTRIES[selectedIndustry].name : "AI"}`;
    case "ended":
      return "Call complete";
  }
}

export default function DemoPage() {
  const [demoState, setDemoState] = useState<DemoState>("select");
  const [selectedIndustry, setSelectedIndustry] = useState<DemoIndustry | null>(null);
  const [duration, setDuration] = useState(0);
  const [audioSupported] = useState(() => supportsAudioWorklet());
  const [rateLimited, setRateLimited] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const assistantId = selectedIndustry
    ? DEMO_INDUSTRIES[selectedIndustry].assistantId
    : "";

  const tokenBody = useMemo(
    () => (selectedIndustry ? { industry: selectedIndustry } : undefined),
    [selectedIndustry]
  );

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
  } = useVoiceTest({
    assistantId,
    tokenUrl: "/api/v1/demo-call/token",
    tokenBody,
  });

  useEffect(() => {
    if (status === "active") {
      setDuration(0);
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);

  useEffect(() => {
    if (demoState === "calling" && (status === "ended" || status === "error")) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setDemoState("ended");
    }
  }, [status, demoState]);

  useEffect(() => {
    if (error?.includes(DEMO_RATE_LIMIT_ERROR)) {
      setRateLimited(true);
    }
  }, [error]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const handleStartDemo = useCallback(
    (industry: DemoIndustry) => {
      setSelectedIndustry(industry);
      setDemoState("calling");
      setDuration(0);
      setRateLimited(false);
    },
    []
  );

  const hasStartedRef = useRef(false);
  useEffect(() => {
    if (demoState === "calling" && selectedIndustry && !hasStartedRef.current) {
      hasStartedRef.current = true;
      start().catch((err) => {
        console.error("[DemoPage] Unexpected error starting demo call:", err);
      });
    }
  }, [demoState, selectedIndustry, start]);

  const handleTryAnother = useCallback(() => {
    reset();
    hasStartedRef.current = false;
    setSelectedIndustry(null);
    setDemoState("select");
    setDuration(0);
    setRateLimited(false);
  }, [reset]);

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-12 text-center sm:py-16">
            <Badge className="mb-4 border-orange-500/30 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20">
              Live Demo
            </Badge>
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-4">
              Talk to Our AI Receptionist
            </h1>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              {getHeroSubtitle(demoState, selectedIndustry)}
            </p>
          </div>
        </section>

        <div className="container mx-auto px-4 py-12">
          {/* State: Select Industry */}
          {demoState === "select" && (
            <>
              {!audioSupported && (
                <div className="max-w-2xl mx-auto mb-8 p-4 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 rounded-lg flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-amber-800 dark:text-amber-200">Browser not supported</p>
                    <p className="text-sm text-amber-700 dark:text-amber-300">
                      Live demo calls require a modern browser with AudioWorklet support.
                      Please use the latest version of Chrome, Edge, or Firefox.
                    </p>
                  </div>
                </div>
              )}

              <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
                {INDUSTRY_CARDS.map((industry) => {
                  const Icon = industry.icon;
                  return (
                    <Card
                      key={industry.id}
                      className="transition-all border-glow-hover hover:-translate-y-1"
                    >
                      <CardHeader>
                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${industry.color}`}>
                          <Icon className="w-6 h-6" />
                        </div>
                        <CardTitle>{industry.label}</CardTitle>
                        <CardDescription>{industry.description}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <Button
                          className="w-full bg-orange-500 text-white hover:bg-orange-600"
                          onClick={() => handleStartDemo(industry.id)}
                          disabled={!audioSupported}
                        >
                          <Phone className="w-4 h-4 mr-2" />
                          Try It Now
                        </Button>
                        <p className="text-xs text-muted-foreground text-center mt-2">
                          Uses your browser microphone
                        </p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <p className="text-center text-sm text-muted-foreground mt-6">
                Our AI receptionist can be customized for any industry and business.
              </p>
            </>
          )}

          {/* State: Calling */}
          {demoState === "calling" && (
            <div className="max-w-2xl mx-auto">
              <Card className="mb-6">
                <CardHeader className="text-center border-b">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    {status === "connecting" ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
                        <span className="text-orange-500 font-medium">Connecting...</span>
                      </>
                    ) : (
                      <>
                        <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                        <span className="text-green-600 font-medium">
                          Call Active &mdash; {formatDuration(duration)}
                        </span>
                      </>
                    )}
                  </div>
                  <CardTitle>
                    {selectedIndustry ? DEMO_INDUSTRIES[selectedIndustry].name : "Demo"}
                  </CardTitle>
                  <CardDescription>
                    Speak naturally — the AI will respond in real time
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6">
                  {/* Transcript */}
                  <div className="space-y-3 min-h-[280px] max-h-[380px] overflow-y-auto mb-6 p-2">
                    {transcript.length === 0 && status === "active" && (
                      <div className="text-center mt-12">
                        <p className="text-muted-foreground mb-4">
                          Listening... try saying something like:
                        </p>
                        <div className="flex flex-wrap justify-center gap-2">
                          {INDUSTRY_CARDS.find((c) => c.id === selectedIndustry)?.suggestions.map((s) => (
                            <span
                              key={s}
                              className="text-xs bg-muted text-muted-foreground rounded-full px-3 py-1"
                            >
                              &ldquo;{s}&rdquo;
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {transcript.map((msg: TranscriptMessage, i: number) => (
                      <div
                        key={i}
                        className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg px-4 py-2 ${
                            msg.role === "user"
                              ? "bg-orange-500 text-white"
                              : "bg-muted text-foreground"
                          }`}
                        >
                          <div className="text-xs mb-1 opacity-70">
                            {msg.role === "user" ? "You" : "AI Receptionist"}
                          </div>
                          <p className="text-sm">{msg.content}</p>
                        </div>
                      </div>
                    ))}
                    {isAssistantSpeaking && (
                      <div className="flex justify-start">
                        <div className="bg-muted rounded-lg px-4 py-2">
                          <div className="flex space-x-1">
                            <div className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" />
                            <div className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: "0.1s" }} />
                            <div className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" style={{ animationDelay: "0.2s" }} />
                          </div>
                        </div>
                      </div>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>

                  {/* Call Controls */}
                  <div className="flex items-center justify-center gap-4">
                    <Button
                      variant="outline"
                      size="icon"
                      className="rounded-full w-12 h-12"
                      onClick={toggleMute}
                      disabled={status !== "active"}
                    >
                      {isMuted ? (
                        <MicOff className="w-5 h-5 text-red-500" />
                      ) : (
                        <Mic className="w-5 h-5" />
                      )}
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon"
                      className="rounded-full w-16 h-16"
                      onClick={stop}
                      disabled={status === "connecting"}
                    >
                      <PhoneOff className="w-6 h-6" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* State: Ended */}
          {demoState === "ended" && (
            <div className="max-w-2xl mx-auto text-center">
              {rateLimited && (
                <Card className="mb-8">
                  <CardContent className="p-8">
                    <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                    <h2 className="text-xl font-semibold mb-2">
                      Rate limit reached
                    </h2>
                    <p className="text-muted-foreground mb-6">
                      You&apos;ve used all your demo calls for this hour. Sign up for a free trial to make unlimited test calls.
                    </p>
                    <Link href="/signup">
                      <Button className="bg-orange-500 text-white hover:bg-orange-600">Start Free Trial</Button>
                    </Link>
                  </CardContent>
                </Card>
              )}

              {error && !rateLimited && (
                <Card className="mb-8">
                  <CardContent className="p-8">
                    <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
                    <h2 className="text-xl font-semibold mb-2">
                      Demo temporarily unavailable
                    </h2>
                    <p className="text-muted-foreground mb-6">
                      {error}
                    </p>
                    <Button variant="outline" onClick={handleTryAnother}>
                      Try Again
                    </Button>
                  </CardContent>
                </Card>
              )}

              {!error && !rateLimited && (
                <Card className="mb-8">
                  <CardContent className="p-8">
                    <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                      <Phone className="w-8 h-8 text-green-600 dark:text-green-400" />
                    </div>
                    <h2 className="text-2xl font-bold mb-2">Call Complete</h2>
                    <p className="text-muted-foreground text-sm mb-4">
                      Duration: {formatDuration(duration)}
                    </p>
                    <p className="text-lg text-muted-foreground mb-8 max-w-md mx-auto">
                      Imagine that running 24/7 for your business — never missing a call, always professional.
                    </p>
                    <div className="flex flex-col sm:flex-row justify-center gap-3">
                      <Button variant="outline" onClick={handleTryAnother}>
                        Try Another Industry
                      </Button>
                      <Link href="/signup">
                        <Button className="w-full sm:w-auto bg-orange-500 text-white hover:bg-orange-600">
                          Start Free Trial
                        </Button>
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              )}

              {transcript.length > 0 && !error && (
                <Card className="text-left mb-8">
                  <CardHeader>
                    <CardTitle className="text-base">Conversation Transcript</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {transcript.map((msg: TranscriptMessage, i: number) => (
                        <div key={i} className="text-sm">
                          <span className={`font-medium ${msg.role === "user" ? "text-orange-500" : "text-foreground"}`}>
                            {msg.role === "user" ? "You" : "AI"}:
                          </span>{" "}
                          <span className="text-muted-foreground">{msg.content}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </div>

        {/* Features Section */}
        <section className="border-t bg-slate-50 dark:bg-slate-900 py-16">
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-3xl font-bold mb-10">
              Why Businesses Choose Hola Recep
            </h2>
            <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
              {[
                { value: "24/7", title: "Always Available", desc: "Never miss a call, even after hours or during busy periods" },
                { value: "62%", title: "Calls Recovered", desc: "Small businesses miss 62% of calls — each one costs ~$450 in lost revenue" },
                { value: "5 min", title: "Setup Time", desc: "Get your AI receptionist running in under 5 minutes" },
              ].map((item) => (
                <div key={item.value}>
                  <div className="text-4xl font-bold text-orange-500 mb-4">{item.value}</div>
                  <h3 className="font-semibold mb-2">{item.title}</h3>
                  <p className="text-muted-foreground">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 text-center">
            <h2 className="text-3xl font-bold text-white mb-4">
              Ready to Never Miss a Call Again?
            </h2>
            <p className="text-slate-400 mb-8 max-w-xl mx-auto">
              Start your 14-day free trial today. No credit card required.
              Set up in 5 minutes.
            </p>
            <Link href="/signup">
              <Button size="lg" className="gap-2 bg-orange-500 text-white hover:bg-orange-600 animate-glow-pulse">
                Start Free Trial
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
