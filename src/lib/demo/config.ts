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

export type DemoIndustry = keyof typeof DEMO_INDUSTRIES;

export function isDemoIndustry(value: unknown): value is DemoIndustry {
  return typeof value === "string" && value in DEMO_INDUSTRIES;
}
