import { setUserProperties as gtagSetUserProperties } from "./gtag";

export interface UserIdentityParams {
  userId: string;
  organizationId: string;
  planType?: string;
  industry?: string;
  country?: string;
  assistantCount?: number;
  phoneNumberCount?: number;
}

async function hashId(id: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // Fallback for insecure contexts (non-HTTPS) — not security-sensitive, only for analytics
    return id
      .split("")
      .map((c) => c.charCodeAt(0).toString(16))
      .join("")
      .slice(0, 16);
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(id);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function identifyUser(params: UserIdentityParams): Promise<void> {
  try {
    const [hashedUserId, hashedOrgId] = await Promise.all([
      hashId(params.userId),
      hashId(params.organizationId),
    ]);

    gtagSetUserProperties({
      user_id_hash: hashedUserId,
      organization_id_hash: hashedOrgId,
      plan_type: params.planType ?? "none",
      industry: params.industry ?? "unknown",
      country: params.country ?? "unknown",
      ...(params.assistantCount !== undefined && { assistant_count: params.assistantCount }),
      ...(params.phoneNumberCount !== undefined && { phone_number_count: params.phoneNumberCount }),
    });
  } catch (error) {
    console.warn("[Analytics] Failed to identify user:", error);
  }
}
