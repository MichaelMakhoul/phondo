import { describe, it, expect } from "vitest";
import { isOwnerCallMetadata, OWNER_CALL_TYPE } from "../owner-call";

describe("isOwnerCallMetadata (SCRUM-586)", () => {
  it("is true only for metadata whose call_type is exactly 'owner'", () => {
    expect(OWNER_CALL_TYPE).toBe("owner");
    expect(isOwnerCallMetadata({ call_type: "owner", owner_auth: "verified" })).toBe(true);
    for (const metadata of [null, undefined, "owner", {}, { call_type: "Owner" }, { call_type: "outbound" }, { call_type: true }]) {
      expect(isOwnerCallMetadata(metadata), JSON.stringify(metadata) ?? "undefined").toBe(false);
    }
  });
});
