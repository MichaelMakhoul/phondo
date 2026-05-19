const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildFallbackDisclosureSay } = require("../lib/fallback-dial-consent");

// Match server.js — escapeXml replaces &, <, >, ", '
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function makePhoneRecord(orgOverrides = {}) {
  return {
    id: "ph-1",
    organization_id: "org-1",
    organizations: {
      name: "Acme Dental",
      country: "US",
      business_state: null,
      recording_consent_mode: "auto",
      recording_disclosure_text: null,
      ...orgOverrides,
    },
  };
}

/**
 * Run fn() and capture [ALERT:...] structured-log lines emitted by the
 * Sentry shim. The shim writes captureException to console.error and
 * captureMessage(level=warning) to console.warn — both intercepted here so
 * test output stays clean and assertions can see either flavor.
 */
function runAndCaptureAlerts(fn) {
  const alerts = [];
  const origError = console.error;
  const origWarn = console.warn;
  const capture = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    if (line.startsWith("[ALERT:")) alerts.push(line);
  };
  console.error = capture;
  console.warn = capture;
  try {
    return { result: fn(), alerts };
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
}

describe("buildFallbackDisclosureSay", () => {
  describe("plays disclosure for two-party consent jurisdictions (auto mode)", () => {
    it("AU org → discloses with AU default text", () => {
      const phoneRecord = makePhoneRecord({ country: "AU", business_state: "NSW" });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+14155551234", // CA caller
        escapeXml,
      });
      assert.ok(result.includes("<Say"), "should emit a <Say>");
      // AU-specific default begins "Please note, this call may be recorded for quality and training purposes."
      assert.ok(result.includes("Please note, this call may be recorded"), `expected AU default, got: ${result}`);
      assert.ok(result.endsWith("</Say>\n"), "should be a complete element with trailing newline");
    });

    it("US org in CA + US caller in TX → discloses with US default text (org_two_party)", () => {
      const phoneRecord = makePhoneRecord({ country: "US", business_state: "CA" });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+12145551234",
        escapeXml,
      });
      assert.ok(result.length > 0, "should disclose");
      // US default begins "This call may be recorded for quality assurance."
      assert.ok(result.includes("This call may be recorded for quality assurance"), `expected US default, got: ${result}`);
    });

    it("US org in TX + US caller in CA → discloses (caller_two_party)", () => {
      const phoneRecord = makePhoneRecord({ country: "US", business_state: "TX" });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+14155551234",
        escapeXml,
      });
      assert.ok(result.length > 0, "caller-side two-party still requires disclosure");
    });
  });

  describe("does NOT play disclosure", () => {
    it("US org in TX + US caller in TX (both one-party)", () => {
      const phoneRecord = makePhoneRecord({ country: "US", business_state: "TX" });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+12145551234",
        escapeXml,
      });
      assert.equal(result, "", "should be empty — neither party in two-party state");
    });

    it("consent_mode=never overrides everything (including AU)", () => {
      const phoneRecord = makePhoneRecord({
        country: "AU",
        business_state: "NSW",
        recording_consent_mode: "never",
      });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+61412345678",
        escapeXml,
      });
      assert.equal(result, "", "never mode wins over jurisdiction");
    });
  });

  describe("missing org context (compliance breadcrumb path)", () => {
    it("returns empty string AND emits a Sentry warning when organizations is missing", () => {
      const { result, alerts } = runAndCaptureAlerts(() =>
        buildFallbackDisclosureSay({
          phoneRecord: { id: "ph-1", organization_id: "org-1" }, // no organizations
          callerPhone: "+14155551234",
          escapeXml,
          callSid: "CA_TEST_999",
        }),
      );
      assert.equal(result, "");
      const alert = alerts.find((l) => l.includes("reason=disclosure-org-missing"));
      assert.ok(alert, `expected disclosure-org-missing alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:warning]"), `expected warning level, got: ${alert}`);
      assert.ok(alert.includes("callSid=CA_TEST_999"), "callSid should be in extras");
    });

    it("null phoneRecord → empty string AND Sentry warning", () => {
      const { result, alerts } = runAndCaptureAlerts(() =>
        buildFallbackDisclosureSay({
          phoneRecord: null,
          callerPhone: "+14155551234",
          escapeXml,
        }),
      );
      assert.equal(result, "");
      assert.ok(alerts.some((l) => l.includes("reason=disclosure-org-missing")));
    });
  });

  describe("internal throw → fail-closed-on-disclosure (compliance miss) but still returns empty", () => {
    it("does not bubble; Sentry-pages instead", () => {
      // Pass an escapeXml that throws on the disclosure text only, simulating
      // a downstream defect. The helper must swallow and return "".
      let escapeXmlCallCount = 0;
      const throwingEscape = () => {
        escapeXmlCallCount++;
        throw new Error("simulated escapeXml defect");
      };
      const phoneRecord = makePhoneRecord({ country: "AU", business_state: "NSW" });
      const { result, alerts } = runAndCaptureAlerts(() =>
        buildFallbackDisclosureSay({
          phoneRecord,
          callerPhone: "+61412345678",
          escapeXml: throwingEscape,
          callSid: "CA_THROW",
        }),
      );
      assert.equal(result, "", "must not bubble — Dial still happens, just no disclosure");
      assert.ok(escapeXmlCallCount > 0, "escapeXml should have been called");
      const alert = alerts.find((l) => l.includes("reason=disclosure-build-failed"));
      assert.ok(alert, `expected disclosure-build-failed alert, got: ${alerts.join("\n")}`);
      assert.ok(alert.startsWith("[ALERT:warning]"));
      assert.ok(alert.includes("simulated escapeXml defect"));
    });
  });

  describe("always forces disclosure", () => {
    it("consent_mode=always plays disclosure even for one-party US states", () => {
      const phoneRecord = makePhoneRecord({
        country: "US",
        business_state: "TX",
        recording_consent_mode: "always",
      });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+12145551234",
        escapeXml,
      });
      assert.ok(result.length > 0);
      assert.ok(result.includes("This call may be recorded"));
    });
  });

  describe("custom disclosure text", () => {
    it("uses recording_disclosure_text from org when set", () => {
      const phoneRecord = makePhoneRecord({
        country: "AU",
        business_state: "NSW",
        recording_disclosure_text: "Welcome to {business_name}. This call is monitored.",
      });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+61412345678",
        escapeXml,
      });
      assert.ok(result.includes("Welcome to Acme Dental"), "should substitute {business_name}");
      assert.ok(result.includes("This call is monitored"));
      assert.ok(!result.includes("{business_name}"), "placeholder must be replaced");
    });

    it("XML-escapes special characters in disclosure text", () => {
      const phoneRecord = makePhoneRecord({
        country: "AU",
        business_state: "NSW",
        recording_disclosure_text: 'Recording <enabled> & legal in "all" states.',
      });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+61412345678",
        escapeXml,
      });
      assert.ok(result.includes("&lt;enabled&gt;"));
      assert.ok(result.includes("&amp;"));
      assert.ok(result.includes("&quot;all&quot;"));
      assert.ok(!result.includes("<enabled>"), "raw < > must be escaped");
    });
  });

  describe("output shape", () => {
    it("produces a Say element on its own line, indented two spaces — ready to drop between Response and Dial", () => {
      const phoneRecord = makePhoneRecord({ country: "AU", business_state: "NSW" });
      const result = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+61412345678",
        escapeXml,
      });
      assert.match(result, /^ {2}<Say voice="Polly\.Joanna">.+<\/Say>\n$/);
    });
  });

  /**
   * Integration test — verify the assembled TwiML/TeXML response (using the
   * exact template literals from server.js) is well-formed and has <Say>
   * BEFORE <Dial>. A future refactor that drops the trailing \n in the helper
   * or reformats the template will trip these.
   */
  describe("assembled TwiML/TeXML response integration", () => {
    // Mirrors server.js /twiml fallback template.
    function buildTwimlResponse(disclosureSay, from, action, fallback) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${disclosureSay}  <Dial callerId="${escapeXml(from)}" timeout="30" action="${escapeXml(action)}">
    ${escapeXml(fallback)}
  </Dial>
</Response>`;
    }

    function isWellFormed(xml) {
      // Minimal well-formedness: every opening tag has a matching close
      // (or is self-closing) and tags don't interleave incorrectly.
      const tagRe = /<(\/?)([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?(\/?)>/g;
      const stack = [];
      let m;
      while ((m = tagRe.exec(xml)) !== null) {
        const isClose = m[1];
        const name = m[2];
        const selfClose = m[3];
        if (selfClose) continue;
        if (isClose) {
          if (stack.pop() !== name) return false;
        } else {
          stack.push(name);
        }
      }
      return stack.length === 0;
    }

    it("AU org assembles into well-formed TwiML with <Say> before <Dial>", () => {
      const phoneRecord = makePhoneRecord({ country: "AU", business_state: "NSW" });
      const disclosureSay = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+61412345678",
        escapeXml,
      });
      const xml = buildTwimlResponse(
        disclosureSay,
        "+61412345678",
        "https://phondo-voice.fly.dev/twiml/ai-disabled-fallback-status",
        "+61400000000",
      );
      assert.ok(isWellFormed(xml), `assembled XML not well-formed:\n${xml}`);
      const sayIdx = xml.indexOf("<Say");
      const dialIdx = xml.indexOf("<Dial");
      assert.notEqual(sayIdx, -1, "<Say> must be present for AU jurisdiction");
      assert.ok(sayIdx < dialIdx, `<Say> must come before <Dial>, got Say@${sayIdx} Dial@${dialIdx}`);
    });

    it("TX-only one-party assembles into well-formed TwiML with no <Say>", () => {
      const phoneRecord = makePhoneRecord({ country: "US", business_state: "TX" });
      const disclosureSay = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: "+12145551234",
        escapeXml,
      });
      const xml = buildTwimlResponse(
        disclosureSay,
        "+12145551234",
        "https://phondo-voice.fly.dev/twiml/ai-disabled-fallback-status",
        "+12145559999",
      );
      assert.ok(isWellFormed(xml), `assembled XML not well-formed:\n${xml}`);
      assert.equal(xml.indexOf("<Say"), -1, "TX one-party must not include a <Say>");
      assert.ok(xml.indexOf("<Dial") !== -1, "<Dial> still present");
    });

    it("missing org assembles into well-formed TwiML with no <Say> (skipped, breadcrumb emitted)", () => {
      const { result: disclosureSay } = runAndCaptureAlerts(() =>
        buildFallbackDisclosureSay({
          phoneRecord: null,
          callerPhone: "+12145551234",
          escapeXml,
        }),
      );
      const xml = buildTwimlResponse(
        disclosureSay,
        "+12145551234",
        "https://phondo-voice.fly.dev/twiml/ai-disabled-fallback-status",
        "+12145559999",
      );
      assert.ok(isWellFormed(xml), `assembled XML not well-formed:\n${xml}`);
      assert.equal(xml.indexOf("<Say"), -1);
    });
  });
});
