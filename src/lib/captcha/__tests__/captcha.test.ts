import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isCaptchaConfigured,
  isCaptchaFailedError,
  captchaFailedUserMessage,
  CAPTCHA_FAILED_MESSAGE,
  CAPTCHA_PENDING_MESSAGE,
  CAPTCHA_BLOCKED_MESSAGE,
  CAPTCHA_MISCONFIGURED_MESSAGE,
} from "@/lib/captcha";

// SCRUM-436

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isCaptchaConfigured", () => {
  it("is false when the site key is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", undefined);
    expect(isCaptchaConfigured()).toBe(false);
  });

  it("is false when the site key is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    expect(isCaptchaConfigured()).toBe(false);
  });

  it("is true when a site key is present", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAAAAADi2_test");
    expect(isCaptchaConfigured()).toBe(true);
  });
});

describe("isCaptchaFailedError", () => {
  it("matches the GoTrue error code", () => {
    expect(isCaptchaFailedError({ code: "captcha_failed", message: "x" })).toBe(true);
  });

  it("matches the known GoTrue message when no code is present", () => {
    expect(
      isCaptchaFailedError({ message: "captcha verification process failed" })
    ).toBe(true);
  });

  it("does not match unrelated errors that merely mention captcha", () => {
    expect(isCaptchaFailedError({ message: "captcha provider config updated" })).toBe(false);
  });

  it("does not match unrelated auth errors", () => {
    expect(isCaptchaFailedError({ message: "Invalid login credentials" })).toBe(false);
    expect(isCaptchaFailedError({ code: "user_already_exists", message: "" })).toBe(false);
    expect(isCaptchaFailedError(null)).toBe(false);
    expect(isCaptchaFailedError(undefined)).toBe(false);
  });
});

describe("captchaFailedUserMessage", () => {
  it("returns the blocked-script copy when the widget failed to load", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAAAAADi2_test");
    expect(captchaFailedUserMessage({ widgetLoadFailed: true })).toBe(
      CAPTCHA_BLOCKED_MESSAGE
    );
  });

  it("returns the generic failure copy when the widget loaded fine", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAAAAADi2_test");
    expect(captchaFailedUserMessage({ widgetLoadFailed: false })).toBe(
      CAPTCHA_FAILED_MESSAGE
    );
  });

  it("flags the toggle-before-deploy misconfiguration loudly and avoids 'reload' advice", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const msg = captchaFailedUserMessage({ widgetLoadFailed: false });
    expect(msg).toBe(CAPTCHA_MISCONFIGURED_MESSAGE);
    expect(msg).not.toMatch(/reload/i); // reloading cannot help — no widget exists
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("NEXT_PUBLIC_TURNSTILE_SITE_KEY")
    );
  });
});

describe("user-facing copy", () => {
  it("never mentions account existence (anti-enumeration on forgot-password)", () => {
    for (const msg of [
      CAPTCHA_FAILED_MESSAGE,
      CAPTCHA_PENDING_MESSAGE,
      CAPTCHA_BLOCKED_MESSAGE,
      CAPTCHA_MISCONFIGURED_MESSAGE,
    ]) {
      expect(msg).not.toMatch(/account|email address|registered/i);
    }
  });
});
