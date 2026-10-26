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
// SCRUM-597: the session moved into the dashboard layout's OwnerAssistantProvider, so this
// page and the floating bubble share one, and the controls, transcript and error moved into
// components both render. Those pins read the files the code now lives in; the bubble's own
// wiring is pinned in src/components/owner-assistant/__tests__/owner-assistant.source.test.ts.
const OWNER_ASSISTANT_DIR = join(process.cwd(), "src/components/owner-assistant");
const providerSource = readFileSync(join(OWNER_ASSISTANT_DIR, "owner-assistant-provider.tsx"), "utf-8");
const sessionUiSource = readFileSync(join(OWNER_ASSISTANT_DIR, "owner-assistant-session-ui.tsx"), "utf-8");

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
  it("is a client component on the shared session, which uses the voice-test hook with the owner token URL and its own analytics source", () => {
    expect(panelSource.startsWith('"use client";')).toBe(true);
    expect(panelSource).toMatch(/const assistant = useOwnerAssistant\(\);/);
    expect(panelSource).not.toContain("useVoiceTest");
    expect(providerSource).toMatch(/useVoiceTest\(\{ assistantId: assistantId \?\? "", tokenUrl: OWNER_ASSISTANT_TOKEN_URL, trackingSource: "owner_assistant" \}\)/);
    expect(providerSource).toMatch(/from "@\/lib\/owner-assistant\/web"/);
  });

  it("calls the hook only once it has an assistant (hooks can't be conditional)", () => {
    const outer = panelSource.slice(panelSource.indexOf("export function OwnerTalkPanel"), panelSource.indexOf("function OwnerTalk("));
    expect(outer).not.toContain("useVoiceTest(");
    expect(outer).not.toContain("useOwnerAssistant(");
    expect(outer).toMatch(/if \(loadFailed\)/);
    expect(outer).toMatch(/if \(!assistantId\)/);
    expect(outer).toMatch(/href="\/assistants"/);
  });

  it("shows every state: idle, connecting, active (mute + end), ended (talk again), the transcript and errors", () => {
    for (const s of ['status === "idle"', 'status === "connecting"', 'status === "active"', 'status === "ended"']) {
      expect(sessionUiSource).toContain(s);
    }
    expect(sessionUiSource).toMatch(/onClick=\{toggleMute\}/);
    expect(sessionUiSource).toMatch(/onClick=\{stop\}/);
    expect(sessionUiSource).toMatch(/onClick=\{handleTalkAgain\}/);
    expect(sessionUiSource).toMatch(/transcript\.map\(/);
    expect(sessionUiSource).toMatch(/<AlertDescription>\{error\}<\/AlertDescription>/);
    expect(sessionUiSource).toMatch(/aria-label=\{isMuted \? "Unmute microphone" : "Mute microphone"\}/);
    // … and the page renders all of it, full size.
    expect(panelSource).toMatch(/<OwnerAssistantControls session=\{session\} \/>/);
    expect(panelSource).toMatch(/<OwnerAssistantTranscript transcript=\{transcript\}/);
    expect(panelSource).toMatch(/<OwnerAssistantError error=\{error\} \/>/);
  });

  it("without the layout's provider, says it couldn't load instead of showing controls that can't work", () => {
    // SCRUM-597: or the layout found no assistant this render — unless a session is live (it stays on screen).
    expect(panelSource).toMatch(/if \(!assistant \|\| \(!assistant\.assistantId && !isSessionLive\(assistant\.session\.status\)\)\) return <LoadFailedAlert \/>;/);
    const alert = panelSource.slice(panelSource.indexOf("function LoadFailedAlert()"));
    expect(alert).toMatch(/<Alert variant="destructive">/);
    expect(alert).toMatch(/Couldn&apos;t load your assistant\. Refresh the page to try again\./);
    // The outer loadFailed state still shows the same alert.
    expect(panelSource).toMatch(/if \(loadFailed\) \{\s*return \(\s*<PageShell>\s*<LoadFailedAlert \/>/);
  });

  it("says plainly that changes are real, that it asks about telling the customer, and how long a session lasts", () => {
    expect(panelSource).toMatch(/reads every change back, asks whether to let the customer know, and waits for your yes\./); // SCRUM-597
    expect(panelSource).not.toMatch(/Customers aren&apos;t told automatically/);
    expect(panelSource).toMatch(/Each session lasts up to 8 minutes\./);
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
