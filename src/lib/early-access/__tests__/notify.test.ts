import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const resendState = vi.hoisted(() => ({
  result: { error: null as unknown },
  lastSend: null as Record<string, unknown> | null,
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: Record<string, unknown>) => {
        resendState.lastSend = payload;
        return resendState.result;
      },
    };
  },
}));

import { sendEarlyAccessNotification, EarlyAccessNotifyError } from "../notify";
import type { EarlyAccessData } from "../validate";

const data: EarlyAccessData = {
  full_name: "Jane",
  business_name: "Acme",
  email: "jane@x.io",
  phone: null,
  message: "<script>alert(1)</script>",
};

beforeEach(() => {
  resendState.result = { error: null };
  resendState.lastSend = null;
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("sendEarlyAccessNotification", () => {
  it("no-ops (no throw, no send) when EMAIL_API_KEY is unset — lead already saved", async () => {
    vi.stubEnv("EMAIL_API_KEY", "");
    vi.stubEnv("EARLY_ACCESS_NOTIFY_EMAIL", "founder@x.io");
    await expect(sendEarlyAccessNotification(data)).resolves.toBeUndefined();
    expect(resendState.lastSend).toBeNull();
  });

  it("no-ops when neither EARLY_ACCESS_NOTIFY_EMAIL nor ADMIN_ALERT_EMAIL is set", async () => {
    vi.stubEnv("EMAIL_API_KEY", "re_x");
    vi.stubEnv("EARLY_ACCESS_NOTIFY_EMAIL", "");
    vi.stubEnv("ADMIN_ALERT_EMAIL", "");
    await expect(sendEarlyAccessNotification(data)).resolves.toBeUndefined();
    expect(resendState.lastSend).toBeNull();
  });

  it("falls back to ADMIN_ALERT_EMAIL when EARLY_ACCESS_NOTIFY_EMAIL is unset", async () => {
    vi.stubEnv("EMAIL_API_KEY", "re_x");
    vi.stubEnv("EARLY_ACCESS_NOTIFY_EMAIL", "");
    vi.stubEnv("ADMIN_ALERT_EMAIL", "admin@x.io");
    await sendEarlyAccessNotification(data);
    expect(resendState.lastSend?.to).toEqual(["admin@x.io"]);
  });

  it("throws EarlyAccessNotifyError when Resend returns an error (so the route logs it)", async () => {
    vi.stubEnv("EMAIL_API_KEY", "re_x");
    vi.stubEnv("EARLY_ACCESS_NOTIFY_EMAIL", "founder@x.io");
    resendState.result = { error: { message: "rate limited" } };
    await expect(sendEarlyAccessNotification(data)).rejects.toBeInstanceOf(EarlyAccessNotifyError);
  });

  it("escapes prospect-controlled HTML and replies straight to the prospect", async () => {
    vi.stubEnv("EMAIL_API_KEY", "re_x");
    vi.stubEnv("EARLY_ACCESS_NOTIFY_EMAIL", "founder@x.io");
    await sendEarlyAccessNotification(data);
    const send = resendState.lastSend!;
    expect(send.html).not.toContain("<script>");
    expect(send.html).toContain("&lt;script&gt;");
    expect(send.replyTo).toBe("jane@x.io");
  });
});
