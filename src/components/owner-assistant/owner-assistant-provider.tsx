"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useVoiceTest } from "@/lib/voice-test";
import { onBookingsChanged } from "@/lib/voice-test/events";
import { OWNER_ASSISTANT_TOKEN_URL } from "@/lib/owner-assistant/web";
import { getBrowserStorage, readPanelState, writePanelState, type PanelState } from "./bubble-state";

/** The one voice session the floating bubble and /assistant-line share. */
export type OwnerAssistantSession = ReturnType<typeof useVoiceTest>;

export interface OwnerAssistantContextValue {
  session: OwnerAssistantSession;
  /** The assistant whose voice a new session uses; null when this render found none (a live session goes on). */
  assistantId: string | null;
  /**
   * The floating panel, as this viewer last left it. Null until it has been read
   * after mount (localStorage doesn't exist on the server), so the server and the
   * first client render agree and a remembered "open" doesn't flash closed first.
   */
  panelState: PanelState | null;
  openPanel: () => void;
  minimisePanel: () => void;
}

const OwnerAssistantContext = createContext<OwnerAssistantContextValue | null>(null);

interface OwnerAssistantProviderProps {
  /** The org's first active assistant (its voice), or null when the layout's read found none or failed. */
  assistantId: string | null;
  children: ReactNode;
}

/**
 * SCRUM-597: owns the dashboard tab's single owner assistant session. It wraps
 * the dashboard layout's content, which the App Router keeps mounted across
 * client-side navigation, so a session keeps running while the owner moves
 * between pages. A reload, closing the tab or switching org ends it: the layout
 * keys this provider by org id, and the hook tears down on unmount and pagehide.
 * Nothing here starts a session; only the owner's click does.
 */
export function OwnerAssistantProvider({ assistantId, children }: OwnerAssistantProviderProps) {
  const { status, isMuted, transcript, error, isAssistantSpeaking, start, stop, toggleMute, reset } =
    useVoiceTest({ assistantId: assistantId ?? "", tokenUrl: OWNER_ASSISTANT_TOKEN_URL, trackingSource: "owner_assistant" });

  const [panelState, setPanelState] = useState<PanelState | null>(null);
  const router = useRouter();

  // SCRUM-597: the assistant changed a booking — server-rendered pages (stats,
  // lists) re-render; client lists listen for the same event and refetch. Safe for a
  // live session: an admitted owner keeps this provider across a refresh.
  useEffect(() => onBookingsChanged(() => router.refresh()), [router]);

  useEffect(() => {
    setPanelState(readPanelState(getBrowserStorage()));
  }, []);

  const changePanelState = useCallback((next: PanelState) => {
    setPanelState(next);
    writePanelState(getBrowserStorage(), next);
  }, []);
  const openPanel = useCallback(() => changePanelState("open"), [changePanelState]);
  const minimisePanel = useCallback(() => changePanelState("minimised"), [changePanelState]);

  const value = useMemo<OwnerAssistantContextValue>(
    () => ({
      session: { status, isMuted, transcript, error, isAssistantSpeaking, start, stop, toggleMute, reset },
      assistantId,
      panelState,
      openPanel,
      minimisePanel,
    }),
    [status, isMuted, transcript, error, isAssistantSpeaking, start, stop, toggleMute, reset, assistantId, panelState, openPanel, minimisePanel],
  );

  return <OwnerAssistantContext.Provider value={value}>{children}</OwnerAssistantContext.Provider>;
}

/** The shared session and panel state, or null outside an OwnerAssistantProvider (not the owner, flag off, or no active assistant). */
export function useOwnerAssistant(): OwnerAssistantContextValue | null {
  return useContext(OwnerAssistantContext);
}
