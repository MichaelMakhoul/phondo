import { describe, it, expect } from "vitest";
import { resolveRescheduleIdentity } from "../tool-handlers";

describe("resolveRescheduleIdentity (SCRUM-386)", () => {
  // ── Reuse the existing appointment's name (a reschedule moves a known booking) ──

  it("reuses the existing name when the caller supplies nothing", () => {
    expect(resolveRescheduleIdentity({}, "Michael Makhoul")).toEqual({
      first_name: "Michael",
      last_name: "Makhoul",
    });
  });

  it("IGNORES a partial first_name and reuses the existing name (the reported bug)", () => {
    // The model relayed a stray first_name from garbled speech with no last name.
    // Previously this stripped the known name and demanded a last name in a loop.
    expect(resolveRescheduleIdentity({ first_name: "McCool" }, "Michael Makhoul")).toEqual({
      first_name: "Michael",
      last_name: "Makhoul",
    });
  });

  it("IGNORES a partial last_name and reuses the existing name", () => {
    expect(resolveRescheduleIdentity({ last_name: "Smith" }, "Michael Makhoul")).toEqual({
      first_name: "Michael",
      last_name: "Makhoul",
    });
  });

  it("splits a multi-word existing name (first token first, rest last)", () => {
    expect(resolveRescheduleIdentity({}, "Mary Anne Van Der Berg")).toEqual({
      first_name: "Mary",
      last_name: "Anne Van Der Berg",
    });
  });

  it("passes a single-token existing name as `name` (nothing to split)", () => {
    expect(resolveRescheduleIdentity({}, "Cher")).toEqual({ name: "Cher" });
  });

  // ── A COMPLETE new name overrides (explicit rename) ──

  it("uses an explicit complete new name (both parts)", () => {
    expect(resolveRescheduleIdentity({ first_name: "Jane", last_name: "Doe" }, "Michael Makhoul")).toEqual({
      first_name: "Jane",
      last_name: "Doe",
    });
  });

  it("uses a full `name` arg over the existing name, split into parts", () => {
    expect(resolveRescheduleIdentity({ name: "Jane Doe" }, "Michael Makhoul")).toEqual({
      first_name: "Jane",
      last_name: "Doe",
    });
  });

  // ── Edges ──

  it("trims whitespace and ignores empty/whitespace parts", () => {
    expect(resolveRescheduleIdentity({ first_name: "  ", last_name: "  " }, "  Michael Makhoul  ")).toEqual({
      first_name: "Michael",
      last_name: "Makhoul",
    });
    expect(resolveRescheduleIdentity({ name: "  Jane   Doe  " }, null)).toEqual({
      first_name: "Jane",
      last_name: "Doe",
    });
  });

  it("returns {} when there is no name anywhere", () => {
    expect(resolveRescheduleIdentity({}, null)).toEqual({});
    expect(resolveRescheduleIdentity({}, "")).toEqual({});
    expect(resolveRescheduleIdentity({}, undefined)).toEqual({});
  });
});
