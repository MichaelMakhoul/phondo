import { describe, it, expect } from "vitest";
import { safeRedirectPath } from "../safe-redirect";

// SCRUM-346 (audit M5): open-redirect protection for post-auth redirect targets.
// A safe value must be a same-origin absolute path; everything else falls back.

describe("safeRedirectPath", () => {
  describe("rejects open-redirect payloads (the M5 acceptance cases)", () => {
    const attacks = [
      "@evil.com", // -> https://app.phondo.ai@evil.com (host=evil.com)
      ".evil.com", // -> https://app.phondo.ai.evil.com
      "//evil.com", // scheme-relative
      "/\\evil.com", // backslash normalised to //
      "https://evil.com", // absolute external
      "http://evil.com",
      "https:evil.com",
      "javascript:alert(1)",
      "\\\\evil.com",
      "evil.com",
      "  //evil.com", // leading space then scheme-relative
    ];
    for (const payload of attacks) {
      it(`falls back for ${JSON.stringify(payload)}`, () => {
        expect(safeRedirectPath(payload)).toBe("/dashboard");
      });
    }

    it("falls back when `..` normalisation collapses to a scheme-relative path (bypass regression)", () => {
      // These pass the raw startsWith("//") guard (they start with "/.") but
      // new URL() resolves the `..` into a leading "//host" that router.push()
      // would send external — the final-value re-check must catch them.
      expect(safeRedirectPath("/..//evil.com")).toBe("/dashboard");
      expect(safeRedirectPath("/../..//evil.com")).toBe("/dashboard");
      expect(safeRedirectPath("/a/..//evil.com")).toBe("/dashboard");
      expect(safeRedirectPath("/..///evil.com")).toBe("/dashboard");
      expect(safeRedirectPath("/..//@evil.com")).toBe("/dashboard");
      expect(safeRedirectPath("/foo/../..//evil.com")).toBe("/dashboard");
    });

    it("falls back for a path with an embedded CR/LF (header smuggling)", () => {
      expect(safeRedirectPath("/dashboard\r\nSet-Cookie: x=1")).toBe("/dashboard");
      expect(safeRedirectPath("/dashboard\nfoo")).toBe("/dashboard");
      expect(safeRedirectPath("/dashboard\tfoo")).toBe("/dashboard");
    });

    it("falls back for null/undefined/empty/non-string", () => {
      expect(safeRedirectPath(null)).toBe("/dashboard");
      expect(safeRedirectPath(undefined)).toBe("/dashboard");
      expect(safeRedirectPath("")).toBe("/dashboard");
      // @ts-expect-error — defensive: callers may pass non-strings
      expect(safeRedirectPath(123)).toBe("/dashboard");
    });
  });

  describe("allows legitimate internal paths", () => {
    it("passes a simple path", () => {
      expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
      expect(safeRedirectPath("/settings")).toBe("/settings");
    });
    it("preserves query string and hash", () => {
      expect(safeRedirectPath("/settings?tab=team")).toBe("/settings?tab=team");
      expect(safeRedirectPath("/dashboard#section")).toBe("/dashboard#section");
      expect(safeRedirectPath("/settings?tab=team#x")).toBe("/settings?tab=team#x");
    });
    it("normalises traversal within the same origin", () => {
      // new URL resolution collapses ../ — result is still a same-origin path.
      expect(safeRedirectPath("/a/../settings")).toBe("/settings");
    });
    it("encoded slashes stay on a single path segment (not external)", () => {
      expect(safeRedirectPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com");
    });
  });

  describe("custom fallback", () => {
    it("returns the provided fallback when invalid", () => {
      expect(safeRedirectPath("https://evil.com", "/login")).toBe("/login");
    });
    it("ignores the fallback when the path is valid", () => {
      expect(safeRedirectPath("/dashboard", "/login")).toBe("/dashboard");
    });
  });
});
