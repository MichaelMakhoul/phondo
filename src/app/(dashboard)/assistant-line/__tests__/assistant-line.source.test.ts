import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { OWNER_ASSISTANT_TOKEN_URL } from "@/lib/owner-assistant/web";

// SCRUM-596: source pins for the owner assistant in the browser. The repo's vitest
// env (node, no DOM, JSX left as "preserve") can't run TSX components or the async
// server page, so the wiring is pinned against source, the same idiom as
// settings/__tests__/owner-line.source.test.ts. The token route that guards it is
// tested for real in api/v1/owner-assistant/token/__tests__/route.test.ts.

const DIR = join(process.cwd(), "src/app/(dashboard)/assistant-line");
const pageSource = readFileSync(join(DIR, "page.tsx"), "utf-8");
const panelSource = readFileSync(join(DIR, "owner-talk-panel.tsx"), "utf-8");
const cardSource = readFileSync(join(process.cwd(), "src/app/(dashboard)/settings/owner-line-card.tsx"), "utf-8");

describe("the token URL", () => {
  it("is the owner-assistant token route, which exists", () => {
    expect(OWNER_ASSISTANT_TOKEN_URL).toBe("/api/v1/owner-assistant/token");
    expect(existsSync(join(process.cwd(), "src/app/api/v1/owner-assistant/token/route.ts"))).toBe(true);
  });
});

describe("/assistant-line page (server)", () => {
  it("is dark until OWNER_ASSISTANT_UI_ENABLED, before any query", () => {
    const flag = pageSource.indexOf("if (!isOwnerAssistantUiEnabled()) notFound();");
    expect(flag).toBeGreaterThan(0);
    expect(flag).toBeLessThan(pageSource.indexOf("await createClient()"));
  });

  it("owner only: logged out → /login, no org → /onboarding, any other role → not found", () => {
    expect(pageSource).toMatch(/if \(!user\) redirect\("\/login"\);/);
    expect(pageSource).toMatch(/const membership = await getPrimaryMembership\(supabase, user\.id\);/);
    expect(pageSource).toMatch(/if \(!membership\) redirect\("\/onboarding"\);/);
    expect(pageSource).toMatch(/if \(membership\.role !== "owner"\) notFound\(\);/);
  });

  it("loads the org's first active assistant, scoped to the owner's org, and logs a failed read", () => {
    expect(pageSource).toMatch(/\.from\("assistants"\)\s*\.select\("id"\)\s*\.eq\("organization_id", membership\.organization_id\)\s*\.eq\("is_active", true\)\s*\.order\("created_at", \{ ascending: true \}\)\s*\.limit\(1\)\s*\.maybeSingle\(\)/);
    expect(pageSource).toMatch(/console\.error\("\[AssistantLine\] assistants read failed:"/);
    expect(pageSource).toMatch(/<OwnerTalkPanel assistantId=\{assistant\?\.id \?\? null\} loadFailed=\{Boolean\(error\)\} \/>/);
  });
});

describe("the talk panel (client)", () => {
  it("is a client component using the voice-test hook with the owner token URL and its own analytics source", () => {
    expect(panelSource.startsWith('"use client";')).toBe(true);
    expect(panelSource).toMatch(/useVoiceTest\(\{ assistantId, tokenUrl: OWNER_ASSISTANT_TOKEN_URL, trackingSource: "owner_assistant" \}\)/);
    expect(panelSource).toMatch(/from "@\/lib\/owner-assistant\/web"/);
  });

  it("calls the hook only once it has an assistant (hooks can't be conditional)", () => {
    const outer = panelSource.slice(panelSource.indexOf("export function OwnerTalkPanel"), panelSource.indexOf("function OwnerTalk("));
    expect(outer).not.toContain("useVoiceTest(");
    expect(outer).toMatch(/if \(loadFailed\)/);
    expect(outer).toMatch(/if \(!assistantId\)/);
    expect(outer).toMatch(/href="\/assistants"/);
  });

  it("shows every state: idle, connecting, active (mute + end), ended (talk again), the transcript and errors", () => {
    for (const s of ['status === "idle"', 'status === "connecting"', 'status === "active"', 'status === "ended"']) {
      expect(panelSource).toContain(s);
    }
    expect(panelSource).toMatch(/onClick=\{toggleMute\}/);
    expect(panelSource).toMatch(/onClick=\{stop\}/);
    expect(panelSource).toMatch(/onClick=\{handleTalkAgain\}/);
    expect(panelSource).toMatch(/transcript\.map\(/);
    expect(panelSource).toMatch(/<AlertDescription>\{error\}<\/AlertDescription>/);
    expect(panelSource).toMatch(/aria-label=\{isMuted \? "Unmute microphone" : "Mute microphone"\}/);
  });

  it("says plainly that changes are real, customers aren't told, and how long a session lasts", () => {
    expect(panelSource).toMatch(/reads every change back and waits for your yes/);
    expect(panelSource).toMatch(/Customers aren&apos;t told automatically/);
    expect(panelSource).toMatch(/Each session lasts up to 10 minutes\./);
  });

  it("an org with no active assistant is told to set one up or switch it back on", () => {
    expect(panelSource).toMatch(/Your assistant needs an active AI receptionist/);
    expect(panelSource).toMatch(/Set one up, or switch yours back on, in Assistants\./);
  });
});

describe("Settings → Your assistant line", () => {
  it("links to the browser version", () => {
    expect(cardSource).toMatch(/<Link href="\/assistant-line">/);
    expect(cardSource).toMatch(/Talk to it in your browser/);
  });
});
