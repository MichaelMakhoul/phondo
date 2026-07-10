import { describe, it, expect } from "vitest";
import {
  stringField,
  stringArrayField,
  isValidPhone,
  isBusinessEmail,
  isPlaceholder,
  cleanLLMField,
  cleanLLMArrayField,
  cleanLLMFaqs,
  assembleLLMInput,
  stripMarkdownFences,
  generateKnowledgeBase,
  extractBusinessInfoWithLLM,
  type ScrapedWebsite,
  type ScrapedPage,
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

// ── SCRUM-532: extract more, store less ─────────────────────────────────

function page(n: number, chars: number): ScrapedPage {
  return {
    url: `https://example.com/p${n}`,
    title: `Page ${n}`,
    content: `page-${n} `.padEnd(chars, "x").slice(0, chars),
  };
}

function scraped(businessInfo: ScrapedWebsite["businessInfo"], pages: ScrapedPage[] = []): ScrapedWebsite {
  return { baseUrl: "https://example.com", pages, businessInfo, scrapedAt: new Date(0), totalPages: pages.length };
}

describe("assembleLLMInput (SCRUM-532)", () => {
  it("includes WHOLE pages until the budget runs out, then stops — no page is bisected", () => {
    // Header per page: "--- Page N ---\n" (15) + content + "\n\n" (2) = chars + 17.
    const pages = [page(1, 400), page(2, 400), page(3, 400)];
    const { text, includedPages, droppedPages } = assembleLLMInput(pages, 900);
    expect(includedPages).toBe(2);
    expect(droppedPages).toBe(1);
    expect(text).toContain("--- Page 2 ---");
    expect(text).not.toContain("--- Page 3 ---");
    expect(text).not.toContain("page-3");
  });

  it("stops at the FIRST page that does not fit — crawl order is meaning, later smaller pages do not jump the queue", () => {
    const pages = [page(1, 400), page(2, 4000), page(3, 10)];
    const { includedPages, droppedPages } = assembleLLMInput(pages, 900);
    expect(includedPages).toBe(1);
    expect(droppedPages).toBe(2);
  });

  it("always includes the first page, sliced, when it alone exceeds the budget", () => {
    const { text, includedPages, droppedPages } = assembleLLMInput([page(1, 5000), page(2, 10)], 300);
    expect(includedPages).toBe(1);
    expect(droppedPages).toBe(1);
    expect(text.length).toBe(300);
    expect(text).toContain("page-1");
  });

  it("default budget fits every page of a typical crawl (20 pages x 10k)", () => {
    const pages = Array.from({ length: 11 }, (_, i) => page(i + 1, 10_000));
    const { includedPages, droppedPages } = assembleLLMInput(pages);
    expect(includedPages).toBe(11);
    expect(droppedPages).toBe(0);
  });
});

describe("cleanLLMFaqs (SCRUM-532)", () => {
  it("keeps valid pairs and preserves order", () => {
    expect(
      cleanLLMFaqs([
        { question: "Do you bulk bill?", answer: "Yes, for children under 16." },
        { question: "Parking?", answer: "Free behind the building." },
      ])
    ).toEqual([
      { question: "Do you bulk bill?", answer: "Yes, for children under 16." },
      { question: "Parking?", answer: "Free behind the building." },
    ]);
  });

  it("drops non-objects, half-pairs, empties and placeholders — never renders 'Q: undefined'", () => {
    expect(
      cleanLLMFaqs([
        "just a string",
        null,
        ["array"],
        { question: "Only a question?" },
        { question: "", answer: "empty question" },
        { question: "  ", answer: "whitespace question" },
        { question: "Real?", answer: "N/A" },
        { question: 42, answer: "non-string question" },
        { question: "Kept?", answer: "Yes." },
      ])
    ).toEqual([{ question: "Kept?", answer: "Yes." }]);
  });

  it("caps the count at 20 and clamps runaway lengths", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ question: `Q${i}?`, answer: "A." }));
    expect(cleanLLMFaqs(many)).toHaveLength(20);

    const long = cleanLLMFaqs([{ question: "q".repeat(400), answer: "a".repeat(2000) }])!;
    expect(long[0].question.length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect(long[0].question.endsWith("…")).toBe(true);
    expect(long[0].answer.length).toBeLessThanOrEqual(1201);
  });

  it("returns undefined for non-arrays and empty results", () => {
    expect(cleanLLMFaqs(undefined)).toBeUndefined();
    expect(cleanLLMFaqs("not an array")).toBeUndefined();
    expect(cleanLLMFaqs([])).toBeUndefined();
    expect(cleanLLMFaqs([null])).toBeUndefined();
  });
});

