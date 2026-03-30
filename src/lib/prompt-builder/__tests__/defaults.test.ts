import { describe, it, expect } from "vitest";
import { getDefaultConfig } from "../defaults";

describe("defaults", () => {
  describe("getDefaultConfig", () => {
    const allIndustries = [
      "medical",
      "dental",
      "legal",
      "home_services",
      "real_estate",
      "salon",
      "automotive",
      "veterinary",
      "restaurant",
      "accounting",
      "insurance",
      "fitness",
      "childcare",
      "funeral_services",
      "other",
    ];

    it("should return a valid PromptConfig for every industry", () => {
      allIndustries.forEach((industry) => {
        const config = getDefaultConfig(industry);
        expect(config.version).toBe(1);
        expect(Array.isArray(config.fields)).toBe(true);
        expect(config.fields.length).toBeGreaterThan(0);
        expect(config.behaviors).toBeDefined();
        expect(["professional", "friendly", "casual"]).toContain(config.tone);
        expect(config.customInstructions).toBe("");
        expect(config.isManuallyEdited).toBe(false);
      });
    });

    it("should include universal fields for all industries", () => {
      allIndustries.forEach((industry) => {
        const config = getDefaultConfig(industry);
        const ids = config.fields.map((f) => f.id);
        expect(ids).toContain("first_name");
        expect(ids).toContain("phone_number");
        expect(ids).toContain("email_address");
      });
    });

    it("should include industry-specific fields", () => {
      const medical = getDefaultConfig("medical");
      const medicalIds = medical.fields.map((f) => f.id);
      expect(medicalIds).toContain("dob");
      expect(medicalIds).toContain("insurance_provider");
      expect(medicalIds).toContain("medicare_card_number");

      const salon = getDefaultConfig("salon");
      const salonIds = salon.fields.map((f) => f.id);
      expect(salonIds).toContain("appointment_type");
      expect(salonIds).toContain("preferred_stylist");
    });

    // --- Behavior defaults ---
    it("medical should enable scheduleAppointments and handleEmergencies", () => {
      const config = getDefaultConfig("medical");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.handleEmergencies).toBe(true);
      expect(config.behaviors.takeMessages).toBe(true);
    });

    it("dental should enable scheduleAppointments, handleEmergencies, and pricing", () => {
      const config = getDefaultConfig("dental");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.handleEmergencies).toBe(true);
      expect(config.behaviors.providePricingInfo).toBe(true);
    });

    it("legal should enable takeMessages and transferToHuman", () => {
      const config = getDefaultConfig("legal");
      expect(config.behaviors.takeMessages).toBe(true);
      expect(config.behaviors.transferToHuman).toBe(true);
      expect(config.behaviors.scheduleAppointments).toBe(false);
    });

    it("salon should enable scheduleAppointments and pricing", () => {
      const config = getDefaultConfig("salon");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.providePricingInfo).toBe(true);
    });

    it("automotive should enable scheduleAppointments, emergencies, and pricing", () => {
      const config = getDefaultConfig("automotive");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.handleEmergencies).toBe(true);
      expect(config.behaviors.providePricingInfo).toBe(true);
    });

    it("veterinary should enable scheduleAppointments and emergencies", () => {
      const config = getDefaultConfig("veterinary");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.handleEmergencies).toBe(true);
    });

    it("restaurant should enable scheduleAppointments", () => {
      const config = getDefaultConfig("restaurant");
      expect(config.behaviors.scheduleAppointments).toBe(true);
    });

    it("accounting should enable scheduleAppointments and takeMessages", () => {
      const config = getDefaultConfig("accounting");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.takeMessages).toBe(true);
    });

    it("insurance should enable takeMessages and transferToHuman", () => {
      const config = getDefaultConfig("insurance");
      expect(config.behaviors.takeMessages).toBe(true);
      expect(config.behaviors.transferToHuman).toBe(true);
    });

    it("fitness should enable scheduleAppointments and pricing", () => {
      const config = getDefaultConfig("fitness");
      expect(config.behaviors.scheduleAppointments).toBe(true);
      expect(config.behaviors.providePricingInfo).toBe(true);
    });

    it("childcare should enable scheduleAppointments", () => {
      const config = getDefaultConfig("childcare");
      expect(config.behaviors.scheduleAppointments).toBe(true);
    });

    it("funeral_services should enable takeMessages, transferToHuman, and afterHoursHandling", () => {
      const config = getDefaultConfig("funeral_services");
      expect(config.behaviors.takeMessages).toBe(true);
      expect(config.behaviors.transferToHuman).toBe(true);
      expect(config.behaviors.afterHoursHandling).toBe(true);
    });

    it("other should default to takeMessages only", () => {
      const config = getDefaultConfig("other");
      expect(config.behaviors.takeMessages).toBe(true);
      expect(config.behaviors.scheduleAppointments).toBe(false);
      expect(config.behaviors.handleEmergencies).toBe(false);
      expect(config.behaviors.providePricingInfo).toBe(false);
      expect(config.behaviors.transferToHuman).toBe(false);
      expect(config.behaviors.afterHoursHandling).toBe(false);
    });

    // --- Tone defaults ---
    it("legal should default to professional tone", () => {
      expect(getDefaultConfig("legal").tone).toBe("professional");
    });

    it("salon should default to friendly tone", () => {
      expect(getDefaultConfig("salon").tone).toBe("friendly");
    });

    it("restaurant should default to friendly tone", () => {
      expect(getDefaultConfig("restaurant").tone).toBe("friendly");
    });

    it("medical should default to friendly tone", () => {
      expect(getDefaultConfig("medical").tone).toBe("friendly");
    });

    it("accounting should default to professional tone", () => {
      expect(getDefaultConfig("accounting").tone).toBe("professional");
    });

    it("insurance should default to professional tone", () => {
      expect(getDefaultConfig("insurance").tone).toBe("professional");
    });

    it("fitness should default to friendly tone", () => {
      expect(getDefaultConfig("fitness").tone).toBe("friendly");
    });

    it("childcare should default to friendly tone", () => {
      expect(getDefaultConfig("childcare").tone).toBe("friendly");
    });

    it("funeral_services should default to professional tone", () => {
      expect(getDefaultConfig("funeral_services").tone).toBe("professional");
    });

    // --- Unknown industry fallback ---
    it("should fall back to 'other' fields for unknown industries", () => {
      const config = getDefaultConfig("spaceship_repair");
      const ids = config.fields.map((f) => f.id);
      // Should have universal fields
      expect(ids).toContain("first_name");
      // Should have 'other' industry fields
      expect(ids).toContain("reason_for_calling");
    });
  });
});
