const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  anthropicGateway, gatewayKeyName, gatewayProblem, gatewayModelProblem, messagesRequest, describeGateway, ANTHROPIC_MESSAGES_URL, OPENROUTER_MESSAGES_URL,
  isStandingRefusal, noteGatewayRefusal, gatewayRefusal, REFUSAL_LATCH_MS, _test,
} = require("../lib/anthropic-gateway");

// SCRUM-594: ANTHROPIC_GATEWAY=openrouter sends the voice server's Anthropic Messages requests through
// OpenRouter on the owner's capped key while the Anthropic balance is empty (25 Oct 2026): Haiku 5.5 only.
const BODY = { model: "claude-haiku-5-5", max_tokens: 200, stream: true, system: "Be brief.", messages: [{ role: "user", content: "Hi" }] };
const DIRECT = { ANTHROPIC_API_KEY: "sk-ant-test" };
const OPENROUTER = { ANTHROPIC_GATEWAY: "openrouter", OPENROUTER_API_KEY: "sk-or-test", ANTHROPIC_API_KEY: "sk-ant-test" };

describe("messagesRequest: straight to Anthropic (the default)", () => {
  it("unset or \"anthropic\": api.anthropic.com with the Anthropic key, the body as given", () => {
    for (const env of [DIRECT, { ...DIRECT, ANTHROPIC_GATEWAY: "anthropic" }, { ...DIRECT, ANTHROPIC_GATEWAY: "" }]) {
      const req = messagesRequest(BODY, env);
      assert.equal(req.gateway, "anthropic");
      assert.equal(req.url, "https://api.anthropic.com/v1/messages");
      assert.deepEqual(req.headers, { "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01", "content-type": "application/json" });
      assert.deepEqual(JSON.parse(req.body), BODY);
    }
    assert.equal(ANTHROPIC_MESSAGES_URL, "https://api.anthropic.com/v1/messages");
  });

  it("takes any model, as before", () => {
    assert.equal(JSON.parse(messagesRequest({ ...BODY, model: "claude-haiku-4-5-20251001" }, DIRECT).body).model, "claude-haiku-4-5-20251001");
  });

  it("no Anthropic key, or an empty one: throws before any request", () => {
    assert.throws(() => messagesRequest(BODY, {}), /^Error: ANTHROPIC_API_KEY not set$/);
    assert.throws(() => messagesRequest(BODY, { ANTHROPIC_API_KEY: "" }), /^Error: ANTHROPIC_API_KEY not set$/);
  });
});

describe("messagesRequest: ANTHROPIC_GATEWAY=openrouter", () => {
  it("OpenRouter's Messages endpoint, its key as a bearer token, Haiku 5.5 by OpenRouter's name, pinned to Anthropic's servers", () => {
    const req = messagesRequest(BODY, OPENROUTER);
    assert.equal(req.gateway, "openrouter");
    assert.equal(req.url, "https://openrouter.ai/api/v1/messages");
    assert.equal(OPENROUTER_MESSAGES_URL, req.url);
    assert.deepEqual(req.headers, { authorization: "Bearer sk-or-test", "anthropic-version": "2023-06-01", "content-type": "application/json" });
    assert.ok(!("x-api-key" in req.headers), "the Anthropic key never goes to OpenRouter");
    assert.deepEqual(JSON.parse(req.body), { ...BODY, model: "anthropic/claude-haiku-5.5", provider: { only: ["anthropic"], allow_fallbacks: false } });
  });

  it("leaves the caller's body as it was", () => {
    const body = structuredClone(BODY);
    messagesRequest(body, OPENROUTER);
    assert.deepEqual(body, BODY);
  });

  it("refuses every model but Haiku 5.5: never Sonnet, Fable or Opus on the owner's key", () => {
    for (const model of ["claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-haiku-4-5-20251001", "anthropic/claude-haiku-5.5"]) {
      assert.throws(() => messagesRequest({ ...BODY, model }, OPENROUTER), new RegExp(`^Error: ${model.replace(/[.]/g, "\\.")} may not be sent through OpenRouter \\(claude-haiku-5-5 only\\)$`));
    }
    assert.throws(() => messagesRequest({ ...BODY, model: undefined }, OPENROUTER), /^Error: \(no model\) may not be sent through OpenRouter/);
  });

  it("refuses OpenRouter's routing fields: any of them could reach another model or provider", () => {
    for (const field of ["models", "route", "preset", "plugins", "provider"]) {
      assert.throws(() => messagesRequest({ ...BODY, [field]: ["anthropic/claude-opus-5"] }, OPENROUTER), new RegExp(`routing fields \\(${field}\\)`));
    }
  });

  it("no OpenRouter key: throws, and never falls back to the empty Anthropic account", () => {
    assert.throws(() => messagesRequest(BODY, { ...OPENROUTER, OPENROUTER_API_KEY: undefined }), /^Error: OPENROUTER_API_KEY not set \(ANTHROPIC_GATEWAY=openrouter\)$/);
    assert.throws(() => messagesRequest(BODY, { ...OPENROUTER, OPENROUTER_API_KEY: "" }), /OPENROUTER_API_KEY not set/);
  });

  it("no key in any error message", () => {
    for (const env of [OPENROUTER, { ...OPENROUTER, OPENROUTER_API_KEY: "" }]) {
      try {
        messagesRequest({ ...BODY, model: "claude-opus-5-5" }, env);
        assert.fail("expected a throw");
      } catch (err) {
        assert.ok(!String(err.message).includes("sk-or-test") && !String(err.message).includes("sk-ant-test"), err.message);
      }
    }
  });
});

