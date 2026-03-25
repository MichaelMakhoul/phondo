import { US_CONFIG } from "./countries/us";
import { AU_CONFIG } from "./countries/au";

// ── Types ──────────────────────────────────────────────────────────

export type CountryCode = "US" | "AU";

export interface PhoneConfig {
  countryCallingCode: string;
  placeholder: string;
  areaCodeLength: number;
  formatForDisplay(digits: string): string;
  validateNational(digits: string): boolean;
  extractAreaCode(digits: string): string | null;
}

export interface CarrierInfo {
  id: string;
  name: string;
  instructions: {
    conditional: { enable: string; disable: string; note: string };
    unconditional: { enable: string; disable: string; note: string };
  };
}

export interface TimezoneOption {
  value: string;
  label: string;
}

export interface AreaCodeSuggestion {
  code: string;
  location: string;
}

export interface CountryConfig {
  code: CountryCode;
  name: string;
  flag: string;
  phone: PhoneConfig;
  carriers: CarrierInfo[];
  timezones: TimezoneOption[];
  defaultTimezone: string;
  suggestedAreaCodes: AreaCodeSuggestion[];
  suspiciousAreaCodes: string[];
  locale: string;
  phoneProvider: "vapi" | "twilio" | "telnyx";
  twilioCountryCode: string; // ISO country code — used by both Twilio and Telnyx
}

// ── Registry ───────────────────────────────────────────────────────

const COUNTRY_CONFIGS: Record<CountryCode, CountryConfig> = {
  US: US_CONFIG,
  AU: AU_CONFIG,
};

export const SUPPORTED_COUNTRIES: { code: CountryCode; name: string; flag: string }[] =
  Object.values(COUNTRY_CONFIGS).map((c) => ({ code: c.code, name: c.name, flag: c.flag }));

// ── Exports ────────────────────────────────────────────────────────

export function getCountryConfig(code: CountryCode | string): CountryConfig {
  const normalized = (code || "").toUpperCase() as CountryCode;
  const config = COUNTRY_CONFIGS[normalized];
  if (!config) {
    console.error(`Unknown country code "${code}", falling back to US. This affects phone provisioning and billing.`);
    return COUNTRY_CONFIGS.US;
  }
  return config;
}

export function formatPhoneForCountry(phone: string, countryCode: CountryCode | string = "US"): string {
  return getCountryConfig(countryCode).phone.formatForDisplay(phone);
}

export function validatePhoneForCountry(phone: string, countryCode: CountryCode | string = "US"): boolean {
  return getCountryConfig(countryCode).phone.validateNational(phone);
}

export function getCarriersForCountry(countryCode: CountryCode | string = "US"): CarrierInfo[] {
  return getCountryConfig(countryCode).carriers;
}

export function getTimezonesForCountry(countryCode: CountryCode | string = "US"): TimezoneOption[] {
  return getCountryConfig(countryCode).timezones;
}

export function formatInstructions(template: string, destinationNumber: string): string {
  return template.replace(/\{destination_number\}/g, destinationNumber);
}
