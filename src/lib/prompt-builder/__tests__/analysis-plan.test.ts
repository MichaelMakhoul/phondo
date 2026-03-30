import { describe, it, expect } from "vitest";
import { buildAnalysisPlan } from "../generate-prompt";
import type { PromptConfig, CollectionField } from "../types";

function makeConfig(fields: CollectionField[]): PromptConfig {
  return {
    version: 1,
    fields,
    behaviors: {
      scheduleAppointments: false,
      handleEmergencies: false,
      providePricingInfo: false,
      takeMessages: false,
      transferToHuman: false,
      afterHoursHandling: false,
    },
    tone: "professional",
    customInstructions: "",
    isManuallyEdited: false,
  };
}

function makeField(overrides: Partial<CollectionField> = {}): CollectionField {
  return {
    id: "first_name",
    label: "First Name",
    type: "text",
    required: true,
    verification: "none",
    category: "universal",
    ...overrides,
  };
}

describe("buildAnalysisPlan", () => {
  it("returns null for empty fields", () => {
    const config = makeConfig([]);
    expect(buildAnalysisPlan(config)).toBeNull();
  });

  it("generates schema from a single required field", () => {
    const config = makeConfig([makeField()]);
    const plan = buildAnalysisPlan(config);

    expect(plan).not.toBeNull();
    expect(plan!.structuredDataSchema.properties).toHaveProperty("first_name");
    expect(plan!.structuredDataSchema.properties.first_name.type).toBe("string");
    expect(plan!.structuredDataSchema.required).toContain("first_name");
    expect(plan!.successEvaluationRubric).toBe("PassFail");
  });

  it("generates schema from multiple fields with mixed required", () => {
    const config = makeConfig([
      makeField({ id: "1", label: "Full Name", required: true }),
      makeField({ id: "2", label: "Phone Number", type: "phone", required: true }),
      makeField({ id: "3", label: "Date of Birth", type: "date", required: false }),
      makeField({ id: "4", label: "Insurance ID", type: "text", required: false }),
    ]);

    const plan = buildAnalysisPlan(config);
    expect(plan).not.toBeNull();

    const props = plan!.structuredDataSchema.properties;
    expect(Object.keys(props)).toHaveLength(4);
    expect(props).toHaveProperty("full_name");
    expect(props).toHaveProperty("phone_number");
    expect(props).toHaveProperty("date_of_birth");
    expect(props).toHaveProperty("insurance_id");

    expect(plan!.structuredDataSchema.required).toContain("full_name");
    expect(plan!.structuredDataSchema.required).toContain("phone_number");
  });

  it("omits required array when no fields are required", () => {
    const config = makeConfig([
      makeField({ id: "1", label: "Notes", required: false }),
    ]);

    const plan = buildAnalysisPlan(config);
    expect(plan).not.toBeNull();
    expect(plan!.structuredDataSchema.required).toBeUndefined();
  });

  it("converts labels to snake_case keys correctly", () => {
    const config = makeConfig([
      makeField({ id: "1", label: "Caller's Email Address" }),
      makeField({ id: "2", label: "VIN Number" }),
      makeField({ id: "3", label: "Date of Birth (DOB)" }),
    ]);

    const plan = buildAnalysisPlan(config);
    const keys = Object.keys(plan!.structuredDataSchema.properties);
    expect(keys).toContain("callers_email_address");
    expect(keys).toContain("vin_number");
    expect(keys).toContain("date_of_birth_dob");
  });

  it("includes field descriptions in schema and prompt", () => {
    const config = makeConfig([
      makeField({
        id: "1",
        label: "Insurance ID",
        description: "The caller's insurance policy number",
      }),
    ]);

    const plan = buildAnalysisPlan(config);
    expect(plan!.structuredDataSchema.properties.insurance_id.description).toBe(
      "The caller's insurance policy number"
    );
    expect(plan!.structuredDataPrompt).toContain("insurance policy number");
  });

  it("uses label as description when no description provided", () => {
    const config = makeConfig([
      makeField({ id: "1", label: "Full Name" }),
    ]);

    const plan = buildAnalysisPlan(config);
    expect(plan!.structuredDataSchema.properties.full_name.description).toBe("Full Name");
  });

  it("maps all field types to string in JSON schema", () => {
    const types = ["text", "phone", "email", "date", "number", "select", "address"] as const;

    for (const type of types) {
      const config = makeConfig([makeField({ id: "1", label: "Test Field", type })]);
      const plan = buildAnalysisPlan(config);
      expect(plan!.structuredDataSchema.properties.test_field.type).toBe("string");
    }
  });

  it("generates structured data prompt listing all fields", () => {
    const config = makeConfig([
      makeField({ id: "1", label: "Full Name" }),
      makeField({ id: "2", label: "Phone Number", type: "phone" }),
    ]);

    const plan = buildAnalysisPlan(config);
    expect(plan!.structuredDataPrompt).toContain("Full Name");
    expect(plan!.structuredDataPrompt).toContain("Phone Number");
    expect(plan!.structuredDataPrompt).toContain("full_name");
    expect(plan!.structuredDataPrompt).toContain("phone_number");
  });
});
