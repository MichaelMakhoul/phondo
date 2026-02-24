/**
 * Call Transfer Service
 *
 * Handles call transfers from AI to humans:
 * - Keyword-triggered transfers (e.g., "speak to a human", "emergency")
 * - Intent-detected transfers (complex questions AI can't answer)
 * - Configurable transfer rules per assistant
 * - Transfer announcements and context passing
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface TransferRule {
  id: string;
  organizationId: string;
  assistantId: string;
  name: string;
  triggerKeywords: string[];
  triggerIntent: string | null;
  transferToPhone: string;
  transferToName: string | null;
  announcementMessage: string | null;
  priority: number;
  isActive: boolean;
  destinations: { phone: string; name: string }[];
  requireConfirmation: boolean;
}

export interface TransferRequest {
  organizationId: string;
  assistantId: string;
  callId: string;
  callerPhone: string;
  reason: string;
  urgency: "low" | "medium" | "high";
  summary?: string;
  transcript?: string;
}

export interface TransferResult {
  success: boolean;
  action: "transfer" | "voicemail" | "callback";
  message: string;
  transferTo?: string;
  transferToName?: string;
  announcementMessage?: string;
}

/**
 * Vapi tool definitions for call transfer
 */
export const transferTools = {
  transferCall: {
    type: "function" as const,
    function: {
      name: "transfer_call",
      description:
        "Transfer the call to a human when the AI cannot adequately help. Use this when the caller asks to speak to a person, has a complex issue, or when there's an emergency.",
      parameters: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string",
            description:
              "The reason for the transfer (e.g., 'caller requested human', 'emergency', 'complex question')",
          },
          urgency: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "The urgency level: low (general inquiry), medium (needs attention soon), high (emergency/urgent)",
          },
          summary: {
            type: "string",
            description:
              "A brief summary of the conversation and what the caller needs, to help the human taking over",
          },
        },
        required: ["reason"],
      },
    },
  },
};

/**
 * Get transfer rules for an assistant
 */
export async function getTransferRules(
  organizationId: string,
  assistantId: string
): Promise<TransferRule[]> {
  const supabase = createAdminClient();

  const { data, error } = await (supabase as any)
    .from("transfer_rules")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("assistant_id", assistantId)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (error) {
    console.error("Failed to fetch transfer rules:", error);
    throw new Error(`Failed to fetch transfer rules: ${error.message}`);
  }

  if (!data) {
    return [];
  }

  return data.map((rule: any) => ({
    id: rule.id,
    organizationId: rule.organization_id,
    assistantId: rule.assistant_id,
    name: rule.name,
    triggerKeywords: rule.trigger_keywords || [],
    triggerIntent: rule.trigger_intent,
    transferToPhone: rule.transfer_to_phone,
    transferToName: rule.transfer_to_name,
    announcementMessage: rule.announcement_message,
    priority: rule.priority,
    isActive: rule.is_active,
    destinations: rule.destinations || [],
    requireConfirmation: rule.require_confirmation ?? false,
  }));
}

/**
 * Get the default transfer rule (highest priority active rule)
 */
export async function getDefaultTransferRule(
  organizationId: string,
  assistantId: string
): Promise<TransferRule | null> {
  const rules = await getTransferRules(organizationId, assistantId);
  return rules.length > 0 ? rules[0] : null;
}

/**
 * Find a matching transfer rule based on reason/intent
 */
