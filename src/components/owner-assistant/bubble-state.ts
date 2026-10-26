/**
 * SCRUM-597: the pure logic behind the always-on owner assistant bubble, kept
 * out of the components so the repo's node vitest env (no DOM, no JSX) can
 * test it directly.
 */

import type { VoiceTestStatus } from "@/lib/voice-test";

/** Whether the floating panel is expanded or folded down to its round button. */
export type PanelState = "open" | "minimised";

export const PANEL_STATE_STORAGE_KEY = "phondo:owner-assistant-panel";

/** Minimised until the viewer opens it, so the panel never covers a page uninvited. */
export const DEFAULT_PANEL_STATE: PanelState = "minimised";

/**
 * The browser's localStorage, or null on the server or when it is blocked: with
 * site data disabled, merely reading `window.localStorage` throws a SecurityError
 * in some browsers, and returns null in others.
 */
export function getBrowserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/** The viewer's remembered panel state; the default when storage is missing, throws, or holds anything else. */
export function readPanelState(storage: Pick<Storage, "getItem"> | null): PanelState {
  if (!storage) return DEFAULT_PANEL_STATE;
  try {
    const stored = storage.getItem(PANEL_STATE_STORAGE_KEY);
    return stored === "open" || stored === "minimised" ? stored : DEFAULT_PANEL_STATE;
  } catch {
    return DEFAULT_PANEL_STATE;
  }
}

/** Remembers the panel state. False when it couldn't be stored; the panel works the same either way. */
export function writePanelState(storage: Pick<Storage, "setItem"> | null, state: PanelState): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PANEL_STATE_STORAGE_KEY, state);
    return true;
  } catch {
    return false;
  }
}

/** The page that renders the full panel inline, from the same session. */
export const ASSISTANT_LINE_PATH = "/assistant-line";

/** A session the owner is in right now (connecting or talking): never hidden or cut off. */
export function isSessionLive(status: string | null | undefined): boolean {
  return status === "connecting" || status === "active";
}

/** False on /assistant-line (it shows the same session inline, so a second UI would only confuse); true everywhere else. */
export function shouldShowFloatingBubble(pathname: string | null): boolean {
  if (!pathname) return true;
  return pathname !== ASSISTANT_LINE_PATH && !pathname.startsWith(`${ASSISTANT_LINE_PATH}/`);
}

/** What the collapsed bubble shows. */
export type BubbleIndicator = "ready" | "connecting" | "listening" | "speaking" | "muted" | "ended" | "error";

export interface BubbleStateInput {
  status: VoiceTestStatus;
  isMuted: boolean;
  isAssistantSpeaking: boolean;
}

export interface BubbleStateDescription {
  indicator: BubbleIndicator;
  /** The round button's accessible name: what clicking does, then the state. */
  ariaLabel: string;
  /**
   * What a screen reader is told when the session changes: the panel's controls
   * aren't a live region, and while it is minimised they aren't rendered at all.
   * Listening and speaking share one line, so it doesn't chatter every time the
   * assistant talks. Empty means nothing to say.
   */
  announcement: string;
}

const OPEN_ACTION = "Open your assistant";
const CONNECTED = "Connected to your assistant.";

const DESCRIPTIONS: Record<BubbleIndicator, { state: string | null; announcement: string }> = {
  ready: { state: null, announcement: "" },
  connecting: { state: "connecting", announcement: "Connecting to your assistant." },
  listening: { state: "listening", announcement: CONNECTED },
  speaking: { state: "speaking", announcement: CONNECTED },
  muted: { state: "your microphone is muted", announcement: `${CONNECTED} Your microphone is muted.` },
  ended: { state: "session ended", announcement: "Your assistant session has ended." },
  error: { state: "something went wrong", announcement: "Something went wrong with your assistant." },
};

function indicatorFor({ status, isMuted, isAssistantSpeaking }: BubbleStateInput): BubbleIndicator {
  switch (status) {
    case "idle":
      return "ready";
    case "connecting":
      return "connecting";
    case "active":
      // Muted wins over speaking: it is the owner's own setting and it lasts,
      // so it must stay visible while the assistant talks.
      if (isMuted) return "muted";
      return isAssistantSpeaking ? "speaking" : "listening";
    case "ended":
      return "ended";
    case "error":
      return "error";
  }
}

export function describeBubbleState(input: BubbleStateInput): BubbleStateDescription {
  const indicator = indicatorFor(input);
  const { state, announcement } = DESCRIPTIONS[indicator];
  return { indicator, ariaLabel: state ? `${OPEN_ACTION} (${state})` : OPEN_ACTION, announcement };
}

/** Within this many pixels of the end still counts as reading the newest line. */
export const TRANSCRIPT_FOLLOW_THRESHOLD_PX = 40;

/** Whether a scroll box is at (or near) its end, so the transcript should keep following new lines. */
export function isNearBottom(
  box: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = TRANSCRIPT_FOLLOW_THRESHOLD_PX,
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}
