/**
 * Telnyx call transfer and SMS using REST API.
 * Uses raw fetch to keep dependencies light (mirrors twilio-transfer.js pattern).
 *
 * Telnyx TeXML calls are transferred by updating the call with new TeXML
 * containing a <Dial> verb, same as Twilio. The difference is the API endpoint.
 */

const { Sentry } = require("../lib/sentry");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";

/**
 * Fetch helper for Telnyx v2 REST API.
 */
async function telnyxFetch(path, options = {}) {
  if (!TELNYX_API_KEY) {
    console.warn("[Telnyx] API key not set — cannot make Telnyx API calls");
    return null;
  }

  return fetch(`${TELNYX_API_BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

/**
 * Transfer a Telnyx TeXML call by updating it with new TeXML containing <Dial>.
 * Uses the Telnyx Call Control API to update the active call.
 *
 * @param {string} callControlId - Telnyx call control ID
 * @param {string} transferTo - Phone number to transfer to
 * @param {string} announcement - TTS text to say before connecting
 * @param {string} publicUrl - Voice server public URL for callbacks
 * @returns {Promise<{ success: boolean, outcome?: string }>}
 */
async function transferCall(callControlId, transferTo, announcement, publicUrl) {
  try {
    // Use Telnyx Call Control transfer action
    const res = await telnyxFetch(`/calls/${callControlId}/actions/transfer`, {
      method: "POST",
      body: JSON.stringify({
        to: transferTo,
        from: "+61000000000", // Will be overridden by Telnyx with the original number
        timeout_secs: 30,
        custom_headers: [],
      }),
    });

    if (!res || !res.ok) {
      const errText = res ? await res.text().catch(() => "") : "No API key";
      console.error(`[Telnyx] Transfer failed: ${errText}`);
      return { success: false, outcome: "failed" };
    }

    return { success: true, outcome: "initiated" };
  } catch (err) {
    console.error("[Telnyx] Transfer error:", err);
    Sentry.captureException(err);
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
      const errText = res ? await res.text().catch(() => "") : "No API key";
      console.error(`[Telnyx] SMS send failed: ${errText}`);
      return null;
    }

    const data = await res.json();
    return data.data?.id || null;
  } catch (err) {
    console.error("[Telnyx] SMS error:", err);
    return null;
  }
}

module.exports = { transferCall, sendTransferSMS };
