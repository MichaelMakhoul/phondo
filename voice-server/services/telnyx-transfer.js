/**
 * Telnyx call transfer and SMS using REST API.
 * Uses raw fetch to keep dependencies light (mirrors twilio-transfer.js pattern).
 */

const { Sentry } = require("../lib/sentry");

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Fetch helper for Telnyx v2 REST API.
 * Reads API key per-call (not module-scope) to handle late env var injection.
 */
async function telnyxFetch(path, options = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.warn("[Telnyx] API key not set — cannot make Telnyx API calls");
    return null;
  }

  return fetch(`${TELNYX_API_BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

/**
 * Transfer a Telnyx call using Call Control API.
 *
 * @param {string} callControlId - Telnyx call control ID
 * @param {string} transferTo - Phone number to transfer to
 * @param {string} announcement - TTS text to say before connecting (unused — TeXML handles this)
 * @param {{ fromPhone?: string, publicUrl?: string }} options
 * @returns {Promise<{ success: boolean, outcome?: string }>}
 */
async function transferCall(callControlId, transferTo, announcement, options = {}) {
  if (!process.env.TELNYX_API_KEY) {
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-transfer");
      Sentry.captureException(new Error("TELNYX_API_KEY not configured for transfer"));
    });
    return { success: false, outcome: "not_configured" };
  }

  try {
    const res = await telnyxFetch(`/calls/${callControlId}/actions/transfer`, {
      method: "POST",
      body: JSON.stringify({
        to: transferTo,
        from: options.fromPhone || transferTo, // Use org's number or transfer target as fallback
        timeout_secs: 30,
      }),
    });

    if (!res || !res.ok) {
      const errText = res ? await res.text().catch(() => "") : "API unavailable";
      console.error(`[Telnyx] Transfer failed (${res?.status}): ${errText.slice(0, 200)}`);
      return { success: false, outcome: "failed" };
    }

    return { success: true, outcome: "initiated" };
  } catch (err) {
    console.error("[Telnyx] Transfer error:", err);
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-transfer");
      scope.setExtra("callControlId", callControlId);
      scope.setExtra("transferTo", transferTo);
      Sentry.captureException(err);
    });
    return { success: false, outcome: "error" };
  }
}

/**
 * Send an SMS via Telnyx Messaging API.
 *
 * @param {string} toPhone - Recipient phone number
 * @param {string} fromPhone - Sender phone number (must be a Telnyx number)
 * @param {string} body - SMS text content
 * @returns {Promise<string|null>} Message ID or null on failure
 */
async function sendTransferSMS(toPhone, fromPhone, body) {
  try {
    const res = await telnyxFetch("/messages", {
      method: "POST",
      body: JSON.stringify({
        from: fromPhone,
        to: toPhone,
        text: body,
        type: "SMS",
      }),
    });

    if (!res || !res.ok) {
      const errText = res ? await res.text().catch(() => "") : "API unavailable";
      console.error(`[Telnyx] SMS send failed (${res?.status}): ${errText.slice(0, 200)}`);
      Sentry.withScope((scope) => {
        scope.setTag("service", "telnyx-sms");
        scope.setExtra("to", toPhone);
        Sentry.captureException(new Error(`Telnyx SMS failed: ${res?.status}`));
      });
      return null;
    }

    const data = await res.json();
    return data.data?.id || null;
  } catch (err) {
    console.error("[Telnyx] SMS error:", err);
    Sentry.withScope((scope) => {
      scope.setTag("service", "telnyx-sms");
      Sentry.captureException(err);
    });
    return null;
  }
}

module.exports = { transferCall, sendTransferSMS };