describe("ANTHROPIC_GATEWAY: a value it doesn't know", () => {
  it("throws on a request, names the value, and the fast path's key check says no", () => {
    const env = { ...OPENROUTER, ANTHROPIC_GATEWAY: "open-router" };
    assert.throws(() => anthropicGateway(env), /ANTHROPIC_GATEWAY must be "anthropic" or "openrouter" \(got "open-router"\)/);
    assert.throws(() => messagesRequest(BODY, env), /got "open-router"/);
    assert.match(gatewayProblem(env) ?? "", /got "open-router"/);
    assert.equal(gatewayKeyName(env), 'ANTHROPIC_GATEWAY ("anthropic" or "openrouter")');
  });
});

describe("gatewayProblem and gatewayKeyName", () => {
  it("name the key the gateway needs, and say when it's missing", () => {
    assert.equal(gatewayProblem(DIRECT), null);
    assert.equal(gatewayProblem(OPENROUTER), null);
    assert.equal(gatewayProblem({ ANTHROPIC_GATEWAY: "openrouter", ANTHROPIC_API_KEY: "sk-ant-test" }), "OPENROUTER_API_KEY not set (ANTHROPIC_GATEWAY=openrouter)");
    assert.equal(gatewayProblem({ OPENROUTER_API_KEY: "sk-or-test" }), "ANTHROPIC_API_KEY not set");
    assert.equal(gatewayKeyName({}), "ANTHROPIC_API_KEY");
    assert.equal(gatewayKeyName({ ANTHROPIC_GATEWAY: "openrouter" }), "OPENROUTER_API_KEY");
  });
});