describe("generateKnowledgeBase (SCRUM-532) — structured mode stores no raw page text", () => {
  const richInfo: ScrapedWebsite["businessInfo"] = {
    name: "Bright Smiles Dental",
    phone: "02 8555 1234",
    hours: ["Monday: 9am-5pm"],
    services: ["Check-up & Clean"],
    about: "A family dental practice.",
    faqs: [{ question: "Do you bulk bill?", answer: "Yes, for children." }],
    summary: "Free parking behind the building. HICAPS available.",
  };

  it("emits ONLY structured sections — the raw dump is gone", () => {
    const kb = generateKnowledgeBase(scraped(richInfo, [page(1, 9000)]));
    expect(kb).toContain("## Business Information");
    expect(kb).toContain("- Business Name: Bright Smiles Dental");
    expect(kb).toContain("## Frequently Asked Questions");
    expect(kb).toContain("Q: Do you bulk bill?\nA: Yes, for children.");
    expect(kb).toContain("## More About the Business");
    expect(kb).toContain("Free parking behind the building.");
    expect(kb).not.toContain("## Website Content");
    expect(kb).not.toContain("page-1");
    // The whole point: compact enough that the 12k call budget holds plenty.
    expect(kb.length).toBeLessThan(3000);
  });

  it("renders FAQs in the exact Q/A vocabulary the voice server uses for owner FAQs", () => {
    const kb = generateKnowledgeBase(
      scraped({ faqs: [{ question: "Q1?", answer: "A1." }, { question: "Q2?", answer: "A2." }] })
    );
    expect(kb).toContain("Q: Q1?\nA: A1.\n\nQ: Q2?\nA: A2.");
  });

  it("omits the Business Information header when every field is absent", () => {
    const kb = generateKnowledgeBase(scraped({}, [page(1, 50)]));
    expect(kb).not.toContain("## Business Information");
  });

  it("structured is the DEFAULT mode", () => {
    const kb = generateKnowledgeBase(scraped({ name: "X" }, [page(1, 500)]));
    expect(kb).not.toContain("## Website Content");
  });
});

describe("generateKnowledgeBase (SCRUM-532) — raw-fallback mode", () => {
  it("keeps a raw excerpt when extraction failed, capped at 10k across pages", () => {
    const kb = generateKnowledgeBase(scraped({ name: "X" }, [page(1, 6000), page(2, 6000), page(3, 6000)]), {
      mode: "raw-fallback",
    });
    expect(kb).toContain("## Website Content");
    expect(kb).toContain("### Page 1");
    expect(kb).toContain("### Page 2");
    // Page 2's body is sliced to the remaining 4k; page 3 contributes nothing.
    expect(kb).not.toContain("page-3");
    const rawPortion = kb.slice(kb.indexOf("## Website Content"));
    expect(rawPortion.length).toBeLessThan(11_000);
  });

  it("never emits scraped FAQs or summary sections in fallback mode (there are none by definition)", () => {
    const kb = generateKnowledgeBase(scraped({ name: "X" }, [page(1, 100)]), { mode: "raw-fallback" });
    expect(kb).not.toContain("## Frequently Asked Questions");
    expect(kb).not.toContain("## More About the Business");
  });
});

describe("extractBusinessInfoWithLLM (SCRUM-532) — the null contract", () => {
  it("returns NULL (extraction failed) when the API key is absent — not an empty success", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await extractBusinessInfoWithLLM([page(1, 100)])).toBeNull();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("returns {} (a successful read of nothing) for an empty crawl, without calling the API", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      expect(await extractBusinessInfoWithLLM([])).toEqual({});
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
