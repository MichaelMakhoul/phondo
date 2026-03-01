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
      // Search by pattern: numbers starting with +61{digit}
      searchParams.contains = areaCode.replace(/^0/, "");
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
  const purchased = await client.incomingPhoneNumbers.create({
    phoneNumber,
  });
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
  const updateParams: Record<string, string> = {
    voiceUrl: webhookUrl,
    voiceMethod: "POST",
  };
  if (fallbackUrl) {
    updateParams.voiceFallbackUrl = fallbackUrl;
    updateParams.voiceFallbackMethod = "POST";
  }
  await client.incomingPhoneNumbers(twilioSid).update(updateParams);
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

/** Returns Twilio credentials for Vapi import. Kept narrow to avoid broad token exposure. */
export function getTwilioCredentials(): { accountSid: string; authToken: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required");
  }
  return { accountSid, authToken };
}
