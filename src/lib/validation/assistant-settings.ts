import { z } from "zod";

/**
 * Shared allow-list for an assistant's `settings` JSON (SCRUM-347 L4).
 *
 * Used by BOTH the create (POST /api/v1/assistants) and update
 * (PATCH /api/v1/assistants/[id]) routes so the two cannot drift. The update
 * route spreads `...assistant.settings` back into the PATCH body on save, so a
 * key accepted at create but absent here would later 400 the builder save —
 * keeping a single source of truth prevents that footgun.
 *
 * `.strict()` rejects unknown keys, which stops a client from mass-assigning
 * arbitrary fields into the settings blob the prompt builder consumes. Every key
 * below maps to a real consumer and is present in production settings (verified:
 * flexibleBooking, maxCallDuration, piiRedactionEnabled, recordingDisclosure,
 * recordingEnabled, spamFilterEnabled). Add a NEW settings key here (and nowhere
 * else) when introducing one.
 */
export const assistantSettingsSchema = z
  .object({
    recordingEnabled: z.boolean().optional(),
    recordingDisclosure: z.string().optional(),
    maxCallDuration: z.number().optional(),
    spamFilterEnabled: z.boolean().optional(),
    flexibleBooking: z.boolean().optional(),
    industry: z.string().optional(),
    answerMode: z.enum(["ai_first", "ring_first"]).optional(),
    ringFirstNumber: z.string().regex(/^\+\d{7,15}$/).nullable().optional(),
    ringFirstTimeout: z.number().min(5).max(60).nullable().optional(),
    piiRedactionEnabled: z.boolean().optional(),
    transferToForwardedNumber: z.boolean().optional(),
  })
  .strict();
