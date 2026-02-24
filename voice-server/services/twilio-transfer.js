/**
 * Twilio call transfer using REST API.
 * Uses raw fetch to keep dependencies light (no Twilio SDK).
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

/**
 * POST to a Twilio REST API endpoint with Basic auth and form-encoded body.
 * Returns the Response object, or null if credentials are missing.
 *
 * @param {string} path - Twilio API path after /2010-04-01/Accounts/{SID}/
 * @param {Record<string, string>} params - Form parameters
 * @returns {Promise<Response|null>}
 */
async function twilioPost(path, params) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/${path}`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  return fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
}

// Escape XML attribute values to prevent TwiML injection
function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Transfer an active Twilio call to another phone number.
 * Updates the call with TwiML that announces the transfer and dials the target.
 *
 * @param {string} callSid - The active Twilio CallSid
 * @param {string} transferTo - E.164 phone number to transfer to
 * @param {string} [announcement] - Message to say before connecting
 * @param {{ actionUrl?: string, timeout?: number }} [options]
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function transferCall(callSid, transferTo, announcement, { actionUrl, timeout = 25 } = {}) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error("[Transfer] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    return {
      success: false,
      message: "I'm sorry, I'm unable to transfer the call right now. Let me take your information instead.",
    };
  }

  if (!callSid || !transferTo) {
    return {
      success: false,
      message: "I'm sorry, I don't have the information needed to transfer this call.",
    };
  }

  // Announcement is already played via Deepgram TTS before this call —
  // only Dial here to avoid a duplicate robotic Twilio voice.
  const safeNumber = transferTo.replace(/[^+\d]/g, "");

  // Build <Dial> with optional action URL for no-answer fallback
  const safeTimeout = Math.min(Math.max(Math.round(Number(timeout) || 25), 5), 60);
  const dialAttrs = [`timeout="${safeTimeout}"`];
  if (actionUrl) {
    dialAttrs.push(`action="${escapeXml(actionUrl)}"`);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial ${dialAttrs.join(" ")}>${safeNumber}</Dial>
</Response>`;

  try {
    const res = await twilioPost(`Calls/${callSid}.json`, { Twiml: twiml });

    if (!res) {
      console.error("[Transfer] twilioPost returned null — credentials may be invalid");
      return {
        success: false,
        message: "I'm sorry, I'm unable to transfer the call right now. Let me take your information instead.",
      };
    }

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[Transfer] Twilio API error ${res.status}:`, text);
      return {
        success: false,
        message: "I'm sorry, I wasn't able to complete the transfer. Let me take your information and have someone call you back.",
      };
    }

    console.log(`[Transfer] Call ${callSid} transferred to ${safeNumber}`);
    return {
      success: true,
      message: announcement || "Transferring your call now.",
    };
  } catch (err) {
    console.error("[Transfer] Failed to transfer call:", err.message);
    return {
      success: false,
      message: "I'm sorry, I'm having trouble transferring the call. Let me take your information instead.",
    };
  }
}

/**
 * Send an SMS to the transfer target with caller context.
 * Fire-and-forget — callers should catch errors.
 *
 * @param {string} toPhone - E.164 phone number of the transfer recipient
 * @param {string} fromPhone - E.164 phone number of the org (Twilio number)
 * @param {string} body - SMS message body
 * @returns {Promise<{ success: boolean }>}
 */
async function sendTransferSMS(toPhone, fromPhone, body) {
  if (!toPhone || !fromPhone) {
    console.warn("[TransferSMS] Missing toPhone or fromPhone — skipping SMS");
    return { success: false };
  }

  try {
    const safeTo = toPhone.replace(/[^+\d]/g, "");
    const safeFrom = fromPhone.replace(/[^+\d]/g, "");

    const res = await twilioPost("Messages.json", {
      To: safeTo,
      From: safeFrom,
      Body: (body || "").slice(0, 1600), // Twilio SMS limit
    });

    if (!res) {
      console.warn("[TransferSMS] Missing Twilio credentials — skipping SMS");
      return { success: false };
    }

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.warn(`[TransferSMS] Twilio API error ${res.status}:`, text);
      return { success: false };
    }

    console.log(`[TransferSMS] Sent context SMS to ${safeTo}`);
    return { success: true };
  } catch (err) {
    console.warn("[TransferSMS] Failed to send SMS:", err.message);
    return { success: false };
  }
}

module.exports = { transferCall, sendTransferSMS };
