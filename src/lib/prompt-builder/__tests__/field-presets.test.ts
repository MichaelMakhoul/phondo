import { describe, it, expect } from "vitest";
import {
  universalFields,
  fieldPresetsByIndustry,
  getFieldsForIndustry,
} from "../field-presets";
import type { FieldCategory } from "../types";

describe("field-presets", () => {
  describe("universalFields", () => {
    it("should have exactly 3 universal fields", () => {
      expect(universalFields).toHaveLength(3);
    });

    it("should include full_name, phone_number, and email_address", () => {
      const ids = universalFields.map((f) => f.id);
      expect(ids).toContain("full_name");
      expect(ids).toContain("phone_number");
      expect(ids).toContain("email_address");
    });

    it("should mark full_name and phone_number as required", () => {
      const fullName = universalFields.find((f) => f.id === "full_name");
      const phone = universalFields.find((f) => f.id === "phone_number");
      const email = universalFields.find((f) => f.id === "email_address");

      expect(fullName?.required).toBe(true);
      expect(phone?.required).toBe(true);
      expect(email?.required).toBe(false);
    });

    it("should have correct verification methods", () => {
      const fullName = universalFields.find((f) => f.id === "full_name");
      const phone = universalFields.find((f) => f.id === "phone_number");
      const email = universalFields.find((f) => f.id === "email_address");

      expect(fullName?.verification).toBe("repeat-confirm");
      expect(phone?.verification).toBe("read-back-digits");
      expect(email?.verification).toBe("spell-out");
    });

    it("should all have category 'universal'", () => {
      universalFields.forEach((field) => {
        expect(field.category).toBe("universal");
      });
    });
  });

  describe("fieldPresetsByIndustry", () => {
    const allIndustries: FieldCategory[] = [
      "universal",
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

    it("should have presets for all 16 categories", () => {
      allIndustries.forEach((industry) => {
        expect(fieldPresetsByIndustry[industry]).toBeDefined();
        expect(Array.isArray(fieldPresetsByIndustry[industry])).toBe(true);
      });
    });

    it("medical should include DOB, insurance, medicare fields", () => {
      const ids = fieldPresetsByIndustry.medical.map((f) => f.id);
      expect(ids).toContain("dob");
      expect(ids).toContain("insurance_provider");
      expect(ids).toContain("insurance_member_id");
      expect(ids).toContain("medicare_card_number");
      expect(ids).toContain("symptoms");
    });

    it("dental should include DOB, insurance, reason for visit", () => {
      const ids = fieldPresetsByIndustry.dental.map((f) => f.id);
      expect(ids).toContain("dob");
      expect(ids).toContain("insurance_provider");
      expect(ids).toContain("reason_for_visit");
      expect(ids).toContain("last_dental_visit");
    });

    it("legal should include case_type, matter_description", () => {
      const ids = fieldPresetsByIndustry.legal.map((f) => f.id);
      expect(ids).toContain("case_type");
      expect(ids).toContain("matter_description");
      expect(ids).toContain("opposing_party");
    });

    it("home_services should include service_address, urgency_level", () => {
      const ids = fieldPresetsByIndustry.home_services.map((f) => f.id);
      expect(ids).toContain("service_address");
      expect(ids).toContain("problem_description");
      expect(ids).toContain("urgency_level");
    });

    it("salon should include appointment_type, preferred_stylist", () => {
      const ids = fieldPresetsByIndustry.salon.map((f) => f.id);
      expect(ids).toContain("appointment_type");
      expect(ids).toContain("preferred_stylist");
      expect(ids).toContain("service_requested");
    });

    it("automotive should include vehicle_make, vehicle_model, vin", () => {
      const ids = fieldPresetsByIndustry.automotive.map((f) => f.id);
      expect(ids).toContain("vehicle_make");
      expect(ids).toContain("vehicle_model");
      expect(ids).toContain("vehicle_year");
      expect(ids).toContain("vin");
    });

    it("veterinary should include pet_name, species, breed", () => {
      const ids = fieldPresetsByIndustry.veterinary.map((f) => f.id);
      expect(ids).toContain("pet_name");
      expect(ids).toContain("species");
      expect(ids).toContain("breed");
    });

    it("restaurant should include party_size, reservation_date_time", () => {
      const ids = fieldPresetsByIndustry.restaurant.map((f) => f.id);
      expect(ids).toContain("party_size");
      expect(ids).toContain("reservation_date_time");
      expect(ids).toContain("dietary_restrictions");
    });

    it("accounting should include company_name, service_type, abn", () => {
      const ids = fieldPresetsByIndustry.accounting.map((f) => f.id);
      expect(ids).toContain("company_name");
      expect(ids).toContain("service_type_accounting");
      expect(ids).toContain("abn");
    });

    it("insurance should include policy_number, inquiry_type, claim_number", () => {
      const ids = fieldPresetsByIndustry.insurance.map((f) => f.id);
      expect(ids).toContain("policy_number");
      expect(ids).toContain("inquiry_type_insurance");
      expect(ids).toContain("claim_number");
    });

    it("fitness should include membership_type, class_interest", () => {
      const ids = fieldPresetsByIndustry.fitness.map((f) => f.id);
      expect(ids).toContain("membership_type");
      expect(ids).toContain("class_interest");
    });

    it("childcare should include child_name, child_age, days_needed", () => {
      const ids = fieldPresetsByIndustry.childcare.map((f) => f.id);
      expect(ids).toContain("child_name");
      expect(ids).toContain("child_age");
      expect(ids).toContain("days_needed");
    });

    it("funeral_services should include deceased_name, caller_relationship", () => {
      const ids = fieldPresetsByIndustry.funeral_services.map((f) => f.id);
      expect(ids).toContain("deceased_name");
      expect(ids).toContain("caller_relationship");
    });

    it("should have IDs with read-back-characters verification for ID-type fields", () => {
      const medicare = fieldPresetsByIndustry.medical.find(
        (f) => f.id === "medicare_card_number"
      );
      const insuranceId = fieldPresetsByIndustry.medical.find(
        (f) => f.id === "insurance_member_id"
      );
      const vin = fieldPresetsByIndustry.automotive.find(
        (f) => f.id === "vin"
      );

      expect(medicare?.verification).toBe("read-back-characters");
      expect(insuranceId?.verification).toBe("read-back-characters");
      expect(vin?.verification).toBe("read-back-characters");
    });

    it("all fields should have valid verification methods", () => {
      const validMethods = [
        "read-back-digits",
        "spell-out",
        "repeat-confirm",
        "read-back-characters",
        "none",
      ];
      Object.values(fieldPresetsByIndustry).forEach((fields) => {
        fields.forEach((field) => {
          expect(validMethods).toContain(field.verification);
        });
      });
    });

    it("all fields should have valid types", () => {
      const validTypes = [
        "text",
        "phone",
        "email",
        "date",
        "number",
        "select",
        "address",
      ];
      Object.values(fieldPresetsByIndustry).forEach((fields) => {
        fields.forEach((field) => {
          expect(validTypes).toContain(field.type);
        });
      });
    });

    it("all fields should have unique IDs within their category", () => {
      Object.entries(fieldPresetsByIndustry).forEach(([category, fields]) => {
        const ids = fields.map((f) => f.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
      });
    });
  });

  describe("getFieldsForIndustry", () => {
    it("should return universal and industry fields for medical", () => {
      const result = getFieldsForIndustry("medical");
      expect(result.universal).toEqual(universalFields);
      expect(result.industry).toEqual(fieldPresetsByIndustry.medical);
    });

    it("should return universal and industry fields for salon", () => {
      const result = getFieldsForIndustry("salon");
      expect(result.universal).toEqual(universalFields);
      expect(result.industry).toEqual(fieldPresetsByIndustry.salon);
    });

    it("should fall back to 'other' for unknown industries", () => {
      const result = getFieldsForIndustry("blockchain_consulting");
      expect(result.universal).toEqual(universalFields);
      expect(result.industry).toEqual(fieldPresetsByIndustry.other);
    });

    it("should fall back to 'other' for empty string", () => {
      const result = getFieldsForIndustry("");
      expect(result.universal).toEqual(universalFields);
      expect(result.industry).toEqual(fieldPresetsByIndustry.other);
    });
  });
});