export async function findMatchingTransferRule(
  organizationId: string,
  assistantId: string,
  reason: string,
  transcript?: string
): Promise<TransferRule | null> {
  const rules = await getTransferRules(organizationId, assistantId);

  if (rules.length === 0) {
    return null;
  }

  const lowerReason = reason.toLowerCase();
  const lowerTranscript = transcript?.toLowerCase() || "";

  // Try to match by keywords in reason or transcript
  for (const rule of rules) {
    // Check trigger keywords
    if (rule.triggerKeywords && rule.triggerKeywords.length > 0) {
      for (const keyword of rule.triggerKeywords) {
        const lowerKeyword = keyword.toLowerCase();
        if (
          lowerReason.includes(lowerKeyword) ||
          lowerTranscript.includes(lowerKeyword)
        ) {
          return rule;
        }
      }
    }

    // Check trigger intent
    if (rule.triggerIntent) {
      const lowerIntent = rule.triggerIntent.toLowerCase();
      if (lowerReason.includes(lowerIntent)) {
        return rule;
      }
    }
  }

  // Return default rule (highest priority) if no specific match
  return rules[0];
}

/**
 * Process a transfer request
 */
export async function processTransfer(
  request: TransferRequest
): Promise<TransferResult> {
  const supabase = createAdminClient();

  // Find the appropriate transfer rule
  const rule = await findMatchingTransferRule(
    request.organizationId,
    request.assistantId,
    request.reason,
    request.transcript
  );

  // If no transfer rules configured
  if (!rule) {
    return {
      success: false,
      action: "callback",
      message:
        "I apologize, but I'm not able to transfer your call right now. Let me take your information and have someone call you back as soon as possible. Can you confirm your name and phone number?",
    };
  }

  // Check if it's during business hours (simplified - in production, check org's business hours)
  const now = new Date();
  const hour = now.getHours();
  const isBusinessHours = hour >= 9 && hour < 17;
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;

  // If outside business hours or weekend, offer callback
  if (!isBusinessHours || isWeekend) {
    return {
      success: true,
      action: "callback",
      message: `I'd be happy to connect you with ${rule.transferToName || "someone"}, but our team is currently unavailable. Can I take your information and have them call you back during business hours?`,
      transferTo: rule.transferToPhone,
      transferToName: rule.transferToName || undefined,
    };
  }

  // Generate announcement message
  const announcement =
    rule.announcementMessage ||
    generateDefaultAnnouncement(request, rule);

  // Log the transfer attempt (non-critical, don't block transfer on logging failure)
  const { error: logError } = await (supabase as any)
    .from("calls")
    .update({
      action_taken: "transferred",
      metadata: {
        transfer_reason: request.reason,
        transfer_urgency: request.urgency,
        transfer_to: rule.transferToPhone,
        transfer_summary: request.summary,
      },
    })
    .eq("id", request.callId);

  if (logError) {
    // Log but don't throw - transfer logging is non-critical
    console.error("Failed to log transfer (non-critical):", logError.message);
  }

  return {
    success: true,
    action: "transfer",
    message: announcement,
    transferTo: rule.transferToPhone,
    transferToName: rule.transferToName || undefined,
    announcementMessage: announcement,
  };
}

/**
 * Generate a default announcement message
 */
function generateDefaultAnnouncement(
  request: TransferRequest,
  rule: TransferRule
): string {
  const urgencyPhrases: Record<string, string> = {
    high: "I understand this is urgent. ",
    medium: "",
    low: "",
  };

  const urgencyPhrase = urgencyPhrases[request.urgency] || "";
  const targetName = rule.transferToName
    ? `${rule.transferToName}`
    : "a team member";

  return `${urgencyPhrase}Let me connect you with ${targetName} who can better assist you. Please hold for just a moment.`;
}

/**
 * Create a new transfer rule
 */
