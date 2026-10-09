"use strict";

// SCRUM-588: per-family request fields. The model IDs are env revert levers,
// so the request shape must follow the MODEL — these pin both directions.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isOpenAIReasoningModel,
  acceptsReasoningEffortNone,
  openAIChatParams,
  claudeLatencyParams,
  claudeResponseText,
} = require("../lib/model-params");

describe("isOpenAIReasoningModel", () => {
  it("is true for the reasoning families (GPT-5+, o-series)", () => {
    for (const m of ["gpt-6-luna", "gpt-6", "gpt-5.1-mini", "gpt-5", "o3-mini", "o4-mini", "GPT-6-LUNA"]) {
      assert.equal(isOpenAIReasoningModel(m), true, m);
    }
  });

  it("is false for gpt-4.x, the Gemini models sharing the compat body, and junk", () => {
    for (const m of ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo", "gemini-3.5-flash", "gemini-3.8-flash", "", undefined, null]) {
      assert.equal(isOpenAIReasoningModel(m), false, String(m));
    }
  });
});

describe("openAIChatParams", () => {
  it("reasoning model: max_completion_tokens + reasoning_effort none (it 400s on max_tokens)", () => {
    assert.deepEqual(openAIChatParams("gpt-6-luna", { maxTokens: 600, temperature: 0.1 }), {
      max_completion_tokens: 600,
      reasoning_effort: "none",
      temperature: 0.1,
    });
  });

  it("revert lever: gpt-4.1-mini keeps the classic shape — no reasoning_effort (it 400s on it)", () => {
    assert.deepEqual(openAIChatParams("gpt-4.1-mini", { maxTokens: 600, temperature: 0.1 }), {
      max_tokens: 600,
      temperature: 0.1,
    });
  });

  it("Gemini (OpenAI-compatible endpoint) keeps the classic shape", () => {
    assert.deepEqual(openAIChatParams("gemini-3.5-flash", { maxTokens: 150, temperature: 0.7 }), {
      max_tokens: 150,
      temperature: 0.7,
    });
  });
});

describe("claudeLatencyParams", () => {
  it("disables thinking for Haiku 5.5 (thinks by default) and the Haiku 4.5 revert lever", () => {
    assert.deepEqual(claudeLatencyParams("claude-haiku-5-5"), { thinking: { type: "disabled" } });
    assert.deepEqual(claudeLatencyParams("claude-haiku-4-5-20251001"), { thinking: { type: "disabled" } });
  });

  it("leaves other tiers on their defaults (Sonnet/Opus 5.5 reject `disabled`)", () => {
    assert.deepEqual(claudeLatencyParams("claude-sonnet-5-5"), {});
    assert.deepEqual(claudeLatencyParams("claude-opus-5-5"), {});
    assert.deepEqual(claudeLatencyParams(undefined), {});
  });
});

describe("claudeResponseText", () => {
  it("reads the text block by TYPE when a thinking block comes first", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"accurate": false, "discrepancy": "time"}' },
    ];
    assert.equal(claudeResponseText(content), '{"accurate": false, "discrepancy": "time"}');
  });

  it('returns "" when there is no text block (e.g. thinking spent the cap) or no content', () => {
    assert.equal(claudeResponseText([{ type: "thinking", thinking: "", signature: "s" }]), "");
    assert.equal(claudeResponseText(undefined), "");
    assert.equal(claudeResponseText("not-an-array"), "");
  });
});

// ─── Review round: snapshot / future / foreign IDs, and the effort floor ─────

describe("isOpenAIReasoningModel — snapshot, future and foreign IDs", () => {
  const REASONING = ["gpt-6-luna-2026-10-09", "gpt-7", "gpt-9-nano", "gpt-10", "gpt-12-mini", "gpt-6.5"];
  const CLASSIC = [
    "gpt-4.1-mini-2025-04-14", "gpt-4.1-nano", "gpt-4.5-preview", "gpt-4-turbo", "gpt-4o-mini-2024-07-18",
    "gemini-3.8-live", "claude-haiku-5-5", "ft:gpt-4.1-mini:acme::abc", "openai/gpt-6-luna",
  ];
  it("dated/future reasoning IDs", () => { for (const m of REASONING) assert.equal(isOpenAIReasoningModel(m), true, m); });
  it("dated classic / foreign IDs", () => { for (const m of CLASSIC) assert.equal(isOpenAIReasoningModel(m), false, m); });
});

describe("openAIChatParams — the efforts each family accepts", () => {
  it('GPT-5.1+ and GPT-6+ (incl. snapshots) get effort "none" + temperature', () => {
    for (const m of ["gpt-5.1", "gpt-5.1-mini", "gpt-5.2", "gpt-6-luna-2026-10-09", "gpt-6.5", "gpt-7", "gpt-10"]) {
      assert.equal(acceptsReasoningEffortNone(m), true, m);
      assert.deepEqual(openAIChatParams(m, { maxTokens: 300, temperature: 0.1 }), {
        max_completion_tokens: 300, reasoning_effort: "none", temperature: 0.1,
      }, m);
    }
  });

  // gpt-5 / gpt-5-mini / -nano bottom out at "minimal" and the o-series at
  // "low" — both 400 on "none" — and they reject any non-default temperature.
  // So they get the cap ONLY and run at their default effort (live-probed
  // 2026-10-09: gpt-5-mini and o4-mini both 200 with this body).
  for (const m of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "o1", "o3", "o4-mini"]) {
    it(`${m}: max_completion_tokens only — never an effort or temperature its family rejects`, () => {
      assert.equal(acceptsReasoningEffortNone(m), false, m);
      assert.deepEqual(openAIChatParams(m, { maxTokens: 300, temperature: 0.1 }), { max_completion_tokens: 300 });
    });
  }
});

describe("claudeLatencyParams — foreign and legacy IDs", () => {
  it("legacy Haiku 3.x naming and partner-prefixed IDs get no thinking field (they never had one)", () => {
    for (const m of ["claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "anthropic.claude-haiku-5-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0"]) {
      assert.deepEqual(claudeLatencyParams(m), {}, m);
    }
  });
});
