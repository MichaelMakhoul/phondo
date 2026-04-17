#!/usr/bin/env node
/**
 * Accessibility scan using axe-core across all authenticated pages in both
 * light and dark mode. Outputs violations grouped by page + theme.
 *
 * Usage:
 *   A11Y_EMAIL=you@example.com A11Y_PASSWORD=... node scripts/a11y-scan.mjs
 *
 * Exit codes:
 *   0 — scan completed, 0 violations
 *   1 — scan completed but found violations OR any page errored
 *   2 — fatal setup/login error
 */

import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { writeFileSync, mkdirSync } from "fs";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const EMAIL = process.env.A11Y_EMAIL;
const PASSWORD = process.env.A11Y_PASSWORD;
const OUT_DIR = "mobile-audit-screenshots/a11y";
const VERBOSE = process.env.VERBOSE === "1";

if (!EMAIL || !PASSWORD) {
  console.error(
    "ERROR: A11Y_EMAIL and A11Y_PASSWORD env vars are required.\n" +
      "Use a throwaway test account — never commit real credentials.",
  );
  process.exit(2);
}

const PAGES = [
  { path: "/dashboard", name: "dashboard" },
  { path: "/assistants", name: "assistants" },
  { path: "/phone-numbers", name: "phone-numbers" },
  { path: "/calls", name: "calls" },
  { path: "/callbacks", name: "callbacks" },
  { path: "/calendar", name: "calendar" },
  { path: "/appointments", name: "appointments" },
  { path: "/analytics", name: "analytics" },
  { path: "/settings", name: "settings-general" },
  { path: "/settings/notifications", name: "settings-notifications" },
  { path: "/settings/scheduling", name: "settings-scheduling" },
  { path: "/settings/profile", name: "settings-profile" },
  { path: "/settings/knowledge", name: "settings-knowledge" },
  { path: "/billing", name: "billing" },
];

async function login(page) {
  await page.goto(`${BASE}/login`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Dismiss cookie banner so it doesn't intercept the submit click
  const accept = page.getByRole("button", { name: /^Accept$/ });
  try {
    if (await accept.isVisible()) {
      await accept.click();
      await page.waitForTimeout(500);
    }
  } catch (err) {
    console.warn(
      "[login] Could not check cookie banner visibility:",
      err.message,
    );
  }

  await page.locator("#email").click();
  await page.locator("#email").fill(EMAIL);
  await page.locator("#password").click();
  await page.locator("#password").fill(PASSWORD);
  // Blur to ensure React state is committed
  await page.locator("body").click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(300);

  await page.locator("button[type='submit']").click();
  await page.waitForURL(/\/dashboard/, { timeout: 60000 });
  console.log("✓ Logged in");
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    const html = document.documentElement;
    html.classList.remove("dark", "light");
    html.classList.add(t);
    try {
      localStorage.setItem("theme", t);
    } catch (err) {
      console.warn("[setTheme] localStorage unavailable:", err?.message);
    }
  }, theme);
}

async function scanPage(page, url, theme) {
  // 60s timeout handles Next.js dev-mode lazy recompile on first page hit
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await setTheme(page, theme);
  // Wait for client components + Supabase queries to settle
  await page.waitForTimeout(3500);

  // Remove Next.js dev-tools overlay that would add false a11y violations
  await page.evaluate(() => {
    document
      .querySelectorAll("[id*='devtools'], [id*='nextjs-toast'], nextjs-portal")
      .forEach((el) => el.remove());
  });

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  return {
    url,
    theme,
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      samples: v.nodes.slice(0, 3).map((n) => ({
        target: n.target.join(" "),
        html: (n.html || "").slice(0, 160),
        failureSummary: (n.failureSummary || "").slice(0, 300),
      })),
    })),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    page.on("pageerror", (err) => console.error("[page error]", err.message));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Always surface auth failures; surface everything else in verbose mode
      if (
        VERBOSE ||
        text.includes("Login failed") ||
        text.includes("Invalid") ||
        text.includes("supabase")
      ) {
        console.error("[console error]", text.slice(0, 300));
      }
    });

    await login(page);

    const allResults = [];
    let errorCount = 0;
    for (const { path, name } of PAGES) {
      for (const theme of ["light", "dark"]) {
        process.stdout.write(`Scanning ${name} (${theme})... `);
        try {
          const r = await scanPage(page, path, theme);
          allResults.push({ page: name, ...r });
          console.log(`${r.violations.length} violations`);
        } catch (e) {
          errorCount++;
          console.log(`ERROR: ${e.message}`);
          if (VERBOSE && e.stack) console.error(e.stack);
          allResults.push({
            page: name,
            url: path,
            theme,
            error: e.message,
            stack: e.stack,
          });
        }
      }
    }

    writeFileSync(
      `${OUT_DIR}/violations.json`,
      JSON.stringify(allResults, null, 2),
    );

    // Summary by impact + rule
    const summary = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const byRule = {};
    let totalViolations = 0;
    for (const r of allResults) {
      if (!r.violations) continue;
      for (const v of r.violations) {
        summary[v.impact] = (summary[v.impact] || 0) + v.nodeCount;
        byRule[v.id] = (byRule[v.id] || 0) + v.nodeCount;
        totalViolations += v.nodeCount;
      }
    }

    console.log("\n=== SUMMARY (violation nodes by impact) ===");
    console.log(JSON.stringify(summary, null, 2));
    console.log("\n=== BY RULE ===");
    console.log(JSON.stringify(byRule, null, 2));
    if (errorCount > 0) {
      console.log(`\n⚠️  ${errorCount} page scans errored — see violations.json`);
    }
    console.log(`\nFull results: ${OUT_DIR}/violations.json`);

    // Non-zero exit if anything failed or any violation was found, so CI blocks
    if (errorCount > 0 || totalViolations > 0) process.exit(1);
  } finally {
    await browser.close().catch((err) =>
      console.warn("[main] browser.close() failed:", err?.message),
    );
  }
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(2);
});
