import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// SCRUM-420 (audit findings #26/#61): layouts don't re-run on soft navigation,
// so the (admin) layout's isPlatformAdmin check alone can't protect sibling
// segments after admin is revoked. Every admin page must gate itself.

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    // Real redirect() throws — emulate so code after it never runs.
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/admin/admin-auth", () => ({ isPlatformAdmin: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/admin/admin-auth";
import { requirePlatformAdmin } from "@/lib/admin/require-admin";

function authClient(user: { id: string } | null) {
  return { auth: { getUser: async () => ({ data: { user } }) } };
}

describe("requirePlatformAdmin (SCRUM-420)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects to /login when there is no session", async () => {
    vi.mocked(createClient).mockResolvedValue(authClient(null) as never);

    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/login");
    expect(isPlatformAdmin).not.toHaveBeenCalled();
  });

  it("redirects to / when the user is not (or no longer) a platform admin", async () => {
    vi.mocked(createClient).mockResolvedValue(authClient({ id: "user-1" }) as never);
    vi.mocked(isPlatformAdmin).mockResolvedValue(false);

    await expect(requirePlatformAdmin()).rejects.toThrow("REDIRECT:/");
    expect(isPlatformAdmin).toHaveBeenCalledWith("user-1");
  });

  it("returns the verified userId for an admin", async () => {
    vi.mocked(createClient).mockResolvedValue(authClient({ id: "admin-1" }) as never);
    vi.mocked(isPlatformAdmin).mockResolvedValue(true);

    await expect(requirePlatformAdmin()).resolves.toEqual({ userId: "admin-1" });
  });
});

describe("every admin RSC page is individually gated (SCRUM-420 regression guard)", () => {
  const adminDir = path.join(process.cwd(), "src/app/(admin)");

  function collectPages(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectPages(full));
      else if (entry.name === "page.tsx") out.push(full);
    }
    return out;
  }

  /** Source with comment lines removed, so a commented-out gate can't pass. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  it("every (admin) page.tsx awaits requirePlatformAdmin() BEFORE any service-role query", () => {
    const pages = collectPages(adminDir);
    // 11 at the time of SCRUM-420 — if this shrinks unexpectedly, pages moved
    // out of the gated group; if a new page is added without the gate, the
    // per-file assertion below catches it.
    expect(pages.length).toBeGreaterThanOrEqual(11);

    for (const page of pages) {
      const rel = path.relative(process.cwd(), page);
      const src = stripComments(fs.readFileSync(page, "utf8"));

      const gateIdx = src.indexOf("await requirePlatformAdmin()");
      expect(
        gateIdx,
        `${rel} is missing the per-page admin gate ` +
          "(await requirePlatformAdmin() as the first statement — see SCRUM-420)",
      ).toBeGreaterThanOrEqual(0);

      // The security invariant is ORDER, not presence: the gate must run
      // before the service-role (RLS-bypassing) client is even constructed.
      const queryIdx = src.indexOf("createAdminClient(");
      if (queryIdx !== -1) {
        expect(
          gateIdx < queryIdx,
          `${rel}: requirePlatformAdmin() must come BEFORE createAdminClient() — ` +
            "a revoked admin must never reach a cross-tenant query (SCRUM-420)",
        ).toBe(true);
      }
    }
  });

  it("no ungated server entry points exist under (admin) besides page/layout", () => {
    // Pages are gated above and layout.tsx has its own check. Anything else
    // that can run server code with tenant access — route handlers, server
    // actions — would bypass the per-page gate entirely. None exist today;
    // if you add one, gate it with requirePlatformAdmin() and extend this test.
    function collectAll(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectAll(full));
        else out.push(full);
      }
      return out;
    }

    const offenders = collectAll(adminDir).filter((f) => {
      const name = path.basename(f);
      if (name === "route.ts" || name === "route.tsx" || name === "actions.ts") return true;
      if (!/\.(ts|tsx)$/.test(name) || name === "page.tsx" || name === "layout.tsx") return false;
      const src = stripComments(fs.readFileSync(f, "utf8"));
      return src.includes('"use server"') || src.includes("'use server'");
    });

    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      "New server entry point under (admin) — add requirePlatformAdmin() and update this guard (SCRUM-420)",
    ).toEqual([]);
  });
});
