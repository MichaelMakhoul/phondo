import { describe, it, expect } from "vitest";
import {
  stringField,
  stringArrayField,
  isValidPhone,
  isBusinessEmail,
  isPlaceholder,
  cleanLLMField,
  cleanLLMArrayField,
  stripMarkdownFences,
} from "../website-scraper";
import { buildCustomInstructionsFromBusinessInfo } from "../build-custom-instructions";

describe("stringField", () => {
  it("returns the string when given a string", () => {
    expect(stringField("hello")).toBe("hello");
  });

  it("returns empty string for empty string", () => {
    expect(stringField("")).toBe("");
  });

  it("returns undefined for number", () => {
    expect(stringField(42)).toBeUndefined();
  });

  it("returns undefined for boolean", () => {
    expect(stringField(true)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(stringField(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(stringField(undefined)).toBeUndefined();
  });

  it("returns undefined for object", () => {
    expect(stringField({ name: "test" })).toBeUndefined();
  });

  it("returns undefined for array", () => {
    expect(stringField(["a", "b"])).toBeUndefined();
  });
});

describe("stringArrayField", () => {
  it("returns the array when all elements are strings", () => {
    expect(stringArrayField(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty array", () => {
    expect(stringArrayField([])).toEqual([]);
  });

  it("filters out non-string elements", () => {
    expect(stringArrayField(["a", 42, "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns empty array when all elements are non-strings", () => {
    expect(stringArrayField([1, 2, true, null])).toEqual([]);
  });

  it("returns undefined for string", () => {
    expect(stringArrayField("hello")).toBeUndefined();
  });

  it("returns undefined for number", () => {
    expect(stringArrayField(42)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(stringArrayField(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(stringArrayField(undefined)).toBeUndefined();
  });

  it("returns undefined for object", () => {
    expect(stringArrayField({ length: 2 })).toBeUndefined();
  });
});

describe("isValidPhone", () => {
  it("accepts a valid AU landline", () => {
    expect(isValidPhone("+61 2 8123 0183")).toBe(true);
  });

  it("accepts a valid US number", () => {
    expect(isValidPhone("(555) 123-4567")).toBe(true);
  });

  it("rejects numbers shorter than 8 digits", () => {
    expect(isValidPhone("123-456")).toBe(false);
  });

  it("rejects all-same-digit numbers", () => {
    expect(isValidPhone("3333333333")).toBe(false);
  });

  it("rejects sequential 1234567890", () => {
    expect(isValidPhone("1234567890")).toBe(false);
  });

  it("rejects reverse sequential 0987654321", () => {
    expect(isValidPhone("0987654321")).toBe(false);
  });

  it("rejects numbers with 4+ leading zeros", () => {
    expect(isValidPhone("00000057")).toBe(false);
  });

  it("rejects numbers where one digit dominates (>70%)", () => {
    expect(isValidPhone("000000057")).toBe(false);
  });

  it("accepts numbers where no digit dominates", () => {
    expect(isValidPhone("0298765432")).toBe(true);
  });
});

describe("isBusinessEmail", () => {
  it("accepts a normal business email", () => {
    expect(isBusinessEmail("info@acme.com")).toBe(true);
  });

  it("rejects noreply emails", () => {
    expect(isBusinessEmail("noreply@company.com")).toBe(false);
  });

  it("rejects no-reply emails", () => {
    expect(isBusinessEmail("no-reply@company.com")).toBe(false);
  });

  it("rejects example.com emails", () => {
    expect(isBusinessEmail("user@example.com")).toBe(false);
  });

  it("rejects image filenames (.png)", () => {
    expect(isBusinessEmail("logo@2x-001-250x98.png")).toBe(false);
  });

  it("rejects image filenames (.jpg)", () => {
    expect(isBusinessEmail("header@1x.jpg")).toBe(false);
  });

  it("rejects retina image patterns at end of local part", () => {
    expect(isBusinessEmail("image@2x.something.com")).toBe(false);
  });

  it("accepts emails with numbers in domain (not retina pattern)", () => {
    expect(isBusinessEmail("info@2xdesign.com")).toBe(true);
  });
});

describe("isPlaceholder", () => {
  it("returns true for 'Not provided'", () => {
    expect(isPlaceholder("Not provided")).toBe(true);
  });

  it("returns true for 'not available'", () => {
    expect(isPlaceholder("not available")).toBe(true);
  });

  it("returns true for 'N/A'", () => {
    expect(isPlaceholder("N/A")).toBe(true);
  });

  it("returns true for 'none'", () => {
    expect(isPlaceholder("none")).toBe(true);
  });

  it("returns true for 'unknown'", () => {
    expect(isPlaceholder("unknown")).toBe(true);
  });

  it("returns true for 'null'", () => {
    expect(isPlaceholder("null")).toBe(true);
  });

  it("returns true with leading/trailing whitespace", () => {
    expect(isPlaceholder("  N/A  ")).toBe(true);
  });

  it("returns false for real values", () => {
    expect(isPlaceholder("Acme Dental")).toBe(false);
  });

  it("returns false for non-strings", () => {
    expect(isPlaceholder(42)).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
    expect(isPlaceholder(undefined)).toBe(false);
  });
});

describe("cleanLLMField", () => {
  it("returns the string for a valid value", () => {
    expect(cleanLLMField("Acme Dental")).toBe("Acme Dental");
  });

  it("returns undefined for placeholders", () => {
    expect(cleanLLMField("Not provided")).toBeUndefined();
    expect(cleanLLMField("N/A")).toBeUndefined();
  });

  it("returns undefined for empty strings", () => {
    expect(cleanLLMField("")).toBeUndefined();
    expect(cleanLLMField("   ")).toBeUndefined();
  });

  it("returns undefined for non-strings", () => {
    expect(cleanLLMField(42)).toBeUndefined();
    expect(cleanLLMField(null)).toBeUndefined();
    expect(cleanLLMField(undefined)).toBeUndefined();
  });
});

describe("cleanLLMArrayField", () => {
  it("returns the array when all elements are valid", () => {
    expect(cleanLLMArrayField(["Cleaning", "Whitening"])).toEqual(["Cleaning", "Whitening"]);
  });

  it("filters out placeholder strings", () => {
    expect(cleanLLMArrayField(["Cleaning", "Not available", "Whitening"])).toEqual([
      "Cleaning",
      "Whitening",
    ]);
  });

  it("returns undefined when all elements are placeholders", () => {
    expect(cleanLLMArrayField(["Not provided", "N/A"])).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(cleanLLMArrayField([])).toBeUndefined();
  });

  it("returns undefined for non-arrays", () => {
    expect(cleanLLMArrayField("hello")).toBeUndefined();
    expect(cleanLLMArrayField(42)).toBeUndefined();
    expect(cleanLLMArrayField(null)).toBeUndefined();
  });
});

describe("stripMarkdownFences", () => {
  it("strips ```json fences", () => {
    expect(stripMarkdownFences('```json\n{"name": "Acme"}\n```')).toBe('{"name": "Acme"}');
  });

  it("strips bare ``` fences", () => {
    expect(stripMarkdownFences('```\n{"name": "Acme"}\n```')).toBe('{"name": "Acme"}');
  });

  it("returns plain JSON unchanged", () => {
    expect(stripMarkdownFences('{"name": "Acme"}')).toBe('{"name": "Acme"}');
  });

  it("trims whitespace", () => {
    expect(stripMarkdownFences('  {"name": "Acme"}  ')).toBe('{"name": "Acme"}');
  });

  it("handles fences with trailing whitespace", () => {
    expect(stripMarkdownFences('```json\n{"a": 1}\n```  ')).toBe('{"a": 1}');
  });
});

describe("buildCustomInstructionsFromBusinessInfo", () => {
  it("returns empty string for empty info", () => {
    expect(buildCustomInstructionsFromBusinessInfo({})).toBe("");
  });

  it("returns empty string when all fields are undefined", () => {
    expect(
      buildCustomInstructionsFromBusinessInfo({
        name: undefined,
        phone: undefined,
        email: undefined,
      })
    ).toBe("");
  });

  it("includes about when provided", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      about: "We are a dental clinic in Sydney.",
    });
    expect(result).toContain("About the business: We are a dental clinic in Sydney.");
    expect(result.startsWith("Here is information about the business")).toBe(true);
  });

  it("includes services when provided", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      services: ["Teeth cleaning", "Whitening", "Root canal"],
    });
    expect(result).toContain("Services offered: Teeth cleaning, Whitening, Root canal");
  });

  it("includes hours when provided", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      hours: ["Monday: 9am-5pm", "Tuesday: 9am-5pm"],
    });
    expect(result).toContain("Business hours:");
    expect(result).toContain("Monday: 9am-5pm");
    expect(result).toContain("Tuesday: 9am-5pm");
  });

  it("includes address when provided", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      address: "123 Main St, Sydney NSW 2000",
    });
    expect(result).toContain("Business address: 123 Main St, Sydney NSW 2000");
  });

  it("ignores name, phone, and email (not included in instructions)", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      name: "Acme Dental",
      phone: "+61 2 1234 5678",
      email: "info@acme.com",
    });
    expect(result).toBe("");
  });

  it("combines all relevant fields with double newline separators", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      about: "Full-service dental practice.",
      services: ["Cleaning", "Whitening"],
      hours: ["Mon-Fri: 9am-5pm"],
      address: "123 Main St",
    });

    expect(result).toContain("About the business: Full-service dental practice.");
    expect(result).toContain("Services offered: Cleaning, Whitening");
    expect(result).toContain("Business hours:\nMon-Fri: 9am-5pm");
    expect(result).toContain("Business address: 123 Main St");

    // Verify sections are separated by double newlines
    const sections = result.split("\n\n");
    expect(sections.length).toBeGreaterThanOrEqual(5); // header + 4 sections
  });

  it("skips empty services array", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      services: [],
      about: "A great business.",
    });
    expect(result).not.toContain("Services offered");
    expect(result).toContain("About the business");
  });

  it("skips empty hours array", () => {
    const result = buildCustomInstructionsFromBusinessInfo({
      hours: [],
      about: "A great business.",
    });
    expect(result).not.toContain("Business hours");
    expect(result).toContain("About the business");
  });
});
