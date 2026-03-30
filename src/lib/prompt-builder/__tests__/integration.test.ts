import { describe, it, expect } from "vitest";
import { getDefaultConfig } from "../defaults";
import { buildPromptFromConfig, generateGreeting } from "../generate-prompt";
import { getFieldsForIndustry, universalFields } from "../field-presets";
import type { PromptConfig } from "../types";

describe("prompt-builder integration", () => {
  describe("end-to-end: default config → prompt generation", () => {
    it("medical onboarding flow produces complete prompt", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, {
        businessName: "Springfield Medical Center",
        industry: "medical",
        knowledgeBase: "Open Mon-Fri 8am-6pm. Accepting new patients.",
      });
      const greeting = generateGreeting(config.tone, "Springfield Medical Center");

      // Prompt should have all sections
      expect(prompt).toContain("Springfield Medical Center");
      expect(prompt).toContain("friendly and warm"); // tone
      expect(prompt).toContain("Open Mon-Fri 8am-6pm"); // knowledge base
      expect(prompt).toContain("First Name"); // universal field
      expect(prompt).toContain("Date of Birth"); // medical field
      expect(prompt).toContain("Medicare Card Number"); // medical field
      expect(prompt).toContain("SCHEDULING:"); // behavior
      expect(prompt).toContain("EMERGENCIES:"); // behavior
      expect(prompt).toContain("HIPAA"); // industry guideline

      // Greeting should match tone
      expect(greeting).toContain("Springfield Medical Center");
      expect(greeting).toContain("Hi there");
    });

    it("legal onboarding flow produces complete prompt", () => {
      const config = getDefaultConfig("legal");
      const prompt = buildPromptFromConfig(config, {
        businessName: "Baker & Associates Law Firm",
        industry: "legal",
      });

      expect(prompt).toContain("Baker & Associates Law Firm");
      expect(prompt).toContain("professional and courteous"); // professional tone
      expect(prompt).toContain("Case Type"); // legal field
      expect(prompt).toContain("Matter Description"); // legal field
      expect(prompt).toContain("MESSAGES:"); // takeMessages
      expect(prompt).toContain("TRANSFERS:"); // transferToHuman
      expect(prompt).not.toContain("- SCHEDULING:"); // scheduling behavior disabled for legal
      expect(prompt).toContain("attorney-client confidentiality");
    });

    it("salon onboarding flow produces complete prompt", () => {
      const config = getDefaultConfig("salon");
      const prompt = buildPromptFromConfig(config, {
        businessName: "Luxe Hair Studio",
        industry: "salon",
      });

      expect(prompt).toContain("Luxe Hair Studio");
      expect(prompt).toContain("Appointment Type");
      expect(prompt).toContain("Preferred Stylist");
      expect(prompt).toContain("SCHEDULING:");
      expect(prompt).toContain("PRICING:");
      expect(prompt).toContain("stylist");
    });

    it("restaurant onboarding flow produces complete prompt", () => {
      const config = getDefaultConfig("restaurant");
      const prompt = buildPromptFromConfig(config, {
        businessName: "Bella Italia",
        industry: "restaurant",
      });

      expect(prompt).toContain("Bella Italia");
      expect(prompt).toContain("Party Size");
      expect(prompt).toContain("Reservation Date / Time");
      expect(prompt).toContain("Dietary Restrictions");
      expect(prompt).toContain("SCHEDULING:");
    });
  });

  describe("field modifications", () => {
    it("removing fields should shrink the prompt", () => {
      const config = getDefaultConfig("medical");
      const fullPrompt = buildPromptFromConfig(config, {
        businessName: "Test",
        industry: "medical",
      });

      // Remove all optional fields
      const trimmedConfig: PromptConfig = {
        ...config,
        fields: config.fields.filter((f) => f.required),
      };
      const trimmedPrompt = buildPromptFromConfig(trimmedConfig, {
        businessName: "Test",
        industry: "medical",
      });

      expect(trimmedPrompt.length).toBeLessThan(fullPrompt.length);
      expect(trimmedPrompt).not.toContain("Optional (collect if relevant):");
    });

    it("adding a custom field should appear in the prompt", () => {
      const config = getDefaultConfig("other");
      const customField = {
        id: "custom_loyalty_number",
        label: "Loyalty Card Number",
        type: "text" as const,
        required: true,
        verification: "read-back-characters" as const,
        category: "other" as const,
      };
      const modifiedConfig: PromptConfig = {
        ...config,
        fields: [...config.fields, customField],
      };

      const prompt = buildPromptFromConfig(modifiedConfig, {
        businessName: "Test",
        industry: "other",
      });

      expect(prompt).toContain("Loyalty Card Number");
      expect(prompt).toContain("read it back character by character");
    });
  });

  describe("behavior toggles affect prompt", () => {
    it("toggling all behaviors off should only show CAPABILITIES header", () => {
      const config: PromptConfig = {
        ...getDefaultConfig("other"),
        behaviors: {
          scheduleAppointments: false,
          handleEmergencies: false,
          providePricingInfo: false,
          takeMessages: false,
          transferToHuman: false,
          afterHoursHandling: false,
        },
      };

      const prompt = buildPromptFromConfig(config, {
        businessName: "Test",
        industry: "other",
      });

      expect(prompt).toContain("CAPABILITIES:");
      // "- SCHEDULING:" is the behavior toggle; "TIMEZONE & SCHEDULING:" is always present
      expect(prompt).not.toContain("- SCHEDULING:");
      expect(prompt).not.toContain("EMERGENCIES:");
      expect(prompt).not.toContain("PRICING:");
      expect(prompt).not.toContain("MESSAGES:");
      expect(prompt).not.toContain("TRANSFERS:");
      expect(prompt).not.toContain("AFTER HOURS:");
      // Datetime tool instruction is always included regardless of behaviors
      expect(prompt).toContain("TIMEZONE & SCHEDULING:");
    });

    it("toggling all behaviors on should include all 6", () => {
      const config: PromptConfig = {
        ...getDefaultConfig("other"),
        behaviors: {
          scheduleAppointments: true,
          handleEmergencies: true,
          providePricingInfo: true,
          takeMessages: true,
          transferToHuman: true,
          afterHoursHandling: true,
        },
      };

      const prompt = buildPromptFromConfig(config, {
        businessName: "Test",
        industry: "other",
      });

      expect(prompt).toContain("SCHEDULING:");
      expect(prompt).toContain("EMERGENCIES:");
      expect(prompt).toContain("PRICING:");
      expect(prompt).toContain("MESSAGES:");
      expect(prompt).toContain("TRANSFERS:");
      expect(prompt).toContain("AFTER HOURS:");
    });
  });

  describe("tone changes affect prompt and greeting", () => {
    it("changing tone should change both prompt preamble and greeting", () => {
      const tones = ["professional", "friendly", "casual"] as const;
      const prompts: string[] = [];
      const greetings: string[] = [];

      tones.forEach((tone) => {
        const config: PromptConfig = {
          ...getDefaultConfig("other"),
          tone,
        };
        prompts.push(
          buildPromptFromConfig(config, {
            businessName: "Test Biz",
            industry: "other",
          })
        );
        greetings.push(generateGreeting(tone, "Test Biz"));
      });

      // All prompts should be different from each other
      expect(prompts[0]).not.toBe(prompts[1]);
      expect(prompts[1]).not.toBe(prompts[2]);
      expect(prompts[0]).not.toBe(prompts[2]);

      // All greetings should be different
      expect(greetings[0]).not.toBe(greetings[1]);
      expect(greetings[1]).not.toBe(greetings[2]);
    });
  });

  describe("config serialization round-trip", () => {
    it("should survive JSON serialization (simulating localStorage/DB)", () => {
      const original = getDefaultConfig("veterinary");
      const serialized = JSON.stringify(original);
      const deserialized: PromptConfig = JSON.parse(serialized);

      // Verify structure is preserved
      expect(deserialized.version).toBe(original.version);
      expect(deserialized.fields.length).toBe(original.fields.length);
      expect(deserialized.behaviors).toEqual(original.behaviors);
      expect(deserialized.tone).toBe(original.tone);
      expect(deserialized.customInstructions).toBe(original.customInstructions);
      expect(deserialized.isManuallyEdited).toBe(original.isManuallyEdited);

      // Verify it generates the same prompt
      const context = { businessName: "Happy Tails Vet", industry: "veterinary" };
      const originalPrompt = buildPromptFromConfig(original, context);
      const deserializedPrompt = buildPromptFromConfig(deserialized, context);
      expect(deserializedPrompt).toBe(originalPrompt);
    });
  });

  describe("getFieldsForIndustry matches getDefaultConfig", () => {
    const industries = [
      "medical",
      "dental",
      "legal",
      "home_services",
      "real_estate",
      "salon",
      "automotive",
      "veterinary",
      "restaurant",
      "other",
    ];

    industries.forEach((industry) => {
      it(`fields for '${industry}' should match between getFieldsForIndustry and getDefaultConfig`, () => {
        const { universal, industry: industryFields } = getFieldsForIndustry(industry);
        const config = getDefaultConfig(industry);

        // Default config fields = universal + industry
        const expectedIds = [...universal, ...industryFields].map((f) => f.id);
        const actualIds = config.fields.map((f) => f.id);

        expect(actualIds).toEqual(expectedIds);
      });
    });
  });
});
