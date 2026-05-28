import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SCRUM-338: SSRF hardening. The synchronous blocklist (isUrlAllowed) and the
// DNS-resolving check (isUrlAllowedAsync) must block private/reserved/metadata
// targets, and ssrfSafeFetch must re-validate every redirect hop.

// dns/promises is mocked so we can simulate DNS-rebinding (public name → private IP).
vi.mock("dns/promises", () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import dns from "dns/promises";
import { isUrlAllowed, isUrlAllowedAsync, ssrfSafeFetch, SsrfBlockedError } from "../validation";

const mockResolve4 = dns.resolve4 as unknown as ReturnType<typeof vi.fn>;
const mockResolve6 = dns.resolve6 as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockResolve4.mockReset();
  mockResolve6.mockReset();
  mockResolve4.mockResolvedValue([]);
  mockResolve6.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isUrlAllowed (synchronous literal-IP/hostname blocklist)", () => {
  it.each([
    ["http://169.254.169.254/latest/meta-data/", false], // AWS metadata
    ["http://127.0.0.1/", false],
    ["http://10.0.0.5/", false],
    ["http://172.16.0.1/", false],
    ["http://192.168.1.1/", false],
    ["http://0.0.0.0/", false],
    ["http://localhost/", false],
    ["http://[::1]/", false],
    ["http://[fdaa:0:1::3]/", false], // Fly.io 6PN (fc00::/7)
    ["http://foo.internal/", false],
    ["http://[::ffff:127.0.0.1]/", false], // IPv4-mapped IPv6, dotted
    ["http://[::ffff:a9fe:a9fe]/", false], // IPv4-mapped IPv6, hex = 169.254.169.254
    ["http://metadata.google.internal./", false], // trailing-dot FQDN bypass
    ["http://foo.internal./", false], // trailing-dot + .internal
    ["http://2130706433/", false], // decimal IPv4 = 127.0.0.1 (Node normalises)
    ["http://0x7f000001/", false], // hex IPv4 = 127.0.0.1
    ["ftp://example.com/", false], // non-http(s) scheme
    ["https://example.com/webhook", true],
    ["https://hooks.zapier.com/abc", true],
    ["http://example.com./", true], // trailing dot on a PUBLIC name still allowed
  ])("%s -> %s", (url, expected) => {
    expect(isUrlAllowed(url)).toBe(expected);
  });
});

describe("isUrlAllowedAsync (DNS-resolving — catches rebinding)", () => {
  it("blocks a public hostname that resolves to a private IP (rebinding)", async () => {
    mockResolve4.mockResolvedValue(["10.1.2.3"]);
    expect(await isUrlAllowedAsync("https://rebind.attacker.com/")).toBe(false);
  });

  it("blocks a public hostname resolving to the metadata IP", async () => {
    mockResolve4.mockResolvedValue(["169.254.169.254"]);
    expect(await isUrlAllowedAsync("https://evil.example.com/")).toBe(false);
  });

  it("blocks a hostname resolving to a Fly 6PN IPv6 address", async () => {
    mockResolve6.mockResolvedValue(["fdaa:0:1:a7b:..."]);
    expect(await isUrlAllowedAsync("https://evil6.example.com/")).toBe(false);
  });

  it("blocks when DNS resolution returns nothing (fail closed)", async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    expect(await isUrlAllowedAsync("https://nxdomain.example.com/")).toBe(false);
  });

  it("allows a public hostname resolving to a public IP", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    expect(await isUrlAllowedAsync("https://example.com/webhook")).toBe(true);
  });
});

describe("ssrfSafeFetch (manual redirect re-validation)", () => {
  it("throws SsrfBlockedError before connecting to a private target", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(ssrfSafeFetch("http://169.254.169.254/")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled(); // blocked pre-flight, never fetched
  });

  it("blocks a redirect that points at an internal address", async () => {
    mockResolve4.mockImplementation(async (host: string) =>
      host === "good.example.com" ? ["93.184.216.34"] : ["169.254.169.254"]
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
    );
    await expect(ssrfSafeFetch("https://good.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
    fetchSpy.mockRestore();
  });

  it("returns the response for an allowed URL with no redirect", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 })
    );
    const res = await ssrfSafeFetch("https://good.example.com/");
    expect(res.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("throws SsrfBlockedError on a malformed redirect Location", async () => {
    mockResolve4.mockResolvedValue(["93.184.216.34"]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://" } })
    );
    await expect(ssrfSafeFetch("https://good.example.com/")).rejects.toBeInstanceOf(SsrfBlockedError);
    fetchSpy.mockRestore();
  });
});
