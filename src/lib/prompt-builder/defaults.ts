import type { PromptConfig, BehaviorToggles, TonePreset } from "./types";
import { universalFields, fieldPresetsByIndustry } from "./field-presets";

function getDefaultBehaviors(industry: string): BehaviorToggles {
  const base: BehaviorToggles = {
    scheduleAppointments: false,
    handleEmergencies: false,
    providePricingInfo: false,
    takeMessages: true,
    transferToHuman: false,
    afterHoursHandling: false,
  };

  switch (industry) {
    case "medical":
      return { ...base, scheduleAppointments: true, handleEmergencies: true };
    case "dental":
      return { ...base, scheduleAppointments: true, handleEmergencies: true, providePricingInfo: true };
    case "legal":
      return { ...base, takeMessages: true, transferToHuman: true };
    case "home_services":
      return { ...base, scheduleAppointments: true, handleEmergencies: true, providePricingInfo: true };
    case "real_estate":
      return { ...base, scheduleAppointments: true, providePricingInfo: true };
    case "salon":
      return { ...base, scheduleAppointments: true, providePricingInfo: true };
    case "automotive":
      return { ...base, scheduleAppointments: true, handleEmergencies: true, providePricingInfo: true };
    case "veterinary":
      return { ...base, scheduleAppointments: true, handleEmergencies: true };
    case "restaurant":
      return { ...base, scheduleAppointments: true };
    case "accounting":
      return { ...base, scheduleAppointments: true, takeMessages: true };
    case "insurance":
      return { ...base, takeMessages: true, transferToHuman: true };
    case "fitness":
      return { ...base, scheduleAppointments: true, providePricingInfo: true };
    case "childcare":
      return { ...base, scheduleAppointments: true };
    case "funeral_services":
      return { ...base, takeMessages: true, transferToHuman: true, afterHoursHandling: true };
    default:
      return base;
  }
}

function getDefaultTone(industry: string): TonePreset {
  switch (industry) {
    case "legal":
    case "accounting":
    case "insurance":
    case "funeral_services":
      return "professional";
    case "salon":
    case "restaurant":
    case "fitness":
      return "friendly";
    default:
      return "friendly";
  }
}

export function getDefaultConfig(industry: string): PromptConfig {
  const category = industry in fieldPresetsByIndustry ? industry : "other";
  const industryFields = fieldPresetsByIndustry[category as keyof typeof fieldPresetsByIndustry] || [];

  return {
    version: 1,
    fields: [...universalFields, ...industryFields],
    behaviors: getDefaultBehaviors(industry),
    tone: getDefaultTone(industry),
    customInstructions: "",
    isManuallyEdited: false,
  };
}
