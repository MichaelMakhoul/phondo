export type {
  PromptConfig,
  CollectionField,
  BehaviorToggles,
  TonePreset,
  FieldType,
  FieldCategory,
  VerificationMethod,
  AfterHoursConfig,
} from "./types";

export { promptConfigSchema, afterHoursConfigSchema } from "./types";

export { fieldPresetsByIndustry, universalFields, getFieldsForIndustry } from "./field-presets";
export { buildPromptFromConfig, generateGreeting, buildSchedulingSection } from "./generate-prompt";
export type { PromptContext } from "./generate-prompt";
export { getDefaultConfig } from "./defaults";
