import { describe, it, expect, vi } from "vitest";
import { mergeIntegrationSettings } from "../cliniko-settings";

describe("mergeIntegrationSettings", () => {
  it("calls the merge RPC with the integration id and patch", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    const admin = { rpc };
    const res = await mergeIntegrationSettings(admin, "int-1", { lastReconciledAt: "2026-07-02T12:00:00Z" });
    expect(rpc).toHaveBeenCalledWith("merge_calendar_integration_settings", {
      p_id: "int-1",
      p_patch: { lastReconciledAt: "2026-07-02T12:00:00Z" },
    });
    expect(res.error).toBeNull();
  });

  it("surfaces the RPC error to the caller", async () => {
    const rpc = vi.fn(async () => ({ error: { message: "boom", code: "XX000" } }));
    const res = await mergeIntegrationSettings({ rpc }, "int-1", { errorState: "auth_failed" });
    expect(res.error).toMatchObject({ message: "boom" });
  });
});
