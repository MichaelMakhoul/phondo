import { describe, it, expect, vi } from "vitest";
import { runAfterResponse } from "@/lib/utils/after-response";

const flush = () => new Promise((r) => setTimeout(r, 0));

// In the test environment there is no request scope, so Next's after() throws —
// which exercises runAfterResponse's fallback (the test-safety path that keeps
// library callers like the tool handlers usable outside a request).
describe("runAfterResponse (SCRUM-410)", () => {
  it("runs the work and never throws when outside a request scope", async () => {
    const work = vi.fn(async () => {});
    expect(() => runAfterResponse(work)).not.toThrow();
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("never throws even when the work rejects", async () => {
    const work = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() => runAfterResponse(work)).not.toThrow();
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });
});
