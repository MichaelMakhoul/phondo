import type { CountryConfig } from "../index";

export const AU_CONFIG: CountryConfig = {
  code: "AU",
  name: "Australia",
  flag: "AU",
  phone: {
    countryCallingCode: "61",
    placeholder: "02 9876 5432",
    areaCodeLength: 2,
    formatForDisplay(digits: string): string {
      const cleaned = digits.replace(/\D/g, "");
      // International format +61...
      if (cleaned.startsWith("61") && cleaned.length === 11) {
        const national = cleaned.slice(2);
        // Landline: +61 2 9876 5432
        if (/^[2378]/.test(national)) {
          return `+61 ${national.slice(0, 1)} ${national.slice(1, 5)} ${national.slice(5)}`;
        }
        // Mobile: 04xx xxx xxx
        if (national.startsWith("4")) {
          return `+61 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
        }
        return `+61 ${national}`;
      }
      // National format 0X XXXX XXXX (10 digits starting with 0)
      if (cleaned.startsWith("0") && cleaned.length === 10) {
        // Landline
        if (/^0[2378]/.test(cleaned)) {
          return `${cleaned.slice(0, 2)} ${cleaned.slice(2, 6)} ${cleaned.slice(6)}`;
        }
        // Mobile 04xx
        if (cleaned.startsWith("04")) {
          return `${cleaned.slice(0, 4)} ${cleaned.slice(4, 7)} ${cleaned.slice(7)}`;
        }
        return cleaned;
      }
      return digits;
    },
    validateNational(digits: string): boolean {
      const cleaned = digits.replace(/\D/g, "");
      // 10 digits starting with 0 (national) or 11 digits starting with 61 (international)
      return (
        (cleaned.length === 10 && cleaned.startsWith("0")) ||
        (cleaned.length === 11 && cleaned.startsWith("61"))
      );
    },
    extractAreaCode(digits: string): string | null {
      const cleaned = digits.replace(/\D/g, "");
      // National format: extract 2-digit area code prefix (e.g., "02" for Sydney)
      if (cleaned.startsWith("0") && cleaned.length >= 2) {
        return cleaned.slice(0, 2);
      }
      // International: strip "61" and prepend trunk prefix "0" (e.g., +612... → "02")
      if (cleaned.startsWith("61") && cleaned.length >= 3) {
        return `0${cleaned.slice(2, 3)}`;
      }
      return null;
    },
  },
  carriers: [
    {
      id: "telstra",
      name: "Telstra",
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
      id: "optus",
      name: "Optus",
      instructions: {
        conditional: {
          enable: "*61*{destination_number}#",
          disable: "#61#",
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
      id: "vodafone_au",
      name: "Vodafone AU",
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
      id: "tpg",
      name: "TPG/iiNet",
      instructions: {
        conditional: {
          enable: "*61*{destination_number}#",
          disable: "#61#",
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
      id: "other",
      name: "Other",
      instructions: {
        conditional: {
          enable: "*61*{destination_number}#",
          disable: "#61#",
          note: "These are the most common codes. Contact your carrier if they don't work.",
        },
        unconditional: {
          enable: "*21*{destination_number}#",
          disable: "#21#",
          note: "These are the most common codes. Contact your carrier if they don't work.",
        },
      },
    },
  ],
  timezones: [
    { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
    { value: "Australia/Brisbane", label: "Brisbane (AEST)" },
    { value: "Australia/Adelaide", label: "Adelaide (ACST/ACDT)" },
    { value: "Australia/Perth", label: "Perth (AWST)" },
    { value: "Australia/Darwin", label: "Darwin (ACST)" },
    { value: "Australia/Hobart", label: "Hobart (AEST/AEDT)" },
  ],
  defaultTimezone: "Australia/Sydney",
  suggestedAreaCodes: [
    { code: "02", location: "Sydney / ACT" },
    { code: "03", location: "Melbourne / Tasmania" },
    { code: "07", location: "Brisbane / Queensland" },
    { code: "08", location: "Perth / Adelaide" },
  ],
  suspiciousAreaCodes: [],
  locale: "en-AU",
  phoneProvider: "twilio",
  twilioCountryCode: "AU",
};
