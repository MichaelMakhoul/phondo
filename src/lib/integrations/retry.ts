import { createAdminClient } from "@/lib/supabase/admin";
import { safeDecrypt } from "@/lib/security/encryption";
import { isUrlAllowed } from "@/lib/security/validation";
import { signPayload } from "./webhook-delivery";

const DELIVERY_TIMEOUT_MS = 5000;
const MAX_RETRIES = 5;

export async function retryFailedWebhook(logId: string, integrationId: string): Promise<{
  success: boolean;
  status?: number;
  error?: string;
}> {
  const supabase = createAdminClient();

  // Get the failed log entry — enforce it belongs to the expected integration
  const { data: log, error: logError } = await (supabase as any)
    .from("integration_logs")
    .select("id, integration_id, event_type, payload, retry_count")
    .eq("id", logId)
    .eq("integration_id", integrationId)
    .eq("success", false)
    .single();

  if (logError || !log) {
    return { success: false, error: "Log entry not found or already successful" };
  }

  if (log.retry_count >= MAX_RETRIES) {
    return { success: false, error: `Maximum retries (${MAX_RETRIES}) exceeded` };
  }

  // Get the integration details
  const { data: integration, error: intError } = await (supabase as any)
    .from("integrations")
    .select("id, webhook_url, signing_secret, is_active")
    .eq("id", integrationId)
    .single();

  if (intError || !integration) {
    return { success: false, error: "Integration not found" };
  }

  if (!integration.is_active) {
    return { success: false, error: "Integration is paused" };
  }

  const url = safeDecrypt(integration.webhook_url);
  const secret = safeDecrypt(integration.signing_secret);

  if (!url || !isUrlAllowed(url)) {
    return { success: false, error: "URL blocked by security policy" };
  }

  if (!secret) {
    return { success: false, error: "Signing secret decryption failed" };
  }

  const payloadStr = JSON.stringify(log.payload);
  const signature = signPayload(payloadStr, secret);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Phondo-Signature": signature,
        "X-Phondo-Event": log.event_type,
        "User-Agent": "Phondo-Webhooks/1.0",
      },
      body: payloadStr,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseBody = await response.text().catch((err: Error) => `[Failed to read response: ${err.message}]`);

    // Update the log entry
    const { error: updateError } = await (supabase as any)
      .from("integration_logs")
      .update({
        response_status: response.status,
        response_body: responseBody.slice(0, 1000),
        success: response.ok,
        retry_count: log.retry_count + 1,
        attempted_at: new Date().toISOString(),
      })
      .eq("id", logId);

    if (updateError) {
      console.error("[Webhooks] Failed to update retry log:", updateError);
    }

    return {
      success: response.ok,
      status: response.status,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    const { error: updateError } = await (supabase as any)
      .from("integration_logs")
      .update({
        response_body: message,
        success: false,
        retry_count: log.retry_count + 1,
        attempted_at: new Date().toISOString(),
      })
      .eq("id", logId);

    if (updateError) {
      console.error("[Webhooks] Failed to update retry log:", updateError);
    }

    return { success: false, error: message };
  }
}
