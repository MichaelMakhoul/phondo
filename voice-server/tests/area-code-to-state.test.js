const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { getStateFromPhone, AREA_CODE_TO_STATE } = require("../lib/area-code-to-state");

describe("getStateFromPhone", () => {
  it("returns CA for a California area code (E.164)", () => {
    assert.equal(getStateFromPhone("+14155551234"), "CA");
  });

  it("returns CA for a California area code (10-digit)", () => {
    assert.equal(getStateFromPhone("4155551234"), "CA");
  });

  it("returns CA for a California area code (11-digit)", () => {
    assert.equal(getStateFromPhone("14155551234"), "CA");
  });

  it("returns NY for a New York area code", () => {
    assert.equal(getStateFromPhone("+12125551234"), "NY");
  });

  it("returns TX for a Texas area code", () => {
    assert.equal(getStateFromPhone("+12145551234"), "TX");
  });

  it("returns FL for a Florida area code", () => {
    assert.equal(getStateFromPhone("+13055551234"), "FL");
  });

  it("returns IL for an Illinois area code", () => {
    assert.equal(getStateFromPhone("+13125551234"), "IL");
  });

  it("returns WA for a Washington area code", () => {
    assert.equal(getStateFromPhone("+12065551234"), "WA");
  });

  it("returns PA for a Pennsylvania area code", () => {
    assert.equal(getStateFromPhone("+12155551234"), "PA");
  });

  it("returns MA for a Massachusetts area code", () => {
    assert.equal(getStateFromPhone("+16175551234"), "MA");
  });

  it("returns null for non-US numbers (AU)", () => {
    assert.equal(getStateFromPhone("+61412345678"), null);
  });

  it("returns null for non-US numbers (UK)", () => {
    assert.equal(getStateFromPhone("+442071234567"), null);
  });

  it("returns null for null input", () => {
    assert.equal(getStateFromPhone(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(getStateFromPhone(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(getStateFromPhone(""), null);
  });

  it("returns null for too-short number", () => {
    assert.equal(getStateFromPhone("415"), null);
  });

  it("returns null for unknown area code", () => {
    assert.equal(getStateFromPhone("+19995551234"), null);
  });

  it("handles phone numbers with formatting characters", () => {
    assert.equal(getStateFromPhone("+1 (415) 555-1234"), "CA");
  });

  it("returns DC for Washington DC area code", () => {
    assert.equal(getStateFromPhone("+12025551234"), "DC");
  });

  it("returns AK for Alaska", () => {
    assert.equal(getStateFromPhone("+19075551234"), "AK");
  });

  it("returns HI for Hawaii", () => {
    assert.equal(getStateFromPhone("+18085551234"), "HI");
  });
});

describe("AREA_CODE_TO_STATE coverage", () => {
  it("covers all 50 states + DC", () => {
    const states = new Set(Object.values(AREA_CODE_TO_STATE));
    const expected = [
      "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
      "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
      "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
      "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
      "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    ];
    for (const state of expected) {
      assert.ok(states.has(state), `Missing state: ${state}`);
    }
  });
});
