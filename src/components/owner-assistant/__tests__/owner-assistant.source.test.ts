import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// SCRUM-597: source pins for the always-on owner assistant bubble. The repo's vitest
// env (node, no DOM, JSX left as "preserve") can't render TSX or run the async server
// layout, so the wiring is pinned against source, the same idiom as
// assistant-line/__tests__/assistant-line.source.test.ts. The pure logic (storage,
// pathname, state labels) is tested for real in bubble-state.test.ts.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf-8");

// Comments dropped, so prose that mentions an API can't satisfy, or trip, a pin.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const layoutSource = read("src/app/(dashboard)/layout.tsx");
const pageSource = read("src/app/(dashboard)/assistant-line/page.tsx");
const panelSource = read("src/app/(dashboard)/assistant-line/owner-talk-panel.tsx");
const providerSource = read("src/components/owner-assistant/owner-assistant-provider.tsx");
const bubbleSource = read("src/components/owner-assistant/owner-assistant-bubble.tsx");
const sessionUiSource = read("src/components/owner-assistant/owner-assistant-session-ui.tsx");
const helpersSource = read("src/components/owner-assistant/bubble-state.ts");

const layoutCode = code(layoutSource);
const providerCode = code(providerSource);
const bubbleCode = code(bubbleSource);
const sessionUiCode = code(sessionUiSource);

