const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { requiresRecordingDisclosureHybrid } = require("../lib/recording-consent");

describe("requiresRecordingDisclosureHybrid", () => {
  // Consent mode overrides
  describe("consent mode overrides", () => {
    it("consent_mode=always always requires disclosure", () => {
      const result = requiresRecordingDisclosureHybrid("US", "TX", "always", "+12145551234");
      assert.equal(result.required, true);
      assert.equal(result.reason, "consent_mode_always");
    });

    it("consent_mode=never never requires disclosure", () => {
      const result = requiresRecordingDisclosureHybrid("US", "CA", "never", "+14155551234");
      assert.equal(result.required, false);
      assert.equal(result.reason, "consent_mode_never");
    });

    it("consent_mode=always still detects caller state", () => {
      const result = requiresRecordingDisclosureHybrid("US", "TX", "always", "+14155551234");
      assert.equal(result.callerState, "CA");
    });
  });

  // Australia
  describe("Australia", () => {
    it("AU always requires disclosure", () => {
      const result = requiresRecordingDisclosureHybrid("AU", "NSW", "auto", "+61412345678");
      assert.equal(result.required, true);
      assert.equal(result.reason, "au_required");
    });

    it("AU with US caller still requires disclosure", () => {
      const result = requiresRecordingDisclosureHybrid("AU", "NSW", "auto", "+14155551234");
      assert.equal(result.required, true);
      assert.equal(result.reason, "au_required");
      assert.equal(result.callerState, "CA");
    });
  });

  // US hybrid consent
  describe("US hybrid consent", () => {
    it("caller in CA + org in TX → disclose (caller_two_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "TX", "auto", "+14155551234");
      assert.equal(result.required, true);
      assert.equal(result.callerState, "CA");
      assert.equal(result.reason, "caller_two_party");
    });

    it("org in CA + caller in TX → disclose (org_two_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "CA", "auto", "+12145551234");
      assert.equal(result.required, true);
      assert.equal(result.callerState, "TX");
      assert.equal(result.reason, "org_two_party");
    });

    it("both in CA → disclose (both_two_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "CA", "auto", "+14155551234");
      assert.equal(result.required, true);
      assert.equal(result.callerState, "CA");
      assert.equal(result.reason, "both_two_party");
    });

    it("both in TX → no disclosure (both_one_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "TX", "auto", "+12145551234");
      assert.equal(result.required, false);
      assert.equal(result.callerState, "TX");
      assert.equal(result.reason, "both_one_party");
    });

    it("org in FL (two-party) + caller in NY → disclose (org_two_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "FL", "auto", "+12125551234");
      assert.equal(result.required, true);
      assert.equal(result.callerState, "NY");
      assert.equal(result.reason, "org_two_party");
    });

    it("org in NY + caller in WA (two-party) → disclose (caller_two_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "NY", "auto", "+12065551234");
      assert.equal(result.required, true);
      assert.equal(result.callerState, "WA");
      assert.equal(result.reason, "caller_two_party");
    });

    it("org in NY + caller in NY → no disclosure (both_one_party)", () => {
      const result = requiresRecordingDisclosureHybrid("US", "NY", "auto", "+12125551234");
      assert.equal(result.required, false);
      assert.equal(result.callerState, "NY");
      assert.equal(result.reason, "both_one_party");
    });
  });

  // Edge cases
  describe("edge cases", () => {
    it("handles null caller phone gracefully", () => {
      const result = requiresRecordingDisclosureHybrid("US", "CA", "auto", null);
      assert.equal(result.required, true);
      assert.equal(result.callerState, null);
      assert.equal(result.reason, "org_two_party");
    });

    it("handles non-US caller with US org in two-party state", () => {
      const result = requiresRecordingDisclosureHybrid("US", "CA", "auto", "+61412345678");
      assert.equal(result.required, true);
      assert.equal(result.callerState, null);
      assert.equal(result.reason, "org_two_party");
    });

    it("handles non-US caller with US org in one-party state", () => {
      const result = requiresRecordingDisclosureHybrid("US", "TX", "auto", "+61412345678");
      assert.equal(result.required, false);
      assert.equal(result.callerState, null);
      assert.equal(result.reason, "both_one_party");
    });

    it("handles null org state with two-party caller", () => {
      const result = requiresRecordingDisclosureHybrid("US", null, "auto", "+14155551234");
      assert.equal(result.required, true);
      assert.equal(result.callerState, "CA");
      assert.equal(result.reason, "caller_two_party");
    });
  });

  // All two-party consent states
  describe("all two-party consent states detected from caller", () => {
    const twoPartyStates = {
      CA: "+14155551234",
      CT: "+12035551234",
      FL: "+13055551234",
      IL: "+13125551234",
      MD: "+12405551234",
      MA: "+16175551234",
      MT: "+14065551234",
      NV: "+17025551234",
      NH: "+16035551234",
      PA: "+12155551234",
      WA: "+12065551234",
    };

    for (const [state, phone] of Object.entries(twoPartyStates)) {
      it(`detects ${state} as two-party consent from caller phone`, () => {
        const result = requiresRecordingDisclosureHybrid("US", "TX", "auto", phone);
        assert.equal(result.required, true, `${state} should require disclosure`);
        assert.equal(result.callerState, state);
        assert.equal(result.reason, "caller_two_party");
      });
    }
  });
});
