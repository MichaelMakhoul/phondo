/**
 * Telnyx telephony client — mirrors the Twilio client interface.
 * Uses Telnyx v2 REST API with Bearer token auth.
 *
 * Telnyx uses TeXML Applications (TwiML-compatible) for voice.
 * Numbers are assigned to a TeXML App which has a voice URL pointing at the voice server.
 */

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

function getTelnyxApiKey(): string {
  const key = process.env.TELNYX_API_KEY;
  if (!key) {
    throw new Error("TELNYX_API_KEY is required");
  }
  return key;
}

function getTelnyxTexmlAppId(): string {
  const id = process.env.TELNYX_TEXML_APP_ID;
  if (!id) {
    throw new Error("TELNYX_TEXML_APP_ID is required — create a TeXML Application in the Telnyx portal first");
  }
  return id;
}

async function telnyxFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const apiKey = getTelnyxApiKey();
  const res = await fetch(`${TELNYX_API_BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return res;
}

export interface AvailableNumber {
  number: string;
  friendlyName: string;
  locality: string;
  region: string;
  isoCountry: string;
}

/**
 * Search for available phone numbers on Telnyx.
 */
export async function searchAvailableNumbers(
  countryCode: string,
  areaCode?: string,
  limit: number = 10
): Promise<AvailableNumber[]> {
  const params = new URLSearchParams();
  params.set("filter[country_code]", countryCode);
  params.set("filter[limit]", String(limit));
  params.append("filter[features][]", "voice");
  params.append("filter[features][]", "sms");

  if (areaCode) {
    // For AU, area codes like "02" — Telnyx uses national_destination_code
    const cleanCode = areaCode.replace(/^0/, "");
    params.set("filter[national_destination_code]", cleanCode);
  }

  const res = await telnyxFetch(`/available_phone_numbers?${params.toString()}`);

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telnyx search failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const numbers = data.data || [];

  return numbers.map((n: any) => ({
    number: n.phone_number,
    friendlyName: n.phone_number,
    locality: n.locality || "",
    region: n.region_information?.[0]?.region_name || "",
    isoCountry: countryCode,
  }));
}

/**
 * Validate that all required Telnyx env vars are set before attempting a purchase.
 * Call this early (e.g., at search time) to fail fast.
 */
export function validateTelnyxConfig(): void {
  getTelnyxApiKey();
  getTelnyxTexmlAppId();
}

/**
 * Purchase a phone number on Telnyx via Number Orders API.
 * Returns the phone number resource ID (connection_id) for webhook configuration.
 * Polls for order completion with exponential backoff.
 */
export async function purchaseNumber(phoneNumber: string): Promise<{ connectionId: string; number: string }> {
  // Step 1: Create a number order
  const orderRes = await telnyxFetch("/number_orders", {
    method: "POST",
    body: JSON.stringify({
      phone_numbers: [{ phone_number: phoneNumber }],
    }),
  });

  if (!orderRes.ok) {
    const err = await orderRes.text().catch(() => "");
    throw new Error(`Telnyx purchase failed (${orderRes.status}): ${err.slice(0, 300)}`);
  }

  const orderData = await orderRes.json();
  const orderId = orderData.data?.id;

  // Step 2: Poll for the phone number resource with exponential backoff
  const delays = [1000, 2000, 4000, 8000]; // total wait: up to 15s
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));

    const lookupRes = await telnyxFetch(
      `/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`
    );
    if (lookupRes.ok) {
      const lookupData = await lookupRes.json();
      const phoneResource = lookupData.data?.[0];
      if (phoneResource) {
        return { connectionId: phoneResource.id, number: phoneNumber };
      }
    }
  }

  // Order still pending after all retries — attempt to cancel to prevent orphaned charges
  if (orderId) {
    console.error(`[Telnyx] Number order ${orderId} still pending after 15s — attempting cancellation`);
    try {
      await telnyxFetch(`/number_orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      });
    } catch {
      console.error(`CRITICAL: Failed to cancel Telnyx order ${orderId} for ${phoneNumber}. Manual cleanup required.`);
    }
  }

  throw new Error(`Telnyx number order timed out — the order was cancelled. Please try again.`);
}

/**
 * Configure a Telnyx phone number to use the TeXML Application for voice.
 * This routes incoming calls to the voice server's /texml endpoint.
 */
export async function configureVoiceWebhook(connectionId: string): Promise<void> {
  const texmlAppId = getTelnyxTexmlAppId();

  const res = await telnyxFetch(`/phone_numbers/${connectionId}/voice`, {
    method: "PATCH",
    body: JSON.stringify({
      connection_id: texmlAppId,
      tech_prefix_enabled: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telnyx voice webhook config failed (${res.status}): ${err.slice(0, 300)}`);
  }
}

/**
 * Configure SMS settings for a Telnyx phone number.
 * Assigns to a messaging profile that routes inbound SMS to our webhook.
 */
export async function configureSmsWebhook(
  connectionId: string,
  messagingProfileId?: string
): Promise<void> {
  if (!messagingProfileId) {
    messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  }
  if (!messagingProfileId) {
    console.warn("[Telnyx] No messaging profile ID — SMS not configured for this number");
    return;
  }

  const res = await telnyxFetch(`/phone_numbers/${connectionId}/messaging`, {
    method: "PATCH",
    body: JSON.stringify({
      messaging_profile_id: messagingProfileId,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telnyx SMS config failed (${res.status}): ${err.slice(0, 300)}`);
  }
}

/**
 * Release a Telnyx phone number.
 */
export async function releaseNumber(connectionId: string): Promise<void> {
  const res = await telnyxFetch(`/phone_numbers/${connectionId}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telnyx release failed (${res.status}): ${err.slice(0, 300)}`);
  }
}

/**
 * Send an SMS via Telnyx Messaging API.
 */
export async function sendSms(
  from: string,
  to: string,
  body: string
): Promise<{ messageId: string }> {
  const res = await telnyxFetch("/messages", {
    method: "POST",
    body: JSON.stringify({
      from,
      to,
      text: body,
      type: "SMS",
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telnyx SMS send failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  const messageId = data.data?.id;
  if (!messageId) {
    throw new Error(`Telnyx SMS accepted but returned no message ID — unexpected response shape`);
  }
  return { messageId };
}
