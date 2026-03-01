const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Instead of mocking the module, we directly test the logic by
// requiring the module after overriding the supabase module in the
// require cache.

// Create mock supabase
let mockPhoneResult = { data: null, error: null };
let mockAssistantResult = { data: null, error: null };

const mockSupabase = {
  from: (table) => {
    const chain = {
      _table: table,
      select: () => chain,
      eq: () => chain,
      single: () => {
        if (chain._table === "phone_numbers") return Promise.resolve(mockPhoneResult);
        if (chain._table === "assistants") return Promise.resolve(mockAssistantResult);
        return Promise.resolve({ data: null, error: { message: "Unknown table" } });
      },
    };
    return chain;
  },
};

// Override the supabase module in require cache
const supabasePath = require.resolve("../lib/supabase");
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: { getSupabase: () => mockSupabase },
};

const { getAnswerMode } = require("../lib/answer-mode");

describe("getAnswerMode", () => {
  beforeEach(() => {
    mockPhoneResult = { data: null, error: null };
    mockAssistantResult = { data: null, error: null };
  });

  it("returns null when phone number not found", async () => {
    mockPhoneResult = { data: null, error: { message: "Not found" } };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });

  it("returns null when phone number has no assistant_id", async () => {
    mockPhoneResult = { data: { assistant_id: null }, error: null };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });

  it("returns null when assistant settings don't have ring_first", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: { settings: { answerMode: "ai_first" } },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });

  it("returns null when answerMode is ring_first but no ringFirstNumber", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: { settings: { answerMode: "ring_first" } },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });

  it("returns null when ringFirstNumber is invalid", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: {
        settings: {
          answerMode: "ring_first",
          ringFirstNumber: "not-a-number",
        },
      },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });

  it("returns config when ring_first is set with valid phone", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: {
        settings: {
          answerMode: "ring_first",
          ringFirstNumber: "+61412345678",
          ringFirstTimeout: 25,
        },
      },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.deepEqual(result, {
      answerMode: "ring_first",
      ringFirstNumber: "+61412345678",
      ringFirstTimeout: 25,
    });
  });

  it("defaults timeout to 20 when not specified", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: {
        settings: {
          answerMode: "ring_first",
          ringFirstNumber: "+61412345678",
        },
      },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result.ringFirstTimeout, 20);
  });

  it("clamps timeout to minimum of 5", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: {
        settings: {
          answerMode: "ring_first",
          ringFirstNumber: "+61412345678",
          ringFirstTimeout: 2,
        },
      },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result.ringFirstTimeout, 5);
  });

  it("clamps timeout to maximum of 60", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = {
      data: {
        settings: {
          answerMode: "ring_first",
          ringFirstNumber: "+61412345678",
          ringFirstTimeout: 120,
        },
      },
      error: null,
    };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result.ringFirstTimeout, 60);
  });

  it("returns null when assistant query fails", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = { data: null, error: { message: "DB error" } };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });

  it("returns null when settings is null", async () => {
    mockPhoneResult = { data: { assistant_id: "ast-123" }, error: null };
    mockAssistantResult = { data: { settings: null }, error: null };
    const result = await getAnswerMode("+61299999999");
    assert.equal(result, null);
  });
});
