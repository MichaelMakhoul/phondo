/** Fixed UUIDs matching the seed migration (00105). */

export const DEMO_ORG_ID = "d0000000-0000-4000-a000-000000000001";

export const DEMO_INDUSTRIES = {
  dental: {
    assistantId: "d0000000-0000-4000-a000-000000000010",
    name: "Smile Dental Care",
    description: "Dental appointment scheduling, insurance questions, and emergency triage",
  },
  legal: {
    assistantId: "d0000000-0000-4000-a000-000000000020",
    name: "Johnson & Associates",
    description: "Professional legal intake, client screening, and consultation scheduling",
  },
  home_services: {
    assistantId: "d0000000-0000-4000-a000-000000000030",
    name: "Reliable Home Services",
    description: "Service requests, emergency dispatch, and appointment scheduling",
  },
} as const;

export const DEMO_RATE_LIMIT_ERROR = "Too many demo calls";

export type DemoIndustry = keyof typeof DEMO_INDUSTRIES;

export function isDemoIndustry(value: unknown): value is DemoIndustry {
  return typeof value === "string" && value in DEMO_INDUSTRIES;
}

/**
 * SCRUM-571: the public tap-to-call demo line. E.164 in the env var; unset →
 * the /demo page simply doesn't render the phone CTA (publish switch: set it
 * only after the voice-server demo-line guards are deployed).
 */
export const DEMO_PHONE_NUMBER = process.env.NEXT_PUBLIC_DEMO_PHONE_NUMBER;

/** Render an E.164 AU number in familiar local notation; pass through anything else. */
export function formatDemoPhoneDisplay(e164: string): string {
  const landline = e164.match(/^\+61([2378])(\d{4})(\d{4})$/);
  if (landline) return `(0${landline[1]}) ${landline[2]} ${landline[3]}`;
  const mobile = e164.match(/^\+61(4\d{2})(\d{3})(\d{3})$/);
  if (mobile) return `0${mobile[1]} ${mobile[2]} ${mobile[3]}`;
  return e164;
}
