const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { detectAndRedact, redactObject, luhnCheck } = require("../lib/pii-detector");

describe("luhnCheck", () => {
  it("validates a known-valid card number", () => {
    assert.equal(luhnCheck("4111111111111111"), true);
  });
  it("rejects an invalid card number", () => {
    assert.equal(luhnCheck("4111111111111112"), false);
  });
});

describe("detectAndRedact — Medicare", () => {
  it("redacts Medicare number near keyword", () => {
    const input = "My medicare number is 2345 67890 1";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("medicare"));
    assert.ok(result.redacted.includes("[REDACTED-MEDICARE]"));
    assert.ok(!result.redacted.includes("2345"));
  });

  it("does not redact digits without medicare keyword", () => {
    const input = "Order number 2345 67890 1 is ready";
    const result = detectAndRedact(input);
    assert.ok(!result.redacted.includes("[REDACTED-MEDICARE]"));
  });
});

describe("detectAndRedact — TFN", () => {
  it("redacts TFN near keyword", () => {
    const input = "My tax file number is 123 456 789";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("tfn"));
    assert.ok(result.redacted.includes("[REDACTED-TFN]"));
  });

  it("redacts TFN with tfn keyword", () => {
    const input = "My tfn is 123-456-789";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("tfn"));
  });
});

describe("detectAndRedact — ABN", () => {
  it("redacts ABN near keyword", () => {
    const input = "Our abn is 12 345 678 901";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("abn"));
    assert.ok(result.redacted.includes("[REDACTED-ABN]"));
  });
});

describe("detectAndRedact — Email (standalone)", () => {
  it("redacts email without keyword", () => {
    const input = "Please send it to john.doe@example.com thanks";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("email"));
    assert.ok(result.redacted.includes("[REDACTED-EMAIL]"));
    assert.ok(!result.redacted.includes("john.doe@example.com"));
  });
});

describe("detectAndRedact — Credit Card (Luhn validated)", () => {
  it("redacts valid credit card number", () => {
    const input = "My card is 4111 1111 1111 1111";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("credit_card"));
    assert.ok(result.redacted.includes("[REDACTED-CREDIT-CARD]"));
  });

  it("does not redact invalid Luhn number", () => {
    const input = "Number 1234 5678 9012 3456";
    const result = detectAndRedact(input);
    assert.ok(!result.redacted.includes("[REDACTED-CREDIT-CARD]"));
  });
});

describe("detectAndRedact — Phone", () => {
  it("redacts AU mobile near keyword", () => {
    const input = "My phone number is 0412 345 678";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("phone"));
    assert.ok(result.redacted.includes("[REDACTED-PHONE]"));
  });

  it("redacts +61 format near keyword", () => {
    const input = "call me at +61412 345 678";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("phone"));
  });

  it("does not redact phone without keyword", () => {
    const input = "The office is at 0412 345 678";
    const result = detectAndRedact(input);
    assert.ok(!result.types.includes("phone"));
  });
});

describe("detectAndRedact — DOB", () => {
  it("redacts date of birth near keyword", () => {
    const input = "My date of birth is 15/03/1990";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("dob"));
    assert.ok(result.redacted.includes("[REDACTED-DOB]"));
  });

  it("redacts with dob abbreviation", () => {
    const input = "dob 01-12-85";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("dob"));
  });
});

describe("detectAndRedact — Address", () => {
  it("redacts address near keyword", () => {
    const input = "My address is 42 George Street";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("address"));
    assert.ok(result.redacted.includes("[REDACTED-ADDRESS]"));
  });
});

describe("detectAndRedact — BSB / Bank Account", () => {
  it("redacts BSB near keyword", () => {
    const input = "My bsb is 062-000";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("bsb"));
    assert.ok(result.redacted.includes("[REDACTED-BSB]"));
  });

  it("redacts bank account near keyword", () => {
    const input = "My account number is 12345678";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("bank_account"));
    assert.ok(result.redacted.includes("[REDACTED-BANK-ACCOUNT]"));
  });
});

describe("detectAndRedact — No false positives", () => {
  it("does not redact normal conversation", () => {
    const input = "I have 3 kids and 2 dogs. My appointment is at 10 am on Tuesday.";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, false);
    assert.equal(result.redacted, input);
  });

  it("does not redact short numbers in normal context", () => {
    const input = "Please confirm appointment number 456789 for tomorrow.";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, false);
    assert.equal(result.redacted, input);
  });
});

describe("detectAndRedact — Multiple PII types in one text", () => {
  it("redacts multiple types", () => {
    const input = "My medicare number is 2345 67890 1 and my email is test@example.com";
    const result = detectAndRedact(input);
    assert.equal(result.piiFound, true);
    assert.ok(result.types.includes("medicare"));
    assert.ok(result.types.includes("email"));
    assert.ok(result.redacted.includes("[REDACTED-MEDICARE]"));
    assert.ok(result.redacted.includes("[REDACTED-EMAIL]"));
  });
});

describe("detectAndRedact — Null/empty input", () => {
  it("handles null input", () => {
    const result = detectAndRedact(null);
    assert.equal(result.redacted, null);
    assert.equal(result.piiFound, false);
  });

  it("handles undefined input", () => {
    const result = detectAndRedact(undefined);
    assert.equal(result.redacted, undefined);
    assert.equal(result.piiFound, false);
  });

  it("handles empty string", () => {
    const result = detectAndRedact("");
    assert.equal(result.redacted, "");
    assert.equal(result.piiFound, false);
  });
});

describe("redactObject", () => {
  it("redacts string values in flat objects", () => {
    const obj = { email: "contact@example.com", name: "John" };
    const result = redactObject(obj);
    assert.equal(result.piiFound, true);
    assert.equal(result.redacted.email, "[REDACTED-EMAIL]");
    assert.equal(result.redacted.name, "John");
  });

  it("redacts string values in nested objects", () => {
    const obj = {
      contact: {
        email: "test@example.com",
        details: { note: "Medicare is 2345 67890 1" },
      },
    };
    const result = redactObject(obj);
    assert.equal(result.piiFound, true);
    assert.ok(result.redacted.contact.email.includes("[REDACTED-EMAIL]"));
    assert.ok(result.redacted.contact.details.note.includes("[REDACTED-MEDICARE]"));
  });

  it("handles arrays", () => {
    const arr = ["test@example.com", "no pii here"];
    const result = redactObject(arr);
    assert.equal(result.piiFound, true);
    assert.ok(result.redacted[0].includes("[REDACTED-EMAIL]"));
    assert.equal(result.redacted[1], "no pii here");
  });

  it("handles null/non-object input", () => {
    assert.equal(redactObject(null).piiFound, false);
    assert.equal(redactObject(42).redacted, 42);
  });
});
