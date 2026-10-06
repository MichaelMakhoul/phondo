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
    name: "Copperline Plumbing",
    description: "Leaks, blocked drains, and hot water: books the job and asks for a photo so the plumber brings the right parts",
  },
} as const;

export const DEMO_RATE_LIMIT_ERROR = "Too many demo calls";

export type DemoIndustry = keyof typeof DEMO_INDUSTRIES;

export function isDemoIndustry(value: unknown): value is DemoIndustry {
  // Own keys only: `in` also accepts inherited names like "toString", and this
  // value now arrives from URLs (?industry=) as well as request bodies.
  return typeof value === "string" && Object.hasOwn(DEMO_INDUSTRIES, value);
}

/** The `?industry=` deep link (tradie outreach links straight to the plumber), validated. */
export function demoIndustryFromSearch(search: string): DemoIndustry | null {
  const value = new URLSearchParams(search).get("industry");
  return isDemoIndustry(value) ? value : null;
}

/**
 * SCRUM-571: the public tap-to-call demo line. E.164 in the env var; unset →
 * the /demo page simply doesn't render the phone CTA (publish switch: set it
 * only after the voice-server demo-line guards are deployed).
 */
export const DEMO_PHONE_NUMBER = process.env.NEXT_PUBLIC_DEMO_PHONE_NUMBER;

/**
 * The trades demo line, which answers as Copperline Plumbing. Since migration
 * 00166, the published line (+61238205672) is that line: its own real org,
 * re-skinned from Smile Hub Dental, with the same persona text as the browser
 * plumber. So set this to +61238205672 and UNSET NEXT_PUBLIC_DEMO_PHONE_NUMBER,
 * or /demo will label the plumber as "our demo dental clinic". Pointing a
 * number at the demo org instead would first need the voice server to run
 * demo-org PHONE calls in test mode (docs/engineering-follow-ups.md §H).
 */
export const DEMO_TRADES_PHONE_NUMBER = process.env.NEXT_PUBLIC_DEMO_TRADES_PHONE_NUMBER;

/** Each tap-to-call line, by the demo persona it answers as. */
export const DEMO_PHONE_LINES: Partial<Record<DemoIndustry, { number: string | undefined; persona: string }>> = {
  dental: { number: DEMO_PHONE_NUMBER, persona: "our demo dental clinic" },
  home_services: { number: DEMO_TRADES_PHONE_NUMBER, persona: "our demo plumbing business" },
};

/** Build-time: is any tap-to-call line configured at all? (No line → no reserved hero slot.) */
export const HAS_DEMO_PHONE_LINE = Object.values(DEMO_PHONE_LINES).some((line) => !!line?.number);

/** Render an E.164 AU number in familiar local notation; pass through anything else. */
export function formatDemoPhoneDisplay(e164: string): string {
  const landline = e164.match(/^\+61([2378])(\d{4})(\d{4})$/);
  if (landline) return `(0${landline[1]}) ${landline[2]} ${landline[3]}`;
  const mobile = e164.match(/^\+61(4\d{2})(\d{3})(\d{3})$/);
  if (mobile) return `0${mobile[1]} ${mobile[2]} ${mobile[3]}`;
  return e164;
}
