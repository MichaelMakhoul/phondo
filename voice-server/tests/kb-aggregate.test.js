const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_KB_CHARS,
  aggregateKnowledgeBase,
  prioritizeKnowledgeEntries,
  findEntriesBeyondCap,
} = require("../lib/kb-aggregate");
const { buildSystemPrompt } = require("../lib/prompt-builder");

/** A website-import entry the size a real 2-page crawl produces. */
function websiteEntry(chars, overrides = {}) {
  return {
    id: "kb-web",
    title: "example.com.au",
    source_type: "website",
    content:
      "## Business Information\n- Phone: 02 8555 1234\n\n## Website Content\n" +
      "We are a family owned practice committed to gentle care. ".repeat(Math.ceil(chars / 58)).slice(0, chars),
    ...overrides,
  };
}

const OWNER_FAQ = {
  id: "kb-faq",
  title: "Frequently Asked Questions",
  source_type: "faq",
  content: JSON.stringify([
    { question: "Do you service hybrid vehicles?", answer: "Yes, we are a certified hybrid service centre." },
  ]),
};

function buildPrompt(knowledgeBase) {
  return buildSystemPrompt(
    { systemPrompt: "You are a receptionist. {knowledge_base}", language: "en", settings: {} },
    { name: "Test Org", country: "AU", timezone: "Australia/Sydney" },
    knowledgeBase,
    {}
  );
}

// SCRUM-531: the website import is created first and is huge, so under
// created_at ordering it consumed the entire MAX_KB_CHARS budget and every
// entry the owner added later was sliced off before reaching the model.
describe("aggregateKnowledgeBase — owner entries outrank the website import (SCRUM-531)", () => {
  it("an owner FAQ added AFTER a 20k website import still reaches the model", () => {
    // created_at order: website first (that is what onboarding produces).
    const kb = aggregateKnowledgeBase([websiteEntry(20_000), OWNER_FAQ]);
    const prompt = buildPrompt(kb);
    assert.ok(prompt.includes("certified hybrid service centre"), "owner FAQ must survive the cap");
  });

  it("pins that the ORDERING is the fix: the same entries in created_at order lose the FAQ", () => {
    // Reconstruct the pre-SCRUM-531 join (no prioritisation). If this ever
    // starts passing, the cap grew enough to mask a reordering regression —
    // revisit both assertions together.
    const oldOrderKb = [websiteEntry(20_000), OWNER_FAQ]
      .map((e) => `## ${e.title}\n${e.content}`)
      .join("\n\n");
    const prompt = buildPrompt(oldOrderKb);
    assert.equal(prompt.includes("certified hybrid service centre"), false);
  });

  it("the FAQ survives the cap through the GUIDED prompt_config path too — the one production uses", () => {
    // Onboarding-created assistants carry prompt_config, so real calls take
    // buildPromptFromConfig, not the {knowledge_base} placeholder path. The
    // tail marker sits ~19k into the website entry: present in the prompt
    // means the cap stopped being applied on this path.
    const bigSite = websiteEntry(1, {
      content: "We are a family owned practice. ".repeat(600) + " TAIL_MARKER_BEYOND_CAP",
    });
    const kb = aggregateKnowledgeBase([bigSite, OWNER_FAQ]);
    const prompt = buildSystemPrompt(
      { promptConfig: { tone: "friendly", fields: [], behaviors: [] }, language: "en", settings: {} },
      { name: "Test Org", country: "AU", timezone: "Australia/Sydney" },
      kb,
      {}
    );
    assert.ok(prompt.includes("certified hybrid service centre"), "owner FAQ must reach guided prompts");
    assert.equal(prompt.includes("TAIL_MARKER_BEYOND_CAP"), false, "the 12k cap must apply to guided prompts");
  });

  it("the FAQ survives through the legacy NO-placeholder append path too", () => {
    const kb = aggregateKnowledgeBase([websiteEntry(20_000), OWNER_FAQ]);
    const prompt = buildSystemPrompt(
      { systemPrompt: "You are a receptionist.", language: "en", settings: {} },
      { name: "Test Org", country: "AU", timezone: "Australia/Sydney" },
      kb,
      {}
    );
    assert.ok(prompt.includes("certified hybrid service centre"));
  });

  it("website entries move after ALL owner-authored entries, whatever the input order", () => {
    const manual = { id: "m", title: "Parking", source_type: "manual", content: "Free parking behind the building." };
    const doc = { id: "d", title: "Price List", source_type: "document", content: "Standard service $199." };
    const kb = aggregateKnowledgeBase([websiteEntry(500), manual, doc]);
    const webIdx = kb.indexOf("## example.com.au");
    assert.ok(webIdx > kb.indexOf("## Parking"));
    assert.ok(webIdx > kb.indexOf("## Price List"));
  });

  it("is a STABLE partition: relative order within each group is preserved", () => {
    const entries = [
      { id: "w1", title: "Site A", source_type: "website", content: "a" },
      { id: "m1", title: "Note 1", source_type: "manual", content: "n1" },
      { id: "w2", title: "Site B", source_type: "website", content: "b" },
      { id: "m2", title: "Note 2", source_type: "manual", content: "n2" },
    ];
    const ordered = prioritizeKnowledgeEntries(entries).map((e) => e.id);
    assert.deepEqual(ordered, ["m1", "m2", "w1", "w2"]);
  });

  it("treats an unknown or missing source_type as owner-authored, never below a website dump", () => {
    // A NEW authored type mis-ranked below the scrape would silently
    // re-open this bug; the reverse merely costs a scrape some budget.
    const newType = { id: "n", title: "New Thing", source_type: "gbp-import", content: "x" };
    const untyped = { id: "u", title: "Untyped", content: "y" };
    const ordered = prioritizeKnowledgeEntries([websiteEntry(10), newType, untyped]).map((e) => e.id);
    assert.deepEqual(ordered, ["n", "u", "kb-web"]);
  });

  it("does not mutate the input array", () => {
    const entries = [websiteEntry(10), OWNER_FAQ];
    prioritizeKnowledgeEntries(entries);
    assert.equal(entries[0].id, "kb-web");
  });

  it("returns [] / \"\" for null, undefined and empty input", () => {
    assert.deepEqual(prioritizeKnowledgeEntries(null), []);
    assert.deepEqual(prioritizeKnowledgeEntries(undefined), []);
    assert.equal(aggregateKnowledgeBase(null), "");
    assert.equal(aggregateKnowledgeBase([]), "");
  });
});

