/**
 * SCRUM-535: fail over to a secondary realtime provider when the PRIMARY
 * session never comes up — and only then.
 *
 * The failover window closes the moment the primary completes setup. Before
 * that point the caller has heard nothing, so swapping providers is
 * invisible. After it, a swap would re-greet a caller who might be halfway
 * through a booking, with a model that has no memory of it — strictly worse
 * than the existing apologise-and-hang-up path, which is why this module
 * refuses to try.
 *
 * Wraps two session factories behind the shared session-handle interface
 * (sendAudio / sendText / getTranscripts / close / readyState). The fallback
 * session reports its own failures through the ORIGINAL callbacks, so a
 * fallback that also fails degrades to exactly today's behaviour.
 */

/**
 * @typedef {object} FailoverOptions
 * @property {(cfg: object, cbs: object) => object} fallbackFactory - builds the secondary session
 * @property {boolean} enabled - kill switch (env-resolved by the caller)
 * @property {() => boolean} [canFailover] - extra gate, e.g. "the Twilio socket is still open"
 * @property {(reason: string, err: Error|undefined) => void} [onFailover] - fires exactly once,
 *   AFTER the fallback session was successfully constructed. A fallback that
 *   throws at construction is NOT a failover — the call dies on the original
 *   error and must be recorded as such.
 */

/**
 * @param {(cfg: object, cbs: object) => object} primaryFactory
 * @param {FailoverOptions} options
 * @param {object} config - passed verbatim to both factories
 * @param {object} callbacks - the call-site callbacks; augmented, never replaced
 * @returns {object} a session handle that delegates to whichever session is live
 */
function createSessionWithFailover(primaryFactory, options, config, callbacks) {
  let attempted = false; // one shot, spent even if the fallback fails to build
  let failedOver = false; // true only once the fallback session EXISTS
  let primarySetupDone = false;
  /** @type {any} */
  let active;

  // The fallback's own lifecycle flows to the original callbacks untouched —
  // it can never trigger another failover. Its setup watchdog (armed from
  // construction in openai-realtime.js) routes here through onSetupTimeout,
  // which lands on the call site's apology-then-hangup handler.
  const fallbackCallbacks = {
    ...callbacks,
    onSetupTimeout: (err) => {
      (callbacks.onSetupTimeout || callbacks.onError)?.(err);
    },
  };

  /**
   * @param {string} reason
   * @param {Error|undefined} err
   * @returns {boolean} true iff the fallback session is now live
   */
  function attemptFailover(reason, err) {
    if (attempted || primarySetupDone || !options.enabled) return false;
    if (options.canFailover && !options.canFailover()) return false;
    attempted = true;

    // Close the primary first: its post-close error/close events are
    // swallowed below, so they cannot re-enter the call site's teardown
    // handling after the fallback has taken over.
    try {
      active.close();
    } catch {
      /* the primary socket may already be dead — that is why we are here */
    }

    try {
      active = options.fallbackFactory(config, fallbackCallbacks);
    } catch (buildErr) {
      // The fallback could not even be constructed (e.g. its API key is
      // missing). Surface the ORIGINAL failure through the original path —
      // the call must be recorded as a primary failure, not a failover.
      console.error(
        `[Failover] fallback factory threw (${buildErr.message}) — degrading to the plain error path for: ${reason}`
      );
      return false;
    }

    failedOver = true;
    try {
      options.onFailover?.(reason, err);
    } catch (notifyErr) {
      // onFailover is telemetry (log/Sentry/metadata). A throw here would
      // unwind into the primary's ws event listener and kill the process —
      // dropping every concurrent call on the instance to report on one.
      console.error("[Failover] onFailover callback threw:", notifyErr?.message || notifyErr);
    }
    return true;
  }

  const primaryCallbacks = {
    ...callbacks,
    onSetupComplete: () => {
      // A setupComplete racing our own abandonment (Gemini finally answering
      // at 10.001s, the message already in flight when the watchdog fired) is
      // a lie: the socket is closing and cannot serve the call. Letting it
      // flip primarySetupDone here would re-arm event forwarding and let the
      // abandoned primary's dying close tear down the healthy fallback call.
      if (attempted) return;
      primarySetupDone = true;
      callbacks.onSetupComplete?.();
    },
    onSetupTimeout: (err) => {
      if (!attemptFailover("setup-timeout", err)) {
        (callbacks.onSetupTimeout || callbacks.onError)?.(err);
      }
    },
    onError: (err) => {
      // Pre-setup errors are failover triggers; post-setup errors belong to
      // the call site (primarySetupDone makes attemptFailover refuse).
      if (attemptFailover("error-before-setup", err)) return;
      if (failedOver) {
        // A stray second error from the abandoned primary. The call-site
        // handler would see callFailed=false and close the Twilio call —
        // killing the call the failover just saved.
        return;
      }
      callbacks.onError?.(err);
    },
    onClose: (code, reason) => {
      // A pre-setup close with no preceding error (e.g. the model rejects
      // the setup payload with a 1007) is the quietest failure there is.
      if (attemptFailover(`closed-before-setup-code-${code}`, new Error(reason || `closed with code ${code}`))) {
        return; // the close belonged to the abandoned primary; the call goes on
      }
      if (failedOver) {
        // Self-inflicted: our own close() of the abandoned primary, arriving
        // after the fallback took over. It must not reach the call site's
        // teardown handling. Plain `failedOver` — NOT `&& !primarySetupDone`,
        // which the late-setupComplete race above would defeat. When the
        // fallback failed to BUILD, failedOver stays false and the primary's
        // close correctly still flows (it is the only thing ending the call).
        return;
      }
      callbacks.onClose?.(code, reason);
    },
  };

  active = primaryFactory(config, primaryCallbacks);

  return {
    /** @param {string} twilioBase64 */
    sendAudio(twilioBase64) {
      active.sendAudio(twilioBase64);
    },
    /** @param {string} text */
    sendText(text) {
      if (typeof active.sendText === "function") active.sendText(text);
    },
    getTranscripts() {
      return active.getTranscripts();
    },
    close() {
      active.close();
    },
    get readyState() {
      return active.readyState;
    },
    /** Which provider is serving: false until the fallback session exists. */
    get failedOver() {
      return failedOver;
    },
  };
}

/**
 * Resolve the kill switch. Fails CLOSED without a fallback API key (there is
 * nothing to fail over to), and defaults ON otherwise — the whole point is
 * covering an outage nobody predicted, so it must not require opt-in at the
 * moment Gemini is already down.
 *
 * @param {string|undefined} envValue - GEMINI_LIVE_FAILOVER
 * @param {boolean} hasFallbackKey - is the fallback provider's API key set?
 * @returns {boolean}
 */
function isFailoverEnabled(envValue, hasFallbackKey) {
  if (!hasFallbackKey) return false;
  const v = String(envValue ?? "").trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "disabled");
}

module.exports = { createSessionWithFailover, isFailoverEnabled };
