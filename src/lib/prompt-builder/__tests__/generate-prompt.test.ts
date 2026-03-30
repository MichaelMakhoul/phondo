import { describe, it, expect } from "vitest";
import { buildPromptFromConfig, generateGreeting } from "../generate-prompt";
import { getDefaultConfig } from "../defaults";
import type { PromptConfig, CollectionField } from "../types";

describe("generate-prompt", () => {
  const baseContext = {
    businessName: "Acme Medical",
    industry: "medical",
  };

  describe("buildPromptFromConfig", () => {
    it("should include business name in preamble", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("Acme Medical");
    });

    it("should use placeholder when businessName is empty", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        businessName: "",
      });
      expect(prompt).toContain("{business_name}");
    });

    it("should include tone description for 'friendly'", () => {
      const config = getDefaultConfig("medical"); // defaults to friendly
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("warm, approachable");
      expect(prompt).toContain("friendly and warm");
    });

    it("should include tone description for 'professional'", () => {
      const config = { ...getDefaultConfig("legal") }; // defaults to professional
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "legal",
      });
      expect(prompt).toContain("professional and courteous");
      expect(prompt).toContain("polished, formal");
    });

    it("should include tone description for 'casual'", () => {
      const config = { ...getDefaultConfig("other"), tone: "casual" as const };
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("casual and approachable");
      expect(prompt).toContain("relaxed");
    });

    it("should include knowledge base section", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        knowledgeBase: "Open Mon-Fri 9am-5pm. Dr. Smith specializes in cardiology.",
      });
      expect(prompt).toContain("Open Mon-Fri 9am-5pm");
      expect(prompt).toContain("Dr. Smith specializes in cardiology");
    });

    it("should show default message when no knowledge base", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("No additional business information provided yet.");
    });

    // --- Data collection section ---
    it("should list required fields under 'Required information'", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("Required information:");
      expect(prompt).toContain("First Name");
      expect(prompt).toContain("Phone Number");
    });

    it("should list optional fields under 'Optional'", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("Optional (collect if relevant):");
      expect(prompt).toContain("Email Address");
    });

    it("should include verification instructions for phone numbers", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("read it back digit by digit");
    });

    it("should include verification instructions for email", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("spell it out letter by letter");
    });

    it("should include read-back-characters verification for Medicare", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("read it back character by character");
    });

    it("should skip verification instruction for 'none' method", () => {
      const config: PromptConfig = {
        version: 1,
        fields: [
          {
            id: "test",
            label: "Test Field",
            type: "text",
            required: true,
            verification: "none",
            category: "other",
          },
        ],
        behaviors: {
          scheduleAppointments: false,
          handleEmergencies: false,
          providePricingInfo: false,
          takeMessages: true,
          transferToHuman: false,
          afterHoursHandling: false,
        },
        tone: "friendly",
        customInstructions: "",
        isManuallyEdited: false,
      };
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("Test Field");
      // Should not have any verification instruction line
      expect(prompt).not.toContain("read it back");
      expect(prompt).not.toContain("spell it out");
    });

    it("should handle empty fields array", () => {
      const config: PromptConfig = {
        version: 1,
        fields: [],
        behaviors: {
          scheduleAppointments: false,
          handleEmergencies: false,
          providePricingInfo: false,
          takeMessages: true,
          transferToHuman: false,
          afterHoursHandling: false,
        },
        tone: "friendly",
        customInstructions: "",
        isManuallyEdited: false,
      };
      const prompt = buildPromptFromConfig(config, baseContext);
      // Should not include data collection section
      expect(prompt).not.toContain("DATA COLLECTION:");
      // But should still include tone and capabilities
      expect(prompt).toContain("friendly and warm");
      expect(prompt).toContain("CAPABILITIES:");
    });

    // --- Behaviors section ---
    it("should include scheduling capability when enabled", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("SCHEDULING:");
      expect(prompt).toContain("schedule, reschedule, or cancel appointments");
    });

    it("should include emergency capability when enabled", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("EMERGENCIES:");
    });

    it("should include messaging capability when enabled", () => {
      const config = getDefaultConfig("other");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("MESSAGES:");
    });

    it("should not include disabled capabilities", () => {
      const config = getDefaultConfig("other"); // only takeMessages is on
      const prompt = buildPromptFromConfig(config, baseContext);
      // "- SCHEDULING:" is the behavior toggle; "TIMEZONE & SCHEDULING:" is always present
      expect(prompt).not.toContain("- SCHEDULING:");
      expect(prompt).not.toContain("EMERGENCIES:");
      expect(prompt).not.toContain("PRICING:");
      expect(prompt).not.toContain("TRANSFERS:");
      expect(prompt).not.toContain("AFTER HOURS:");
    });

    it("should include all 6 capabilities when all are enabled", () => {
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
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("SCHEDULING:");
      expect(prompt).toContain("EMERGENCIES:");
      expect(prompt).toContain("PRICING:");
      expect(prompt).toContain("MESSAGES:");
      expect(prompt).toContain("TRANSFERS:");
      expect(prompt).toContain("AFTER HOURS:");
    });

    // --- Industry guidelines ---
    it("should include HIPAA guidelines for medical", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "medical",
      });
      expect(prompt).toContain("HIPAA");
      expect(prompt).toContain("patient confidentiality");
    });

    it("should include dental-specific guidelines for dental", () => {
      const config = getDefaultConfig("dental");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "dental",
      });
      expect(prompt).toContain("dental anxiety");
    });

    it("should include confidentiality for legal", () => {
      const config = getDefaultConfig("legal");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "legal",
      });
      expect(prompt).toContain("attorney-client confidentiality");
      expect(prompt).toContain("legal advice");
    });

    it("should include emergency guidance for veterinary", () => {
      const config = getDefaultConfig("veterinary");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "veterinary",
      });
      expect(prompt).toContain("emergency vet");
      expect(prompt).toContain("compassionate");
    });

    it("should include vehicle details note for automotive", () => {
      const config = getDefaultConfig("automotive");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "automotive",
      });
      expect(prompt).toContain("vehicle details");
      expect(prompt).toContain("make, model, year");
    });

    it("should include reservation guidance for restaurant", () => {
      const config = getDefaultConfig("restaurant");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "restaurant",
      });
      expect(prompt).toContain("party size");
      expect(prompt).toContain("dietary restrictions");
    });

    it("should include salon-specific guidelines for salon", () => {
      const config = getDefaultConfig("salon");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "salon",
      });
      expect(prompt).toContain("stylist");
      expect(prompt).toContain("allergies");
    });

    it("should include general guidelines for unknown industry", () => {
      const config = getDefaultConfig("other");
      const prompt = buildPromptFromConfig(config, {
        ...baseContext,
        industry: "unknown_industry",
      });
      expect(prompt).toContain("General Guidelines");
    });

    // --- Custom instructions ---
    it("should include custom instructions when provided", () => {
      const config: PromptConfig = {
        ...getDefaultConfig("medical"),
        customInstructions:
          "Always ask if the patient needs wheelchair access.",
      };
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).toContain("ADDITIONAL INSTRUCTIONS:");
      expect(prompt).toContain("wheelchair access");
    });

    it("should not include custom instructions section when empty", () => {
      const config = getDefaultConfig("medical");
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).not.toContain("ADDITIONAL INSTRUCTIONS:");
    });

    it("should not include custom instructions when only whitespace", () => {
      const config: PromptConfig = {
        ...getDefaultConfig("medical"),
        customInstructions: "   \n  ",
      };
      const prompt = buildPromptFromConfig(config, baseContext);
      expect(prompt).not.toContain("ADDITIONAL INSTRUCTIONS:");
    });
  });

  describe("buildPromptFromConfig — all 10 industries produce valid output", () => {
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
      it(`should generate non-empty prompt for '${industry}'`, () => {
        const config = getDefaultConfig(industry);
        const prompt = buildPromptFromConfig(config, {
          businessName: "Test Business",
          industry,
        });

        expect(prompt.length).toBeGreaterThan(100);
        expect(prompt).toContain("Test Business");
        expect(prompt).toContain("CAPABILITIES:");
      });
    });
  });

  describe("generateGreeting", () => {
    it("should generate professional greeting", () => {
      const greeting = generateGreeting("professional", "Smith & Associates");
      expect(greeting).toContain("Smith & Associates");
      expect(greeting).toContain("Thank you for calling");
      expect(greeting).toContain("assist");
    });

    it("should generate friendly greeting", () => {
      const greeting = generateGreeting("friendly", "Happy Paws Vet");
      expect(greeting).toContain("Happy Paws Vet");
      expect(greeting).toContain("Hi there");
    });

    it("should generate casual greeting", () => {
      const greeting = generateGreeting("casual", "Joe's Garage");
      expect(greeting).toContain("Joe's Garage");
      expect(greeting).toContain("Hey");
    });

    it("should use placeholder when business name is empty", () => {
      const greeting = generateGreeting("friendly", "");
      expect(greeting).toContain("{business_name}");
    });
  });
});
