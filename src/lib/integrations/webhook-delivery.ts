import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeDecrypt } from "@/lib/security/encryption";
import { isUrlAllowed } from "@/lib/security/validation";
import { hasFeatureAccess } from "@/lib/stripe/billing-service";
import type { IntegrationEvent, WebhookPayload } from "./types";

const DELIVERY_TIMEOUT_MS = 5000;

export function signPayload(payload: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
}

export function buildCallPayload(
  event: IntegrationEvent,
  callData: {
    callId: string;
    caller: string;
    callerName?: string | null;
    summary?: string | null;
    transcript?: string | null;
    duration?: number | null;
    assistantName?: string | null;
    outcome?: string | null;
    recordingUrl?: string | null;
    collectedData?: Record<string, unknown> | null;
  }
): WebhookPayload {
  return {
    event,
    timestamp: new Date().toISOString(),
    data: {
      call_id: callData.callId,
      caller_phone: callData.caller,
      caller_name: callData.callerName ?? null,
      summary: callData.summary ?? null,
      transcript: callData.transcript ?? null,
      duration_seconds: callData.duration ?? null,
      assistant_name: callData.assistantName ?? null,
      outcome: callData.outcome ?? null,
      recording_url: callData.recordingUrl ?? null,
      collected_data: callData.collectedData ?? null,
    },
  };
}

export async function deliverWebhooks(
  orgId: string,
  event: IntegrationEvent,
  callData: Parameters<typeof buildCallPayload>[1]
): Promise<void> {
  // Skip delivery if plan doesn't include webhook integrations
  if (!(await hasFeatureAccess(orgId, "webhookIntegrations"))) {
    return;
  }

  const supabase = createAdminClient();

  // Fetch active integrations for this org that subscribe to this event
  const { data: integrations, error } = await (supabase as any)
    .from("integrations")
    .select("id, webhook_url, signing_secret, events")
    .eq("organization_id", orgId)
    .eq("is_active", true);

  if (error) {
    console.error("[Webhooks] Failed to fetch integrations:", error);
    return;
  }

  if (!integrations || integrations.length === 0) return;

  // Filter by event type
  const matching = integrations.filter(
    (i: { events: string[] }) => i.events.includes(event)
  );

  if (matching.length === 0) return;

  const payload = buildCallPayload(event, callData);
  const payloadStr = JSON.stringify(payload);

  const deliveries = matching.map(
    async (integration: { id: string; webhook_url: string; signing_secret: string }) => {
      const url = safeDecrypt(integration.webhook_url);
      const secret = safeDecrypt(integration.signing_secret);

      // SSRF protection
      if (!url || !isUrlAllowed(url)) {
        console.error("[Webhooks] Blocked URL for integration:", integration.id);
        await logDelivery(supabase, integration.id, event, payload, null, "URL blocked by SSRF policy", false);
        return;
      }

      if (!secret) {
        console.error("[Webhooks] Failed to decrypt signing secret for integration:", integration.id);
        await logDelivery(supabase, integration.id, event, payload, null, "Signing secret decryption failed", false);
        return;
      }

      const signature = signPayload(payloadStr, secret);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HolaRecep-Signature": signature,
            "X-HolaRecep-Event": event,
            "User-Agent": "HolaRecep-Webhooks/1.0",
          },
          body: payloadStr,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const responseBody = await response.text().catch((err: Error) => `[Failed to read response: ${err.message}]`);
        const success = response.ok;

        await logDelivery(
          supabase,
          integration.id,
          event,
          payload,
          response.status,
          responseBody.slice(0, 1000),
          success
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        await logDelivery(supabase, integration.id, event, payload, null, message, false);
      }
    }
  );

  await Promise.allSettled(deliveries);
}

async function logDelivery(
  supabase: ReturnType<typeof createAdminClient>,
  integrationId: string,
  eventType: string,
  payload: object,
  responseStatus: number | null,
  responseBody: string | null,
  success: boolean
): Promise<void> {
  const { error } = await (supabase as any).from("integration_logs").insert({
    integration_id: integrationId,
    event_type: eventType,
    payload,
    response_status: responseStatus,
    response_body: responseBody,
    success,
  });

  if (error) {
    console.error("[Webhooks] Failed to log delivery:", error);
  }
}
