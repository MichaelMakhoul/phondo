import { z } from "zod";

export type VerificationMethod =
  | "read-back-digits"
  | "spell-out"
  | "repeat-confirm"
  | "read-back-characters"
  | "none";

export type FieldType =
  | "text"
  | "phone"
  | "email"
  | "date"
  | "number"
  | "select"
  | "address";

export type FieldCategory =
  | "universal"
  | "medical"
  | "dental"
  | "legal"
  | "home_services"
  | "real_estate"
  | "salon"
  | "automotive"
  | "veterinary"
  | "restaurant"
  | "accounting"
  | "insurance"
  | "fitness"
  | "childcare"
  | "funeral_services"
  | "other";

export type TonePreset = "professional" | "friendly" | "casual";

export interface CollectionField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  verification: VerificationMethod;
  category: FieldCategory;
  description?: string;
}

export interface BehaviorToggles {
  scheduleAppointments: boolean;
  handleEmergencies: boolean;
  providePricingInfo: boolean;
  takeMessages: boolean;
  transferToHuman: boolean;
  afterHoursHandling: boolean;
}

export interface PromptConfig {
  version: 1;
  fields: CollectionField[];
  behaviors: BehaviorToggles;
  tone: TonePreset;
  customInstructions: string;
  isManuallyEdited: boolean;
}

export interface AfterHoursConfig {
  greeting?: string;
  customInstructions?: string;
  disableScheduling?: boolean;
}

export const afterHoursConfigSchema = z.object({
  greeting: z.string().max(500).optional(),
  customInstructions: z.string().max(1000).optional(),
  disableScheduling: z.boolean().optional(),
});

export const promptConfigSchema = z.object({
  version: z.literal(1),
  fields: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      type: z.enum(["text", "phone", "email", "date", "number", "select", "address"]),
      required: z.boolean(),
      verification: z.enum(["read-back-digits", "spell-out", "repeat-confirm", "read-back-characters", "none"]),
      category: z.enum(["universal", "medical", "dental", "legal", "home_services", "real_estate", "salon", "automotive", "veterinary", "restaurant", "accounting", "insurance", "fitness", "childcare", "funeral_services", "other"]),
      description: z.string().optional(),
    })
  ),
  behaviors: z.object({
    scheduleAppointments: z.boolean(),
    handleEmergencies: z.boolean(),
    providePricingInfo: z.boolean(),
    takeMessages: z.boolean(),
    transferToHuman: z.boolean(),
    afterHoursHandling: z.boolean(),
  }),
  tone: z.enum(["professional", "friendly", "casual"]),
  customInstructions: z.string(),
  isManuallyEdited: z.boolean(),
});
