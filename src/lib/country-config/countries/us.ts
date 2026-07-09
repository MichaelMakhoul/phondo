import type { CountryConfig } from "../index";

export const US_CONFIG: CountryConfig = {
  code: "US",
  name: "United States",
  flag: "US",
  emergencyNumber: "911",
  phone: {
    countryCallingCode: "1",
    placeholder: "+1 (555) 123-4567",
    areaCodeLength: 3,
    formatForDisplay(digits: string): string {
      const cleaned = digits.replace(/\D/g, "");
      // 10-digit national
      if (cleaned.length === 10) {
        return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
      }
      // 11-digit with leading 1
      if (cleaned.length === 11 && cleaned.startsWith("1")) {
        return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
      }
      return digits;
    },
    validateNational(digits: string): boolean {
      const cleaned = digits.replace(/\D/g, "");
      return (
        cleaned.length === 10 ||
        (cleaned.length === 11 && cleaned.startsWith("1"))
      );
    },
    extractAreaCode(digits: string): string | null {
      const cleaned = digits.replace(/\D/g, "");
      if (cleaned.length === 11 && cleaned.startsWith("1")) {
        return cleaned.slice(1, 4);
      }
      if (cleaned.length >= 3) {
        return cleaned.slice(0, 3);
      }
      return null;
    },
  },
  carriers: [
    {
      id: "att",
      name: "AT&T",
      instructions: {
        conditional: {
          enable: "*67*{destination_number}#",
          disable: "#67#",
          note: "Forwards calls when your line is busy or you don't answer.",
        },
        unconditional: {
          enable: "*21*{destination_number}#",
          disable: "#21#",
          note: "Forwards all calls immediately. Your phone will not ring.",
        },
      },
    },
    {
      id: "verizon",
      name: "Verizon",
      instructions: {
        conditional: {
          enable: "*71{destination_number}",
          disable: "*73",
          note: "Forwards calls when your line is busy or you don't answer.",
        },
        unconditional: {
          enable: "*72{destination_number}",
          disable: "*73",
          note: "Forwards all calls immediately. Your phone will not ring.",
        },
      },
    },
    {
      id: "tmobile",
      name: "T-Mobile",
      instructions: {
        conditional: {
          enable: "**62*{destination_number}#",
          disable: "##62#",
          note: "Forwards calls when your phone is unreachable or you don't answer.",
        },
        unconditional: {
          enable: "**21*{destination_number}#",
          disable: "##21#",
          note: "Forwards all calls immediately. Your phone will not ring.",
        },
      },
    },
    {
      id: "uscellular",
      name: "US Cellular",
      instructions: {
        conditional: {
          enable: "*71{destination_number}",
          disable: "*73",
          note: "Forwards calls when your line is busy or you don't answer.",
        },
        unconditional: {
          enable: "*72{destination_number}",
          disable: "*73",
          note: "Forwards all calls immediately. Your phone will not ring.",
        },
      },
    },
    {
      id: "other",
      name: "Other / Landline",
      instructions: {
        conditional: {
          enable: "*71{destination_number}",
          disable: "*73",
          note: "These are the most common codes. Contact your carrier if they don't work.",
        },
        unconditional: {
          enable: "*72{destination_number}",
          disable: "*73",
          note: "These are the most common codes. Contact your carrier if they don't work.",
        },
      },
    },
  ],
  timezones: [
    { value: "America/New_York", label: "Eastern Time (ET)" },
    { value: "America/Chicago", label: "Central Time (CT)" },
    { value: "America/Denver", label: "Mountain Time (MT)" },
    { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
    { value: "America/Phoenix", label: "Arizona (No DST)" },
    { value: "Pacific/Honolulu", label: "Hawaii Time" },
    { value: "America/Anchorage", label: "Alaska Time" },
  ],
  defaultTimezone: "America/New_York",
  suggestedAreaCodes: [
    { code: "651", location: "St. Paul, MN" },
    { code: "539", location: "Tulsa, OK" },
    { code: "704", location: "Charlotte, NC" },
    { code: "469", location: "Dallas, TX" },
    { code: "725", location: "Las Vegas, NV" },
  ],
  suspiciousAreaCodes: [
    "201", "202", "213", "267", "315", "347", "407", "480",
    "619", "657", "720", "773", "786", "813", "904", "954",
  ],
  locale: "en-US",
  phoneProvider: "twilio",
  twilioCountryCode: "US",
};
