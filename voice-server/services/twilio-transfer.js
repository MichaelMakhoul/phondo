/**
 * Twilio call transfer using REST API.
 * Uses raw fetch to keep dependencies light (no Twilio SDK).
 */

const { Sentry } = require("../lib/sentry");

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
 * Updates the call with TwiML that dials the target. If `whisperText` is
 * supplied AND PUBLIC_URL is set, the recipient hears a whisper announcement
 * + recording disclosure BEFORE the caller is bridged in (via
 * <Number url="..."> referencing /twiml/transfer-whisper).
 *
 * @param {string} callSid - The active Twilio CallSid
 * @param {string} transferTo - E.164 phone number to transfer to
 * @param {string} [announcement] - Message the AI spoke to the CALLER before
 *   transfer (already played via Deepgram/Gemini TTS — not used in TwiML)
 * @param {{ actionUrl?: string, timeout?: number, whisperText?: string }} [options]
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function transferCall(callSid, transferTo, announcement, { actionUrl, timeout = 25, whisperText } = {}) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error("[Transfer] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
    Sentry.withScope((scope) => {
      scope.setTag("service", "twilio-transfer");
      scope.setExtra("callSid", callSid);
      Sentry.captureException(new Error("Transfer: missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN"));
    });
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

  // The AI's announcement to the CALLER is played via Gemini/Deepgram TTS
  // before this call. The TwiML below dials the recipient — if whisperText
  // is provided AND PUBLIC_URL is set, we route the dial through
  // /twiml/transfer-whisper so the RECIPIENT hears an announcement +
  // recording disclosure when they pick up, before the caller is bridged.
  const safeNumber = transferTo.replace(/[^+\d]/g, "");

  // Build <Dial> with optional action URL for no-answer fallback
  const safeTimeout = Math.min(Math.max(Math.round(Number(timeout) || 25), 5), 60);
  const dialAttrs = [`timeout="${safeTimeout}"`];
  if (actionUrl) {
    dialAttrs.push(`action="${escapeXml(actionUrl)}"`);
  }

  // Build <Number> with optional whisper URL.
  // Twilio fetches the url when the recipient picks up and plays the TwiML
  // to them ONLY (the caller doesn't hear it). After the TwiML finishes
  // the legs are bridged. See https://www.twilio.com/docs/voice/twiml/number
  let numberAttrs = "";
  if (whisperText && typeof whisperText === "string" && whisperText.trim() && process.env.PUBLIC_URL) {
    const whisperUrl = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/twiml/transfer-whisper?text=${encodeURIComponent(whisperText.slice(0, 2000))}`;
    numberAttrs = ` url="${escapeXml(whisperUrl)}"`;
  }

  const numberXml = numberAttrs
    ? `<Number${numberAttrs}>${safeNumber}</Number>`
    : safeNumber;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial ${dialAttrs.join(" ")}>${numberXml}</Dial>
</Response>`;

  // Drain delay: the AI says a short filler ("One moment, let me connect
  // you") and then immediately calls this tool. Without a brief pause,
  // posting the new TwiML replaces the live media stream while the filler
  // is still streaming — the caller hears "let me t—". 1.5s is long enough
  // for the typical 3-5 word filler to finish on most TTS voices.
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const res = await twilioPost(`Calls/${callSid}.json`, { Twiml: twiml });

    if (!res) {
      console.error("[Transfer] twilioPost returned null — credentials may be invalid");
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-transfer");
        scope.setExtra("callSid", callSid);
        scope.setExtra("transferTo", transferTo);
        Sentry.captureException(new Error("Transfer: twilioPost returned null — credentials may be invalid"));
      });
      return {
        success: false,
        message: "I'm sorry, I'm unable to transfer the call right now. Let me take your information instead.",
      };
    }

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[Transfer] Twilio API error ${res.status}:`, text);
      Sentry.withScope((scope) => {
        scope.setTag("service", "twilio-transfer");
        scope.setExtra("callSid", callSid);
        scope.setExtra("transferTo", transferTo);
        scope.setExtra("httpStatus", res.status);
        scope.setExtra("responseBody", text);
        Sentry.captureException(new Error(`Transfer: Twilio API error ${res.status}`));
      });
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
    Sentry.withScope((scope) => {
      scope.setTag("service", "twilio-transfer");
      scope.setExtra("callSid", callSid);
      scope.setExtra("transferTo", transferTo);
      Sentry.captureException(err);
    });
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
