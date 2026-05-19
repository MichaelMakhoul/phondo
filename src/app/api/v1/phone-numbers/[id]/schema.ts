import { z } from "zod";

// Loose E.164: 8-15 digits with leading +. Strict enough to reject obvious
// typos (numbers without country code, letters, punctuation other than +)
// but lenient enough not to fight Twilio's slightly broader acceptance set.
// Exported because the voice-server mirrors this regex for defense-in-depth.
export const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// Sensitive fields — changing these affects call routing for live customers
// and can redirect inbound calls to attacker-controlled numbers. Restrict
// to org owners and admins. Non-sensitive fields (assistant assignment,
// friendly name) remain available to all org members.
export const SENSITIVE_FIELDS = ["aiEnabled", "fallbackForwardNumber"] as const;

export const updatePhoneNumberSchema = z.object({
  assistantId: z.string().uuid().nullable().optional(),
  friendlyName: z.string().optional(),
  forwardingStatus: z.enum(["pending_setup", "active", "paused"]).optional(),
  carrier: z.string().optional(),
  aiEnabled: z.boolean().optional(),
  // Tri-state semantics:
  //   undefined → field omitted, do NOT touch DB
  //   null      → explicit clear, write NULL (voicemail fallback resumes)
  //   ""        → also clear, normalised to null
  //   "+E.164"  → set the fallback after trim + regex validation
  // The transform must preserve `undefined` so that an unrelated PATCH
  // (e.g., assigning an assistant) does not silently wipe a saved fallback.
  fallbackForwardNumber: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null || v === "") return null;
      return v.trim();
    })
    .refine((v) => v === undefined || v === null || E164_REGEX.test(v), {
      message: "Fallback number must be in E.164 format (e.g., +61412345678)",
    }),
});

export type UpdatePhoneNumberInput = z.infer<typeof updatePhoneNumberSchema>;