describe("dashboard layout (server)", () => {
  const gate = layoutCode.indexOf('if (isOwnerAssistantUiEnabled() && memberships[0].role === "owner" && currentOrg) {');
  const gateEnd = layoutCode.indexOf("\n  }\n", gate);
  const gateBlock = layoutCode.slice(gate, gateEnd);

  it("reads the server-only UI flag from feature-flags", () => {
    expect(layoutCode).toMatch(/import \{ isOwnerAssistantUiEnabled \} from "@\/lib\/feature-flags";/);
  });

  it("checks the flag, then the owner role of memberships[0] (getPrimaryMembership's pick), before any assistants query", () => {
    expect(gate).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gate);
    const reads = [...layoutCode.matchAll(/\.from\("assistants"\)/g)];
    expect(reads).toHaveLength(1);
    expect(reads[0].index).toBeGreaterThan(gate);
    expect(reads[0].index).toBeLessThan(gateEnd);
  });

  it("loads the org's first active assistant with exactly the query /assistant-line uses", () => {
    const chain = (source: string, orgExpression: string) => {
      const match = source.match(/\.from\("assistants"\)[\s\S]*?\.maybeSingle\(\)/);
      expect(match, "no assistants query").not.toBeNull();
      return match![0].replace(/\s+/g, "").replace(orgExpression, "<org>");
    };
    expect(gateBlock).toMatch(
      /\.from\("assistants"\)\s*\.select\("id"\)\s*\.eq\("organization_id", currentOrg\.id\)\s*\.eq\("is_active", true\)\s*\.order\("created_at", \{ ascending: true \}\)\s*\.limit\(1\)\s*\.maybeSingle\(\)/,
    );
    expect(chain(layoutCode, "currentOrg.id")).toBe(chain(pageSource, "membership.organization_id"));
  });

  it("logs a failed read like the page does, and carries on without the bubble instead of throwing", () => {
    expect(gateBlock).toMatch(/console\.error\("\[Dashboard Layout\] owner assistant read failed:", \{/);
    expect(gateBlock).toMatch(/organizationId: currentOrg\.id,/);
    expect(gateBlock).toMatch(/errorCode: assistantError\.code,/);
    expect(gateBlock).toMatch(/errorMessage: assistantError\.message,/);
    expect(gateBlock).not.toMatch(/\bthrow\b/);
    expect(gateBlock).toMatch(/ownerAssistantId = assistant\?\.id \?\? null;/);
  });

  it("only that gate can set the assistant id, so nobody else gets a provider or a bubble", () => {
    const declaration = layoutCode.indexOf("let ownerAssistantId: string | null = null;");
    expect(declaration).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(gate);
    const assignments = [...layoutCode.matchAll(/\bownerAssistantId = /g)];
    expect(assignments).toHaveLength(1);
    expect(assignments[0].index).toBeGreaterThan(gate);
    expect(assignments[0].index).toBeLessThan(gateEnd);
  });

  it("renders exactly today's tree when there is no assistant id", () => {
    const early = layoutCode.indexOf("if (!ownerAssistantId) return dashboard;");
    expect(early).toBeGreaterThan(gateEnd);
    expect(early).toBeLessThan(layoutCode.indexOf("<OwnerAssistantProvider"));
    // The page content (children) lives in `dashboard`, so both branches render it.
    const dashboardStart = layoutCode.indexOf("const dashboard = (");
    expect(dashboardStart).toBeGreaterThan(gateEnd);
    expect(layoutCode.indexOf("{children}")).toBeGreaterThan(dashboardStart);
    expect(layoutCode.indexOf("{children}")).toBeLessThan(early);
  });

  it("wraps the content in one provider keyed by org id, with the bubble inside it", () => {
    expect(layoutCode.match(/<OwnerAssistantProvider/g)).toHaveLength(1);
    expect(layoutCode.match(/<OwnerAssistantBubble/g)).toHaveLength(1);
    const open = layoutCode.indexOf("<OwnerAssistantProvider assistantId={ownerAssistantId} key={currentOrg.id}>");
    const close = layoutCode.indexOf("</OwnerAssistantProvider>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const inside = layoutCode.slice(open, close);
    expect(inside).toContain("{dashboard}");
    expect(inside).toContain("<OwnerAssistantBubble />");
  });
});

describe("OwnerAssistantProvider (client)", () => {
  it("is a client component exporting the provider and its hook", () => {
    expect(providerSource.startsWith('"use client";')).toBe(true);
    expect(providerCode).toMatch(/export function OwnerAssistantProvider\(/);
    expect(providerCode).toMatch(/export function useOwnerAssistant\(\): OwnerAssistantContextValue \| null \{/);
  });

  it("owns the one voice session, with the owner token URL and its own analytics source", () => {
    expect(providerCode.match(/useVoiceTest\(/g)).toHaveLength(1);
    expect(providerCode).toMatch(
      /useVoiceTest\(\{ assistantId, tokenUrl: OWNER_ASSISTANT_TOKEN_URL, trackingSource: "owner_assistant" \}\)/,
    );
    expect(providerCode).toMatch(/import \{ OWNER_ASSISTANT_TOKEN_URL \} from "@\/lib\/owner-assistant\/web";/);
  });

  it("has a null default, so useOwnerAssistant() is null when no provider is mounted", () => {
    expect(providerCode).toMatch(/createContext<OwnerAssistantContextValue \| null>\(null\)/);
    expect(providerCode).toMatch(/return useContext\(OwnerAssistantContext\);/);
  });

  it("reads the remembered panel state only after mount, and only through the guarded helpers", () => {
    expect(providerCode).toMatch(/useState<PanelState \| null>\(null\)/);
    expect(providerCode).toMatch(/useEffect\(\(\) => \{\s*setPanelState\(readPanelState\(getBrowserStorage\(\)\)\);\s*\}, \[\]\);/);
    expect(providerCode).toMatch(/writePanelState\(getBrowserStorage\(\), next\);/);
    // Every storage access goes through bubble-state.ts's try/catch.
    expect(providerCode).not.toMatch(/localStorage|sessionStorage/);
  });

  it("never starts a session by itself", () => {
    expect(providerCode).not.toMatch(/\bstart\s*\(/);
  });
});

describe("OwnerAssistantBubble (client)", () => {
  it("is a client component on the provider's session, never a second one", () => {
    expect(bubbleSource.startsWith('"use client";')).toBe(true);
    expect(bubbleCode).toMatch(/const assistant = useOwnerAssistant\(\);/);
    expect(bubbleCode).not.toContain("useVoiceTest");
  });

  it("renders nothing without a provider, before the remembered state is read, or on /assistant-line", () => {
    expect(bubbleCode).toMatch(/const pathname = usePathname\(\);/);
    expect(bubbleCode).toMatch(
      /if \(!assistant \|\| panelState === null \|\| !shouldShowFloatingBubble\(pathname\)\) return null;/,
    );
  });

  it("collapsed: a round button whose accessible name says what clicking does, then the state", () => {
    expect(bubbleCode).toMatch(/const \{ indicator, ariaLabel, announcement \} = describeBubbleState\(session\);/);
    const launcher = bubbleCode.slice(bubbleCode.indexOf("<button"), bubbleCode.indexOf("</button>"));
    expect(launcher).toMatch(/type="button"/);
    expect(launcher).toMatch(/onClick=\{open\}/);
    expect(launcher).toMatch(/aria-label=\{ariaLabel\}/);
    expect(launcher).toMatch(/rounded-full/);
  });

  it("collapsed: shows every state (ready, connecting spinner, listening, speaking pulse, muted, error dot)", () => {
    expect(bubbleCode).toMatch(/const LAUNCHER_COLORS: Record<BubbleIndicator, string> = \{/);
    expect(bubbleCode).toMatch(/case "connecting":\s*return <Loader2 className=\{cn\(className, "motion-safe:animate-spin"\)\} \/>;/);
    expect(bubbleCode).toMatch(/case "listening":\s*return <Mic /);
    expect(bubbleCode).toMatch(/case "muted":\s*return <MicOff /);
    expect(bubbleCode).toMatch(/default:\s*return <Bot /);
    expect(bubbleCode).toMatch(/\{indicator === "speaking" && \(\s*<span aria-hidden="true" className="[^"]*motion-safe:animate-ping/);
    expect(bubbleCode).toMatch(/\{indicator === "error" && \(\s*<span\s+aria-hidden="true"\s+className="[^"]*bg-destructive/);
  });

  it("expanded: a labelled region with a header, a minimise button, and Escape to minimise", () => {
    expect(bubbleCode).toMatch(/role="region"\s+aria-label="Your assistant"/);
    expect(bubbleCode).toMatch(/<h2 className="[^"]*">Your assistant<\/h2>/);
    expect(bubbleCode).toMatch(/onClick=\{minimise\}\s+aria-label="Minimise your assistant"/);
    expect(bubbleCode).toMatch(/onKeyDown=\{handleKeyDown\}/);
    expect(bubbleCode).toMatch(
      /const handleKeyDown = \(event: KeyboardEvent<HTMLDivElement>\) => \{\s*if \(event\.key === "Escape" && !event\.defaultPrevented\) \{\s*event\.preventDefault\(\);\s*minimise\(\);/,
    );
  });

  it("moves focus into the panel when the owner opens it and back to the button when they minimise", () => {
    expect(bubbleCode).toMatch(/const open = \(\) => \{\s*focusAfterToggleRef\.current = "panel";\s*openPanel\(\);/);
    expect(bubbleCode).toMatch(/const minimise = \(\) => \{\s*focusAfterToggleRef\.current = "launcher";\s*minimisePanel\(\);/);
    expect(bubbleCode).toMatch(/if \(target === "panel"\) panelRef\.current\?\.focus\(\);/);
    expect(bubbleCode).toMatch(/if \(target === "launcher"\) launcherRef\.current\?\.focus\(\);/);
    expect(bubbleCode).toMatch(/ref=\{panelRef\}/);
    expect(bubbleCode).toMatch(/ref=\{launcherRef\}/);
    // A restored state is not the owner's action: it must not steal focus on load.
    expect(bubbleCode).toMatch(/useRef<"panel" \| "launcher" \| null>\(null\)/);
  });

  it("expanded: the short 'changes are real' line, then the shared controls, transcript and error", () => {
    expect(bubbleSource.replace(/\s+/g, " ")).toContain(
      "Changes are real: it reads every change back and waits for your yes. Sessions last up to 8 minutes.",
    );
    expect(bubbleCode).toMatch(/<OwnerAssistantControls session=\{session\} compact \/>/);
    expect(bubbleCode).toMatch(/<OwnerAssistantTranscript transcript=\{session\.transcript\}/);
    expect(bubbleCode).toMatch(/<OwnerAssistantError error=\{session\.error\} \/>/);
    expect(bubbleCode).toMatch(/from "\.\/owner-assistant-session-ui"/);
  });

  it("sits above the mobile bottom nav and in the corner from md up, under dialogs and sheets", () => {
    expect(bubbleCode).toMatch(
      /const ANCHOR = "fixed bottom-\[calc\(5rem_\+_env\(safe-area-inset-bottom\)\)\] z-40 md:bottom-6";/,
    );
    expect(bubbleCode.match(/\bANCHOR,/g)).toHaveLength(2);
  });

  it("expanded: nearly full width on mobile, w-96 from md, height-capped with its own scroll", () => {
    const panel = bubbleCode.slice(bubbleCode.indexOf('role="region"'), bubbleCode.indexOf("<OwnerAssistantError"));
    expect(panel).toMatch(/left-4 right-4/);
    expect(panel).toMatch(/md:left-auto md:right-6/);
    expect(panel).toMatch(/md:w-96/);
    expect(panel).toMatch(/max-h-\[calc\(100dvh_-_9rem\)\]/);
    expect(panel).toMatch(/md:max-h-\[/);
    expect(panel).toMatch(/className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"/);
  });

  it("only animates for viewers who haven't asked for reduced motion", () => {
    for (const source of [bubbleCode, sessionUiCode]) {
      const animations = source.match(/[\w:-]*animate-[\w-]+/g) ?? [];
      for (const animation of animations) {
        expect(animation, `${animation} must be motion-safe:`).toMatch(/^motion-safe:/);
      }
    }
    expect(bubbleCode).toContain("motion-safe:animate-ping");
    expect(bubbleCode).toContain("motion-safe:animate-spin");
  });

  it("announces session changes in a status region", () => {
    expect(bubbleCode).toMatch(/<p role="status" className="sr-only">/);
    expect(bubbleCode).toMatch(/\{isMinimised \|\| indicator !== "error" \? announcement : ""\}/);
  });

  it("never starts a session by itself", () => {
    expect(bubbleCode).not.toMatch(/\bstart\s*\(/);
  });
});

describe("shared session UI", () => {
  it("starts a session only from the Start talking click, resetting first so a stale mute can't show", () => {
    expect(sessionUiCode.match(/\bstart\(\)/g)).toHaveLength(1);
    expect(sessionUiCode).toMatch(/const handleStart = \(\) => \{\s*reset\(\);\s*void start\(\);\s*\};/);
    expect(sessionUiCode.match(/\bhandleStart\b/g)).toHaveLength(2);
    expect(sessionUiCode).toMatch(/onClick=\{handleStart\}/);
  });

  it("follows the newest transcript line by scrolling only its own box", () => {
    expect(sessionUiCode).toMatch(/if \(list && followRef\.current\) list\.scrollTop = list\.scrollHeight;/);
    expect(sessionUiCode).toMatch(/followRef\.current = isNearBottom\(event\.currentTarget\);/);
    expect(sessionUiCode).not.toContain("scrollIntoView");
    // A new session's transcript starts empty: follow it again from its first line.
    expect(sessionUiCode).toMatch(/if \(transcript\.length === 0\) \{\s*followRef\.current = true;/);
  });
});

describe("client files never read the server-only flag (it is always false in the browser)", () => {
  it.each([
    ["owner-assistant-provider.tsx", providerSource],
    ["owner-assistant-bubble.tsx", bubbleSource],
    ["owner-assistant-session-ui.tsx", sessionUiSource],
    ["bubble-state.ts", helpersSource],
    ["owner-talk-panel.tsx", panelSource],
  ])("%s", (_name, source) => {
    expect(source).not.toContain("isOwnerAssistantUiEnabled");
    expect(source).not.toContain("OWNER_ASSISTANT_UI_ENABLED");
    expect(source).not.toContain("process.env");
  });
});