describe("aggregateKnowledgeBase — section formatting (behaviour moved from call-context.js)", () => {
  it("renders FAQ JSON as Q/A pairs under the entry title", () => {
    const kb = aggregateKnowledgeBase([OWNER_FAQ]);
    assert.ok(kb.startsWith("## Frequently Asked Questions\n"));
    assert.ok(kb.includes("Q: Do you service hybrid vehicles?\nA: Yes, we are a certified hybrid service centre."));
  });

  it("joins multiple Q/A pairs with a blank line between pairs", () => {
    // Real FAQs have many pairs; every other fixture has one. A refactor that
    // renders only the first pair, or comma-joins them, passes every other test.
    const kb = aggregateKnowledgeBase([{
      id: "f",
      title: "FAQs",
      source_type: "faq",
      content: JSON.stringify([
        { question: "Q1?", answer: "A1." },
        { question: "Q2?", answer: "A2." },
        { question: "Q3?", answer: "A3." },
      ]),
    }]);
    assert.equal(kb, "## FAQs\nQ: Q1?\nA: A1.\n\nQ: Q2?\nA: A2.\n\nQ: Q3?\nA: A3.");
  });

  it("falls back to raw content when FAQ JSON is malformed, and warns with the entry id", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const kb = aggregateKnowledgeBase([{ id: "f", title: "FAQs", source_type: "faq", content: "not json {" }]);
    assert.equal(kb, "## FAQs\nnot json {");
    const call = warn.mock.calls.find((c) => String(c.arguments[0]).includes("malformed JSON"));
    assert.ok(call, "malformed FAQ must be logged");
    assert.equal(call.arguments[1].entryId, "f");
  });

  it("falls back to raw content when FAQ JSON parses but is not an array", () => {
    // JSON.parse succeeds, .map throws — the catch must absorb that too.
    const kb = aggregateKnowledgeBase([{ id: "f", title: "FAQs", source_type: "faq", content: "{\"question\":\"q\"}" }]);
    assert.equal(kb, "## FAQs\n{\"question\":\"q\"}");
  });

  it("uses source_type as the heading when title is missing", () => {
    const kb = aggregateKnowledgeBase([{ id: "m", source_type: "manual", content: "hello" }]);
    assert.equal(kb, "## manual\nhello");
  });
});

describe("findEntriesBeyondCap — boundary math including the \\n\\n separators", () => {
  it("reports nothing when the join lands exactly on the cap", () => {
    // 5000 + 2 (separator) + 6998 = 12000 exactly.
    const sizes = [
      { label: "a", length: 5000 },
      { label: "b", length: 6998 },
    ];
    assert.deepEqual(findEntriesBeyondCap(sizes, 12_000), []);
  });

  it("reports a partial cut when one char spills past the cap", () => {
    const sizes = [
      { label: "a", length: 5000 },
      { label: "b", length: 6999 },
    ];
    assert.deepEqual(findEntriesBeyondCap(sizes, 12_000), [{ label: "b", cut: "partial" }]);
  });

  it("labels an entry that starts at or past the cap as entirely cut", () => {
    const sizes = [
      { label: "a", length: 11_998 },
      { label: "b", length: 50 },
    ];
    // b starts at 11_998 + 2 = 12_000 — not one char of it reaches the AI.
    assert.deepEqual(findEntriesBeyondCap(sizes, 12_000), [{ label: "b", cut: "entire" }]);
  });
});

describe("truncation is loud (SCRUM-531)", () => {
  it("aggregateKnowledgeBase warns with the cut entries when the KB exceeds the cap", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    aggregateKnowledgeBase([websiteEntry(MAX_KB_CHARS + 5_000), OWNER_FAQ], "[TestTag]");
    const calls = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("[TestTag] KB is"));
    assert.equal(calls.length, 1);
    const { cutEntries } = calls[0].arguments[1];
    // The FAQ is ordered first and fits; only the website entry is cut.
    assert.deepEqual(cutEntries, [{ label: "example.com.au (website)", cut: "partial" }]);
  });

  it("aggregateKnowledgeBase stays silent when the KB fits", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    aggregateKnowledgeBase([OWNER_FAQ]);
    assert.equal(warn.mock.calls.length, 0);
  });

  it("buildSystemPrompt warns when it has to slice", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const prompt = buildPrompt("x".repeat(MAX_KB_CHARS + 1));
    assert.ok(prompt.includes("[Knowledge base truncated for brevity]"));
    assert.equal(
      warn.mock.calls.some((c) => String(c.arguments[0]).includes("[PromptBuilder] Knowledge base is")),
      true
    );
  });
});
