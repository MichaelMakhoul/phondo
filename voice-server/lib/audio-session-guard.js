/**
 * SCRUM-343 (audit M1): DoS hardening for the LIVE inbound-call WebSocket
 * (/ws/audio).
 *
 * The production audio socket authenticates at the Twilio/Telnyx `start` message
 * (a single-use stream token in customParameters consumed by consumeStreamToken),
 * NOT at the WS upgrade. That left two gaps an attacker could use to degrade or
 * OOM the single voice-server machine — which would drop ALL in-progress
 * customer calls (uncaughtException → process.exit):
 *
 *   1. A socket that connects but never sends an authenticated `start` was held
 *      open indefinitely (no auth deadline).
 *   2. No ceiling on the number of concurrent sockets.
 *
 * (A third gap — no per-frame size bound — is closed separately by passing
 * `maxPayload` to the WebSocketServer in server.js.)
 *
 * This guard closes (1) and (2) in a way that is BACKWARD-COMPATIBLE with real
 * media streams: a legitimate call sends `start` within ~1s of connecting (far
 * under the deadline) and real concurrent load on a single machine is orders of
 * magnitude below the ceiling, so neither limit can fire on a legitimate call.
 * It deliberately does NOT change the auth handshake (token is still consumed at
 * `start`) — moving auth to the upgrade is tracked separately because it changes
 * the live `<Stream>` contract and needs a real-call verification.
 *
 * Extracted from server.js so the accounting + auth-deadline reaper is
 * unit-testable with injected timers.
 */

/**
 * @param {{
 *   maxConcurrent: number,
 *   authDeadlineMs: number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} opts
 */
function createAudioSessionGuard({
  maxConcurrent,
  authDeadlineMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let active = 0;

  /**
   * Reserve a slot for a newly-connected socket.
   *
   * Returns null when the concurrent ceiling is already reached — the caller
   * must reject the socket (close 1013). Otherwise returns a per-connection
   * controller. `onAuthTimeout` is invoked at most once, only if the connection
   * has neither authenticated nor released within authDeadlineMs.
   *
   * @param {() => void} onAuthTimeout
   * @returns {{ markAuthenticated: () => void, release: () => void } | null}
   */
  function acquire(onAuthTimeout) {
    if (active >= maxConcurrent) return null;
    active += 1;

    let released = false;
    let authenticated = false;
    const timer = setTimer(() => {
      // Re-check both flags at fire time: the connection may have authenticated
      // or torn down between scheduling and firing.
      if (!authenticated && !released) onAuthTimeout();
    }, authDeadlineMs);

    return {
      /** Mark the connection authenticated — cancels the auth-deadline reaper. */
      markAuthenticated() {
        if (authenticated || released) return;
        authenticated = true;
        clearTimer(timer);
      },
      /** Free the slot on any teardown path. Idempotent. */
      release() {
        if (released) return;
        released = true;
        clearTimer(timer);
        active = Math.max(0, active - 1);
      },
    };
  }

  function stats() {
    return { active };
  }

  return { acquire, stats };
}

module.exports = { createAudioSessionGuard };