describe("describeGateway: the boot log's line", () => {
  it("nothing on the default", () => {
    assert.equal(describeGateway(DIRECT), null);
    assert.equal(describeGateway({ ...DIRECT, ANTHROPIC_GATEWAY: "anthropic" }), null);
    assert.equal(describeGateway({ ...DIRECT, ANTHROPIC_GATEWAY: "" }), null, "blank is the default, as messagesRequest reads it");
  });

  it("says where requests go, a missing key, a bad value, and the classic fallback that still goes direct", () => {
    assert.equal(describeGateway(OPENROUTER), "Anthropic requests: via OpenRouter, claude-haiku-5-5 only, pinned to Anthropic's servers");
    assert.equal(describeGateway({ ...OPENROUTER, OPENROUTER_API_KEY: "" }), "⚠️ Anthropic requests: OPENROUTER_API_KEY not set (ANTHROPIC_GATEWAY=openrouter) — every one will fail");
    assert.match(describeGateway({ ANTHROPIC_GATEWAY: "nope" }) ?? "", /^⚠️ Anthropic requests: ANTHROPIC_GATEWAY must be .* — every one will fail$/);
    assert.match(describeGateway({ ...OPENROUTER, LLM_PROVIDER: "anthropic" }) ?? "", /; the classic fallback \(LLM_PROVIDER=anthropic\) still calls Anthropic directly$/);
    assert.ok(!(describeGateway(OPENROUTER) ?? "").includes("sk-or-test"));
  });

  it("names each configured model OpenRouter won't take (the documented revert levers)", () => {
    assert.equal(
      describeGateway({ ...OPENROUTER, FAST_LLM_MODEL: "claude-haiku-4-5-20251001", VALIDATOR_MODEL: "claude-haiku-5-5", CR_LLM_MODEL: "claude-sonnet-5-5" }),
      "Anthropic requests: via OpenRouter, claude-haiku-5-5 only, pinned to Anthropic's servers; ⚠️ OpenRouter won't take FAST_LLM_MODEL=claude-haiku-4-5-20251001, CR_LLM_MODEL=claude-sonnet-5-5",
    );
    assert.ok(!(describeGateway({ ...OPENROUTER, VALIDATOR_MODEL: "claude-haiku-5-5" }) ?? "").includes("won't take"));
    assert.match(describeGateway({ ...OPENROUTER, VALIDATOR_MODEL: "claude-haiku-4-5-20251001" }) ?? "", /won't take VALIDATOR_MODEL=claude-haiku-4-5-20251001$/);
  });
});

describe("every Anthropic Messages call goes through the gateway", () => {
  it("no other source file names api.anthropic.com (the classic fallback, services/openai-llm.js, is the one exemption)", () => {
    // A new call site (e.g. PR #442's booking pre-check) would otherwise hit the empty account while ANTHROPIC_GATEWAY=openrouter.
    const root = path.join(__dirname, "..");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "tests", "scripts", "public", ".git"].includes(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js") && fs.readFileSync(p, "utf8").includes("api.anthropic.com")) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    assert.deepEqual(offenders.sort(), ["lib/anthropic-gateway.js", "services/openai-llm.js"]);
  });
});

describe("gatewayModelProblem", () => {
  it("OpenRouter takes Haiku 5.5 only; Anthropic takes any model; a bad gateway value is gatewayProblem's to name", () => {
    assert.equal(gatewayModelProblem("claude-haiku-5-5", OPENROUTER), null);
    assert.equal(gatewayModelProblem("claude-opus-5-5", OPENROUTER), "claude-opus-5-5 may not be sent through OpenRouter (claude-haiku-5-5 only)");
    assert.equal(gatewayModelProblem(["claude-haiku-5-5"], OPENROUTER), "claude-haiku-5-5 may not be sent through OpenRouter (claude-haiku-5-5 only)", "not a string");
    assert.equal(gatewayModelProblem("claude-opus-5-5", DIRECT), null);
    assert.equal(gatewayModelProblem("claude-opus-5-5", { ANTHROPIC_GATEWAY: "nope" }), null);
  });
});

describe("the standing-refusal latch (phone test F10: every turn refused, every turn an apology)", () => {
  it("only refusals that repeat on every request: no credit, a spent cap, a bad key", () => {
    assert.equal(isStandingRefusal(400, "Your credit balance is too low to access the Anthropic API."), true);
    assert.equal(isStandingRefusal(402, ""), true);
    assert.equal(isStandingRefusal(401, "invalid x-api-key"), true);
    assert.equal(isStandingRefusal(403, "Key limit exceeded"), true);
    assert.equal(isStandingRefusal(403, "Your input was flagged"), false, "a moderation 403 is about one request");
    assert.equal(isStandingRefusal(400, "messages: field required"), false, "a bad request is about one request");
    for (const status of [404, 429, 500, 502, 503, 529]) assert.equal(isStandingRefusal(status, "credit balance limit"), false, String(status));
  });

  it("holds for REFUSAL_LATCH_MS, renews while the refusal repeats, alerts once, and lapses by itself", (t) => {
    t.after(() => _test.resetRefusal());
    const alerts = [];
    t.mock.method(console, "error", (...a) => alerts.push(a.join(" ")));
    const t0 = 1_000_000;
    assert.equal(gatewayRefusal(t0), null);
    assert.equal(noteGatewayRefusal(429, "", t0), false, "a transient error doesn't latch");
    assert.equal(gatewayRefusal(t0), null);
    assert.equal(noteGatewayRefusal(402, "Key limit exceeded", t0), true);
    assert.equal(gatewayRefusal(t0 + 1), "Claude requests refused (HTTP 402: Key limit exceeded)");
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /^\[ALERT:error\] \[anthropic-gateway\] Claude requests refused \(HTTP 402: Key limit exceeded\) — the demo line takes VOICE_PIPELINE for 10 min at a time while this repeats/);
    assert.equal(noteGatewayRefusal(402, "Key limit exceeded", t0 + 5 * 60_000), false, "a repeat renews without a second alert");
    assert.equal(alerts.length, 1);
    assert.ok(gatewayRefusal(t0 + REFUSAL_LATCH_MS + 60_000), "renewed from the repeat");
    assert.equal(gatewayRefusal(t0 + 5 * 60_000 + REFUSAL_LATCH_MS), null, "lapsed: a top-up needs no restart");
    assert.equal(noteGatewayRefusal(400, "Your credit balance is too low", t0 + 20 * 60_000), true, "a new refusal after it lapsed alerts again");
    assert.equal(alerts.length, 2);
    assert.equal(REFUSAL_LATCH_MS, 10 * 60_000);
  });
});
