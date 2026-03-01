import { describe, it, expect } from "vitest";
import {
  templates,
  getTemplateByIndustry,
  industryOptions,
  populateTemplate,
} from "../index";

describe("templates", () => {
  describe("templates map", () => {
    it("should have 15 industry templates", () => {
      expect(Object.keys(templates)).toHaveLength(15);
    });

    it("should contain all expected industries", () => {
      const expectedIndustries = [
        "dental",
        "legal",
        "home_services",
        "medical",
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
      expectedIndustries.forEach((industry) => {
        expect(templates[industry]).toBeDefined();
      });
    });

    it("each template should have all required fields", () => {
      Object.entries(templates).forEach(([key, template]) => {
        expect(template.industry).toBe(key);
        expect(template.name).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.systemPrompt).toBeTruthy();
        expect(template.firstMessage).toBeTruthy();
        expect(Array.isArray(template.sampleFAQs)).toBe(true);
        expect(template.sampleFAQs.length).toBeGreaterThan(0);
        expect(template.voiceId).toBeTruthy();
        expect(template.recommendedSettings).toBeDefined();
        expect(template.recommendedSettings.maxCallDuration).toBeGreaterThan(0);
        expect(template.recommendedSettings.silenceTimeout).toBeGreaterThan(0);
      });
    });

    it("each template systemPrompt should contain {business_name} placeholder", () => {
      Object.values(templates).forEach((template) => {
        expect(template.systemPrompt).toContain("{business_name}");
      });
    });

    it("each template firstMessage should contain {business_name} placeholder", () => {
      Object.values(templates).forEach((template) => {
        expect(template.firstMessage).toContain("{business_name}");
      });
    });

    it("each template systemPrompt should contain {knowledge_base} placeholder", () => {
      Object.values(templates).forEach((template) => {
        expect(template.systemPrompt).toContain("{knowledge_base}");
      });
    });
  });

  describe("new industry templates content quality", () => {
    it("salon template should reference appointments and services", () => {
      expect(templates.salon.systemPrompt).toContain("appointment");
      expect(templates.salon.systemPrompt).toContain("service");
    });

    it("automotive template should reference vehicle and repair", () => {
      expect(templates.automotive.systemPrompt).toContain("vehicle");
      expect(templates.automotive.systemPrompt).toContain("service");
    });

    it("veterinary template should reference pet and emergency", () => {
      expect(templates.veterinary.systemPrompt).toContain("pet");
      expect(templates.veterinary.systemPrompt).toContain("emergency");
    });

    it("restaurant template should reference reservation and menu", () => {
      expect(templates.restaurant.systemPrompt).toContain("reservation");
      expect(templates.restaurant.systemPrompt).toContain("menu");
    });

    it("accounting template should reference tax and consultation", () => {
      expect(templates.accounting.systemPrompt).toContain("tax");
      expect(templates.accounting.systemPrompt).toContain("consultation");
    });

    it("insurance template should reference claim and policy", () => {
      expect(templates.insurance.systemPrompt).toContain("claim");
      expect(templates.insurance.systemPrompt).toContain("policy");
    });

    it("fitness template should reference membership and class", () => {
      expect(templates.fitness.systemPrompt).toContain("membership");
      expect(templates.fitness.systemPrompt).toContain("class");
    });

    it("childcare template should reference enrolment and child", () => {
      expect(templates.childcare.systemPrompt).toContain("enrolment");
      expect(templates.childcare.systemPrompt).toContain("child");
    });

    it("funeral_services template should reference compassion and deceased", () => {
      expect(templates.funeral_services.systemPrompt).toContain("compassion");
      expect(templates.funeral_services.systemPrompt).toContain("deceased");
    });
  });

  describe("getTemplateByIndustry", () => {
    it("should return the correct template for each industry", () => {
      Object.keys(templates).forEach((industry) => {
        const template = getTemplateByIndustry(industry);
        expect(template.industry).toBe(industry);
      });
    });

    it("should return 'other' template for unknown industries", () => {
      const template = getTemplateByIndustry("mystery_shop");
      expect(template.industry).toBe("other");
    });

    it("should return 'other' template for empty string", () => {
      const template = getTemplateByIndustry("");
      expect(template.industry).toBe("other");
    });
  });

  describe("industryOptions", () => {
    it("should have 15 options", () => {
      expect(industryOptions).toHaveLength(15);
    });

    it("should have 'other' as the last option", () => {
      expect(industryOptions[industryOptions.length - 1].value).toBe("other");
    });

    it("each option should have value, label, and description", () => {
      industryOptions.forEach((option) => {
        expect(option.value).toBeTruthy();
        expect(option.label).toBeTruthy();
        expect(option.description).toBeTruthy();
      });
    });

    it("option values should match template keys", () => {
      const templateKeys = Object.keys(templates);
      const optionValues = industryOptions.map((o) => o.value);
      expect(optionValues.sort()).toEqual(templateKeys.sort());
    });

    it("should include all new industries", () => {
      const values = industryOptions.map((o) => o.value);
      expect(values).toContain("salon");
      expect(values).toContain("automotive");
      expect(values).toContain("veterinary");
      expect(values).toContain("restaurant");
      expect(values).toContain("accounting");
      expect(values).toContain("insurance");
      expect(values).toContain("fitness");
      expect(values).toContain("childcare");
      expect(values).toContain("funeral_services");
    });
  });

  describe("populateTemplate", () => {
    it("should replace {business_name} in systemPrompt and firstMessage", () => {
      const template = templates.dental;
      const result = populateTemplate(template, {
        business_name: "Bright Smiles Dental",
      });

      expect(result.systemPrompt).toContain("Bright Smiles Dental");
      expect(result.systemPrompt).not.toContain("{business_name}");
      expect(result.firstMessage).toContain("Bright Smiles Dental");
      expect(result.firstMessage).not.toContain("{business_name}");
    });

    it("should replace {knowledge_base} when provided", () => {
      const template = templates.medical;
      const result = populateTemplate(template, {
        business_name: "Health First",
        knowledge_base: "Open 24/7. Emergency walk-ins welcome.",
      });

      expect(result.systemPrompt).toContain(
        "Open 24/7. Emergency walk-ins welcome."
      );
      expect(result.systemPrompt).not.toContain("{knowledge_base}");
    });

    it("should use default knowledge base message when not provided", () => {
      const template = templates.dental;
      const result = populateTemplate(template, {
        business_name: "Test",
      });

      expect(result.systemPrompt).toContain(
        "No additional business information provided yet."
      );
      expect(result.systemPrompt).not.toContain("{knowledge_base}");
    });

    it("should work with new salon template", () => {
      const result = populateTemplate(templates.salon, {
        business_name: "Luxe Salon",
      });
      expect(result.systemPrompt).toContain("Luxe Salon");
      expect(result.firstMessage).toContain("Luxe Salon");
    });

    it("should work with new automotive template", () => {
      const result = populateTemplate(templates.automotive, {
        business_name: "Quick Fix Auto",
      });
      expect(result.systemPrompt).toContain("Quick Fix Auto");
      expect(result.firstMessage).toContain("Quick Fix Auto");
    });

    it("should work with new veterinary template", () => {
      const result = populateTemplate(templates.veterinary, {
        business_name: "Happy Paws Vet",
      });
      expect(result.systemPrompt).toContain("Happy Paws Vet");
      expect(result.firstMessage).toContain("Happy Paws Vet");
    });

    it("should work with new restaurant template", () => {
      const result = populateTemplate(templates.restaurant, {
        business_name: "Bella Italia",
      });
      expect(result.systemPrompt).toContain("Bella Italia");
      expect(result.firstMessage).toContain("Bella Italia");
    });

    it("should work with accounting template", () => {
      const result = populateTemplate(templates.accounting, {
        business_name: "Smith & Co Accounting",
      });
      expect(result.systemPrompt).toContain("Smith & Co Accounting");
      expect(result.firstMessage).toContain("Smith & Co Accounting");
    });

    it("should work with insurance template", () => {
      const result = populateTemplate(templates.insurance, {
        business_name: "Secure Cover Insurance",
      });
      expect(result.systemPrompt).toContain("Secure Cover Insurance");
      expect(result.firstMessage).toContain("Secure Cover Insurance");
    });

    it("should work with fitness template", () => {
      const result = populateTemplate(templates.fitness, {
        business_name: "Peak Fitness",
      });
      expect(result.systemPrompt).toContain("Peak Fitness");
      expect(result.firstMessage).toContain("Peak Fitness");
    });

    it("should work with childcare template", () => {
      const result = populateTemplate(templates.childcare, {
        business_name: "Little Stars Childcare",
      });
      expect(result.systemPrompt).toContain("Little Stars Childcare");
      expect(result.firstMessage).toContain("Little Stars Childcare");
    });

    it("should work with funeral_services template", () => {
      const result = populateTemplate(templates.funeral_services, {
        business_name: "Peaceful Rest Funerals",
      });
      expect(result.systemPrompt).toContain("Peaceful Rest Funerals");
      expect(result.firstMessage).toContain("Peaceful Rest Funerals");
    });
  });
});
