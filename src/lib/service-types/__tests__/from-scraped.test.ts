import { describe, it, expect } from "vitest";
import { serviceTypesFromScraped } from "../from-scraped";
import { getServiceDefaults } from "../defaults";

// SCRUM-515. These become the "what can I book?" list the caller hears. Seeding
// them from a generic industry table is why a Toyota dealership offered a
// "standard consultation" and claimed to know nothing about car servicing.

describe("serviceTypesFromScraped", () => {
  it("keeps the services a dealership actually advertises, in order", () => {
    const result = serviceTypesFromScraped([
      "Logbook servicing",
      "New car sales",
      "Genuine parts",
    ]);

    expect(result).toEqual([
      { name: "Logbook servicing", duration_minutes: 30 },
      { name: "New car sales", duration_minutes: 30 },
      { name: "Genuine parts", duration_minutes: 30 },
    ]);
  });

  it("does not invent durations", () => {
    // Nothing on a web page says how long a logbook service takes. A fabricated
    // 90 minutes would quietly mis-shape the diary; the owner sets it in
    // Settings, where the number is visible.
    const result = serviceTypesFromScraped(["Major service", "Quick wash"]);
    expect(result.every((s) => s.duration_minutes === 30)).toBe(true);
    expect(result.every((s) => s.description === undefined)).toBe(true);
  });

  it("adopts a duration it already knows, rather than defaulting to 30", () => {
    // A root canal takes 90 minutes. The dental table already says so, and
    // packing it into a 30 minute slot double-books the chair. Borrowing a
    // known duration is knowledge; guessing one is not.
    const known = getServiceDefaults("dental");
    const result = serviceTypesFromScraped(["Root Canal", "Teeth Whitening"], known);

    expect(result[0]).toMatchObject({ name: "Root Canal", duration_minutes: 90 });
    // The description we already wrote for it comes along.
    expect(result[0].description).toBe("Root canal treatment");
    // Not in the table, so it stays neutral rather than inheriting a neighbour's.
    expect(result[1]).toMatchObject({ name: "Teeth Whitening", duration_minutes: 30 });
    expect(result[1].description).toBeUndefined();
  });

  it("rejects a short sentence, not just a long one", () => {
    // The only prose fixture is 14 words, so the word-count rule catches it and
    // the sentence rule never has to fire. This one is four words.
    expect(serviceTypesFromScraped(["We fix taps. Fast."])).toEqual([]);
  });

  it("rejects a nine-word marketing blurb", () => {
    // The limit is eight. Without a fixture near the boundary it could drift
    // to thirteen unnoticed, and blurbs would become bookable services.
    expect(serviceTypesFromScraped(["Same day hot water system repairs across all of Sydney"])).toEqual([]);
    expect(serviceTypesFromScraped(["Same day hot water system repairs"])).toHaveLength(1);
  });

  it("dedupes before it caps, so 40 duplicates yield one service", () => {
    expect(serviceTypesFromScraped(Array.from({ length: 40 }, () => "Car Servicing"))).toHaveLength(1);
  });

  it("matches a known service through case, punctuation, and '&' spelled out", () => {
    const known = getServiceDefaults("dental");
    const result = serviceTypesFromScraped(["check-up and clean"], known);
    // Matched "Check-up & Clean" (45 min) but the business's own wording stands.
    expect(result[0].name).toBe("check-up and clean");
    expect(result[0].duration_minutes).toBe(45);
  });

  it("treats '&' and 'and' as the same service when deduping", () => {
    const result = serviceTypesFromScraped(["Cut & Colour", "Cut and Colour"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Cut & Colour");
  });

  it("does not borrow durations across industries", () => {
    // "Emergency" is 30 min for a dentist. A plumber passing its own list must
    // not silently inherit dental timings.
    const result = serviceTypesFromScraped(["Emergency"], getServiceDefaults("home_services"));
    expect(result[0].duration_minutes).toBe(30);
  });

  it("dedupes case- and punctuation-insensitively, keeping the first spelling", () => {
    const result = serviceTypesFromScraped(["Car Servicing", "car servicing", "Car-Servicing!"]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Car Servicing");
  });

  it("strips bullets and stray punctuation the scraper carried over", () => {
    const result = serviceTypesFromScraped(["• Logbook servicing", "- New car sales -", "  Parts:  "]);
    expect(result.map((s) => s.name)).toEqual(["Logbook servicing", "New car sales", "Parts"]);
  });

  it("rejects prose the LLM failed to compress into a name", () => {
    const result = serviceTypesFromScraped([
      "Servicing",
      "We service all makes and models. Book online today for a free quote.",
      "Our team of qualified technicians will look after your vehicle from start to finish",
    ]);
    expect(result.map((s) => s.name)).toEqual(["Servicing"]);
  });

  it("rejects entries with no letters", () => {
    expect(serviceTypesFromScraped(["2024", "•", "—", "   ", "!!!"])).toEqual([]);
  });

  it("caps the import so a scraped sitemap can't fill the org's 50-row budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Service ${i}`);
    expect(serviceTypesFromScraped(many)).toHaveLength(12);
  });

  it("rejects a name longer than the column allows", () => {
    const tooLong = "x".repeat(101);
    expect(serviceTypesFromScraped([tooLong])).toEqual([]);
  });

  it("returns an empty array for nothing usable, so the caller falls back", () => {
    // An org with NO service types cannot book at all. Empty must mean
    // "use the industry defaults", never "persist this".
    expect(serviceTypesFromScraped([])).toEqual([]);
    expect(serviceTypesFromScraped(undefined)).toEqual([]);
    expect(serviceTypesFromScraped(null)).toEqual([]);
    expect(serviceTypesFromScraped(["", "  ", "123"])).toEqual([]);
  });

  it("cannot throw on hostile input", () => {
    const nasty = [null, undefined, 42, {}, [], Symbol.iterator] as unknown as string[];
    expect(() => serviceTypesFromScraped(nasty)).not.toThrow();
    expect(serviceTypesFromScraped(nasty)).toEqual([]);
  });
});
