import { describe, it, expect } from "vitest";
import { namesMatch, phoneticSkeleton, levenshtein } from "@/lib/calendar/name-match";

// SCRUM-505: the name confirmation must tolerate the STT/spelling drift that
// broke a real lookup (spoken "Makhoul" heard as "Macool"), while NOT being so
// loose that unrelated names confirm each other. The phone possession check is
// the strong factor; this is the secondary "whose booking is this" confirm.

describe("phoneticSkeleton", () => {
  it("lowercases, strips accents and punctuation", () => {
    expect(phoneticSkeleton("O'Brien")).toBe(phoneticSkeleton("obrien"));
    expect(phoneticSkeleton("José")).toBe("jose");
    expect(phoneticSkeleton("  Anne-Marie  ")).toBe(phoneticSkeleton("annemarie"));
  });

  it("folds hard 'ch', 'kh', 'ck' and soft 'c'", () => {
    expect(phoneticSkeleton("Michael")).toBe("mikael");
    expect(phoneticSkeleton("Makhoul")).toBe("makoul");
    expect(phoneticSkeleton("Nick")).toBe("nik");
    expect(phoneticSkeleton("Cecilia")).toBe(phoneticSkeleton("Sesilia"));
  });

  it("collapses doubled letters", () => {
    expect(phoneticSkeleton("Aaron")).toBe("aron");
    expect(phoneticSkeleton("Emmett")).toBe(phoneticSkeleton("Emet"));
  });

  it("joins spelled-out letter runs (caller spells their name)", () => {
    expect(phoneticSkeleton("M A K H O U L")).toBe("makoul");
    expect(phoneticSkeleton("M-A-K-H-O-U-L")).toBe("makoul");
    expect(phoneticSkeleton("Michael M A K H O U L")).toBe("mikael makoul");
    // A lone middle initial is NOT a spelled run (needs 3+ letters).
    expect(phoneticSkeleton("John A Smith")).toBe("john a smit");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("makoul", "makoul")).toBe(0);
    expect(levenshtein("makol", "makoul")).toBe(1);
    expect(levenshtein("smit", "smyt")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("namesMatch — confirms STT near-misses", () => {
  const matches: Array<[string, string, string]> = [
    ["exact", "Jane Smith", "Jane Smith"],
    ["case-insensitive", "jane smith", "Jane SMITH"],
    ["surname only vs full name", "Makhoul", "Michael Makhoul"],
    ["first name only vs full name", "Michael", "Michael Makhoul"],
    ["the real STT miss (Macool→Makhoul)", "Macool", "Makhoul"],
    ["Machool→Makhoul", "Machool", "Makhoul"],
    ["Makoul→Makhoul", "Makoul", "Makhoul"],
    ["spelled-out surname vs full", "Makhoul", "Michael MAKHOUL"],
    ["caller spells the surname aloud", "M A K H O U L", "Michael Makhoul"],
    ["first name + spelled surname", "Michael M A K H O U L", "Michael MAKHOUL"],
    ["extra middle name the booking lacks", "Michael Xavier Makhoul", "Michael Makhoul"],
    ["Catherine↔Katherine", "Catherine", "Katherine"],
    ["Steven↔Stephen (≥5-char fuzzy)", "Steven", "Stephen"],
    ["accent drift", "Zoe", "Zoë"],
  ];
  for (const [label, spoken, stored] of matches) {
    it(`matches: ${label}`, () => {
      expect(namesMatch(spoken, stored)).toBe(true);
    });
  }
});

describe("namesMatch — rejects distinct names (no over-matching)", () => {
  const nonMatches: Array<[string, string | null, string]> = [
    ["different surname", "Makhoul", "Johnson"],
    ["surname vs unrelated first name", "Makhoul", "Michael"],
    ["Smith vs Jones", "Smith", "Jones"],
    ["far mis-hearing needs a spell-out", "McCool", "Makhoul"],
    ["different people, same initial", "Sophia Davis", "Liam Walker"],
    // Security (SCRUM-505 review): don't confirm distinct people who share one
    // token on a shared phone line, and never confirm on a bare initial.
    ["shared surname, distinct people", "Jane Smith", "John Smith"],
    ["shared first name, distinct people", "John Smith", "John Baker"],
    ["distinct short names, exact required", "Ben", "Ken Smith"],
    ["single initial never confirms", "A", "Michael Makhoul"],
    ["short first-name drift needs exact (Jon≠John here)", "Jon", "John Baker"],
    ["spelling a wrong surname still doesn't confirm", "J O N E S", "Makhoul"],
    ["empty spoken", "", "Jane Smith"],
    ["empty stored", "Jane Smith", ""],
    ["null-ish", null, "Jane Smith"],
  ];
  for (const [label, spoken, stored] of nonMatches) {
    it(`rejects: ${label}`, () => {
      expect(namesMatch(spoken, stored)).toBe(false);
    });
  }
});
