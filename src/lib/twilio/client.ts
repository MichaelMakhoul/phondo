import Twilio from "twilio";

let twilioClient: ReturnType<typeof Twilio> | null = null;

export function getTwilioClient() {
  if (!twilioClient) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required");
    }
    twilioClient = Twilio(accountSid, authToken);
  }
  return twilioClient;
}

export interface AvailableNumber {
  number: string;
  friendlyName: string;
  locality: string;
  region: string;
  isoCountry: string;
}

export async function searchAvailableNumbers(
  countryCode: string,
  areaCode?: string,
  limit: number = 10
): Promise<AvailableNumber[]> {
  const client = getTwilioClient();

  const searchParams: Record<string, unknown> = { limit };
  if (areaCode) {
    // Twilio does not support `areaCode` param for AU.
    // We use `contains` as a prefix filter — passing the digit after trunk prefix "0".
    if (countryCode === "AU" && areaCode.startsWith("0")) {
      // Twilio's `contains` matches the full E.164 number (incl. country code) and
      // must be 2–16 chars, so a bare area digit ("2") is rejected ("Invalid Pattern
      // Provided"). Build an anchored pattern: 61 + area digit + 8 subscriber
      // wildcards (AU geographic numbers have 8 subscriber digits), e.g. "02" →
      // "612********". Verified against the live Twilio API to return Sydney numbers.
      searchParams.contains = `61${areaCode.replace(/^0/, "")}${"*".repeat(8)}`;
    } else {
      const parsed = parseInt(areaCode, 10);
      if (isNaN(parsed)) {
        throw new Error(`Invalid area code "${areaCode}": must be numeric`);
      }
      searchParams.areaCode = parsed;
    }
  }

  const numbers = await client.availablePhoneNumbers(countryCode).local.list(searchParams);

  return numbers.map((n) => ({
    number: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality || "",
    region: n.region || "",
    isoCountry: n.isoCountry || countryCode,
  }));
}

export async function purchaseNumber(phoneNumber: string): Promise<{ sid: string; number: string }> {
  const client = getTwilioClient();
  const params: { phoneNumber: string; addressSid?: string } = { phoneNumber };
  // Some countries (e.g. AU) require a regulatory/emergency Address on the number —
  // Twilio errors 21631 ("Requires an Address") without it. Set TWILIO_ADDRESS_SID
  // to a validated Address resource in the number's country.
  const addressSid = process.env.TWILIO_ADDRESS_SID;
  if (addressSid) {
    params.addressSid = addressSid;
  }
  const purchased = await client.incomingPhoneNumbers.create(params);
  return { sid: purchased.sid, number: purchased.phoneNumber };
}

export async function releaseNumber(twilioSid: string): Promise<void> {
  const client = getTwilioClient();
  await client.incomingPhoneNumbers(twilioSid).remove();
}

/**
 * Configure the voice webhook URL on a Twilio phone number.
 * Used to point incoming calls at the self-hosted voice server.
 * Optionally sets a fallback URL that Twilio calls when the primary webhook fails.
 */
export async function configureVoiceWebhook(
  twilioSid: string,
  webhookUrl: string,
  fallbackUrl?: string
): Promise<void> {
  const client = getTwilioClient();
  // The primary voice URL is critical — a number with no voiceUrl drops every
  // call. Set it on its own so a bad/unreachable fallback can't block it: Twilio
  // rejects e.g. a localhost fallback (error 22105) and fails the WHOLE update,
  // which previously left brand-new numbers with no webhook at all.
  await client.incomingPhoneNumbers(twilioSid).update({
    voiceUrl: webhookUrl,
    voiceMethod: "POST",
  });
  // Fallback URL is best-effort — never let it undo the primary configuration.
  if (fallbackUrl) {
    try {
      await client.incomingPhoneNumbers(twilioSid).update({
        voiceFallbackUrl: fallbackUrl,
        voiceFallbackMethod: "POST",
      });
    } catch (err) {
      console.warn(
        `[twilio] voice fallback URL rejected (non-fatal): ${fallbackUrl} — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Configure the SMS webhook URL on a Twilio phone number.
 * Used to receive inbound SMS (e.g., STOP opt-out replies).
 */
export async function configureSmsWebhook(
  twilioSid: string,
  smsUrl: string
): Promise<void> {
  const client = getTwilioClient();
  await client.incomingPhoneNumbers(twilioSid).update({
    smsUrl,
    smsMethod: "POST",
  });
}
