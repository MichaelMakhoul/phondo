// SCRUM-597: one live voice session per browser tab. The owner's assistant bubble
// stays on every dashboard page, so a receptionist test call (or the demo) started
// meanwhile would run a second AI over the same speakers and microphone. Starting a
// session ends any other in the tab; a session forgets itself when it ends.

export interface VoiceSessionHandle {
  stop: () => void;
}

let active: VoiceSessionHandle | null = null;

/** This session is starting: stop whichever other one is live in the tab. */
export function claimVoiceSession(session: VoiceSessionHandle): void {
  if (active && active !== session) {
    const previous = active;
    active = null;
    try {
      previous.stop();
    } catch (err) {
      console.warn("[voice-test] stopping the previous voice session failed:", err instanceof Error ? err.message : err);
    }
  }
  active = session;
}

/** This session has ended (stop, reset, unmount, pagehide). A no-op for any other. */
export function releaseVoiceSession(session: VoiceSessionHandle): void {
  if (active === session) active = null;
}

/** Tests only: the session holding the tab. */
export function activeVoiceSessionForTests(): VoiceSessionHandle | null {
  return active;
}
