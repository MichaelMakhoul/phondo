"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { usePathname } from "next/navigation";
import { Bot, Loader2, Mic, MicOff, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeBubbleState, shouldShowFloatingBubble, type BubbleIndicator } from "./bubble-state";
import { useOwnerAssistant } from "./owner-assistant-provider";
import { OwnerAssistantControls, OwnerAssistantError, OwnerAssistantTranscript } from "./owner-assistant-session-ui";

// Above the mobile bottom nav (plus the home-bar inset it pads for), in the
// corner from md up. z-40 keeps dialogs, sheets and toasts (z-50 and up) on top.
const ANCHOR = "fixed bottom-[calc(5rem_+_env(safe-area-inset-bottom))] z-40 md:bottom-6";

const LAUNCHER_COLORS: Record<BubbleIndicator, string> = {
  ready: "bg-primary text-primary-foreground hover:bg-primary/90",
  connecting: "bg-primary text-primary-foreground hover:bg-primary/90",
  listening: "bg-green-500 text-white hover:bg-green-600",
  speaking: "bg-green-500 text-white hover:bg-green-600",
  muted: "border border-destructive/50 bg-background text-destructive hover:bg-accent",
  ended: "bg-primary text-primary-foreground hover:bg-primary/90",
  error: "bg-primary text-primary-foreground hover:bg-primary/90",
};

/**
 * SCRUM-597: the always-on owner assistant, floating at the bottom right of
 * every dashboard page. Collapsed, it is a round button showing the session's
 * state; expanded, the session's panel. It drives the provider's one session, so
 * moving between pages never interrupts a conversation, and it steps aside on
 * /assistant-line, which shows that same session inline.
 */
export function OwnerAssistantBubble() {
  const assistant = useOwnerAssistant();
  const pathname = usePathname();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus goes once the owner's open or minimise has rendered. Null when
  // the change wasn't theirs (the remembered state restored on load), so loading
  // a page never steals focus.
  const focusAfterToggleRef = useRef<"panel" | "launcher" | null>(null);
  const panelState = assistant?.panelState ?? null;

  useEffect(() => {
    const target = focusAfterToggleRef.current;
    focusAfterToggleRef.current = null;
    if (target === "panel") panelRef.current?.focus();
    if (target === "launcher") launcherRef.current?.focus();
  }, [panelState]);

  if (!assistant || panelState === null || !shouldShowFloatingBubble(pathname)) return null;

  const { session, openPanel, minimisePanel } = assistant;
  const { indicator, ariaLabel, announcement } = describeBubbleState(session);
  const isMinimised = panelState === "minimised";

  const open = () => {
    focusAfterToggleRef.current = "panel";
    openPanel();
  };
  const minimise = () => {
    focusAfterToggleRef.current = "launcher";
    minimisePanel();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      minimise();
    }
  };

  return (
    <>
      {isMinimised ? (
        <button
          ref={launcherRef}
          type="button"
          onClick={open}
          aria-label={ariaLabel}
          className={cn(
            ANCHOR,
            "right-4 flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:right-6",
            LAUNCHER_COLORS[indicator],
          )}
        >
          {indicator === "speaking" && (
            <span aria-hidden="true" className="absolute inset-0 rounded-full bg-green-400 opacity-75 motion-safe:animate-ping" />
          )}
          <LauncherIcon indicator={indicator} />
          {indicator === "error" && (
            <span
              aria-hidden="true"
              className="absolute right-0 top-0 h-3.5 w-3.5 rounded-full border-2 border-background bg-destructive"
            />
          )}
        </button>
      ) : (
        <div
          ref={panelRef}
          role="region"
          aria-label="Your assistant"
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className={cn(
            ANCHOR,
            "left-4 right-4 flex max-h-[calc(100dvh_-_9rem)] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-xl focus:outline-none",
            "md:left-auto md:right-6 md:max-h-[min(36rem,calc(100dvh_-_3rem))] md:w-96",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" aria-hidden="true" />
              <h2 className="text-sm font-semibold">Your assistant</h2>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={minimise}
              aria-label="Minimise your assistant"
            >
              <Minus className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <p className="text-xs text-muted-foreground">
              Changes are real: it reads every change back and waits for your yes. Sessions last up to 8 minutes.
            </p>
            <OwnerAssistantControls session={session} compact />
            <OwnerAssistantTranscript transcript={session.transcript} headingLevel="h3" listClassName="max-h-60" />
            <OwnerAssistantError error={session.error} />
          </div>
        </div>
      )}
      {/* Session changes for screen readers. An error is left to the panel's own
          alert while that is showing, so it isn't read out twice. */}
      <p role="status" className="sr-only">
        {isMinimised || indicator !== "error" ? announcement : ""}
      </p>
    </>
  );
}

function LauncherIcon({ indicator }: { indicator: BubbleIndicator }) {
  const className = "relative h-6 w-6";
  switch (indicator) {
    case "connecting":
      return <Loader2 className={cn(className, "motion-safe:animate-spin")} />;
    case "listening":
      return <Mic className={className} />;
    case "muted":
      return <MicOff className={className} />;
    default:
      return <Bot className={className} />;
  }
}