export async function createTransferRule(
  organizationId: string,
  assistantId: string,
  data: {
    name: string;
    triggerKeywords?: string[];
    triggerIntent?: string;
    transferToPhone: string;
    transferToName?: string;
    announcementMessage?: string;
    priority?: number;
    destinations?: { phone: string; name: string }[];
    requireConfirmation?: boolean;
  }
): Promise<TransferRule | null> {
  const supabase = createAdminClient();

  const { data: rule, error } = await (supabase as any)
    .from("transfer_rules")
    .insert({
      organization_id: organizationId,
      assistant_id: assistantId,
      name: data.name,
      trigger_keywords: data.triggerKeywords || [],
      trigger_intent: data.triggerIntent || null,
      transfer_to_phone: data.transferToPhone,
      transfer_to_name: data.transferToName || null,
      announcement_message: data.announcementMessage || null,
      priority: data.priority || 0,
      is_active: true,
      destinations: data.destinations || [],
      require_confirmation: data.requireConfirmation ?? false,
    })
    .select()
    .single();

  if (error) {
    console.error("Failed to create transfer rule:", error);
    throw new Error(`Failed to create transfer rule: ${error.message}`);
  }

  if (!rule) {
    throw new Error("Failed to create transfer rule: No data returned");
  }

  return {
    id: rule.id,
    organizationId: rule.organization_id,
    assistantId: rule.assistant_id,
    name: rule.name,
    triggerKeywords: rule.trigger_keywords || [],
    triggerIntent: rule.trigger_intent,
    transferToPhone: rule.transfer_to_phone,
    transferToName: rule.transfer_to_name,
    announcementMessage: rule.announcement_message,
    priority: rule.priority,
    isActive: rule.is_active,
    destinations: rule.destinations || [],
    requireConfirmation: rule.require_confirmation ?? false,
  };
}

/**
 * Update a transfer rule
 */
export async function updateTransferRule(
  ruleId: string,
  organizationId: string,
  data: Partial<{
    name: string;
    triggerKeywords: string[];
    triggerIntent: string | null;
    transferToPhone: string;
    transferToName: string | null;
    announcementMessage: string | null;
    priority: number;
    isActive: boolean;
    destinations: { phone: string; name: string }[];
    requireConfirmation: boolean;
  }>
): Promise<boolean> {
  const supabase = createAdminClient();

  const updateData: Record<string, any> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.triggerKeywords !== undefined)
    updateData.trigger_keywords = data.triggerKeywords;
  if (data.triggerIntent !== undefined)
    updateData.trigger_intent = data.triggerIntent;
  if (data.transferToPhone !== undefined)
    updateData.transfer_to_phone = data.transferToPhone;
  if (data.transferToName !== undefined)
    updateData.transfer_to_name = data.transferToName;
  if (data.announcementMessage !== undefined)
    updateData.announcement_message = data.announcementMessage;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.isActive !== undefined) updateData.is_active = data.isActive;
  if (data.destinations !== undefined)
    updateData.destinations = data.destinations;
  if (data.requireConfirmation !== undefined)
    updateData.require_confirmation = data.requireConfirmation;

  const { error } = await (supabase as any)
    .from("transfer_rules")
    .update(updateData)
    .eq("id", ruleId)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("Failed to update transfer rule:", error);
    throw new Error(`Failed to update transfer rule: ${error.message}`);
  }

  return true;
}

/**
 * Delete a transfer rule
 */
export async function deleteTransferRule(
  ruleId: string,
  organizationId: string
): Promise<boolean> {
  const supabase = createAdminClient();

  const { error } = await (supabase as any)
    .from("transfer_rules")
    .delete()
    .eq("id", ruleId)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("Failed to delete transfer rule:", error);
    throw new Error(`Failed to delete transfer rule: ${error.message}`);
  }

  return true;
}

/**
 * Common transfer trigger keywords
 */
export const commonTransferKeywords = [
  // Human request
  "speak to a human",
  "speak to someone",
  "speak to a person",
  "talk to a human",
  "talk to someone",
  "talk to a real person",
  "real person",
  "representative",
  "operator",
  "agent",
  "manager",
  "supervisor",

  // Emergency/Urgent
  "emergency",
  "urgent",
  "immediately",
  "right now",
  "asap",

  // Frustration
  "you're not helping",
  "not understanding",
  "can't help me",
  "this isn't working",

  // Complex issues
  "complicated",
  "complex",
  "specific question",
  "technical issue",
  "billing issue",
  "complaint",
  "problem with my account",
];
