import { describe, it, expect } from "vitest";
import { hasNonLatinLetters } from "../latin-name";

describe("hasNonLatinLetters (SCRUM-367)", () => {
  it("accepts plain Latin names", () => {
    expect(hasNonLatinLetters("John Smith")).toBe(false);
    expect(hasNonLatinLetters("Michael")).toBe(false);
  });

  it("accepts accented Latin (still Latin script)", () => {
    for (const n of ["José", "Müller", "Renée", "Łukasz", "Søren", "François", "Núñez"]) {
      expect(hasNonLatinLetters(n)).toBe(false);
    }
  });

  it("accepts hyphens, apostrophes, spaces, digits (non-letters)", () => {
    expect(hasNonLatinLetters("Jean-Pierre O'Brien")).toBe(false);
    expect(hasNonLatinLetters("Mary-Kate")).toBe(false);
    expect(hasNonLatinLetters("Unit 4B")).toBe(false);
  });

  it("rejects Arabic script", () => {
    expect(hasNonLatinLetters("محمد")).toBe(true);
    expect(hasNonLatinLetters("مخلوف")).toBe(true);
  });

  it("rejects mixed Latin + non-Latin (one part still in another script)", () => {
    expect(hasNonLatinLetters("John محمد")).toBe(true);
    expect(hasNonLatinLetters("李 Wang")).toBe(true);
  });

  it("rejects other non-Latin scripts", () => {
    expect(hasNonLatinLetters("Иван")).toBe(true); // Cyrillic
    expect(hasNonLatinLetters("田中")).toBe(true); // Han
    expect(hasNonLatinLetters("Ωμέγα")).toBe(true); // Greek
  });

  it("treats empty / null / undefined as Latin-clean (no false reject)", () => {
    expect(hasNonLatinLetters("")).toBe(false);
    expect(hasNonLatinLetters(null)).toBe(false);
    expect(hasNonLatinLetters(undefined)).toBe(false);
  });
});
