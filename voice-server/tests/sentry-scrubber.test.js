const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../lib/sentry");
const { scrubObject, isPiiKey, beforeSendScrubber } = _test;

describe("sentry PII scrubber", () => {
  describe("isPiiKey", () => {
    it("matches phone-related keys", () => {
      assert.equal(isPiiKey("phone"), true);
      assert.equal(isPiiKey("callerPhone"), true);
      assert.equal(isPiiKey("transferTo"), true);
      assert.equal(isPiiKey("to"), true);
      assert.equal(isPiiKey("from"), true);
    });

    it("matches name keys", () => {
      assert.equal(isPiiKey("name"), true);
      assert.equal(isPiiKey("firstName"), true);
      assert.equal(isPiiKey("last_name"), true);
      assert.equal(isPiiKey("attendee_name"), true);
      assert.equal(isPiiKey("ruleName"), true);
    });

    it("matches transcript / email / address keys", () => {
      assert.equal(isPiiKey("transcript"), true);
      assert.equal(isPiiKey("email"), true);
      assert.equal(isPiiKey("address"), true);
      assert.equal(isPiiKey("dateOfBirth"), true);
      assert.equal(isPiiKey("responseBody"), true);
      assert.equal(isPiiKey("responseContent"), true);
    });

    it("does not match safe technical keys", () => {
      assert.equal(isPiiKey("organizationId"), false);
      assert.equal(isPiiKey("assistantId"), false);
      assert.equal(isPiiKey("callId"), false);
      assert.equal(isPiiKey("callSid"), false);
      assert.equal(isPiiKey("httpStatus"), false);
      assert.equal(isPiiKey("service"), false);
      assert.equal(isPiiKey("tool_function"), false);
    });
  });

  describe("scrubObject", () => {
    it("replaces PII field values with [scrubbed]", () => {
      const input = {
        callSid: "CA123",
        phone: "+61400000000",
        callerPhone: "+61400111222",
        organizationId: "org-uuid",
      };
      const result = scrubObject(input);
      assert.equal(result.callSid, "CA123");
      assert.equal(result.organizationId, "org-uuid");
      assert.equal(result.phone, "[scrubbed]");
      assert.equal(result.callerPhone, "[scrubbed]");
    });

    it("handles nested objects", () => {
      const input = {
        callSid: "CA123",
        caller: {
          phone: "+61400000000",
          name: "John Smith",
          organizationId: "org-uuid",
        },
      };
      const result = scrubObject(input);
      assert.equal(result.callSid, "CA123");
      assert.equal(result.caller.phone, "[scrubbed]");
      assert.equal(result.caller.name, "[scrubbed]");
      assert.equal(result.caller.organizationId, "org-uuid");
    });

    it("handles arrays", () => {
      const input = {
        destinations: [
          { phone: "+61400000000", name: "Office" },
          { phone: "+61400000001", name: "Mobile" },
        ],
      };
      const result = scrubObject(input);
      assert.equal(result.destinations[0].phone, "[scrubbed]");
      assert.equal(result.destinations[0].name, "[scrubbed]");
      assert.equal(result.destinations[1].phone, "[scrubbed]");
    });

    it("truncates long string values", () => {
      const longString = "a".repeat(500);
      const result = scrubObject({ responseStatus: longString });
      assert.ok(result.responseStatus.length <= 230, "should be truncated to ~200 chars + truncation marker");
      assert.ok(result.responseStatus.endsWith("[truncated]"));
    });

    it("does not modify primitives and null", () => {
      const result = scrubObject({ count: 42, enabled: true, tag: null });
      assert.equal(result.count, 42);
      assert.equal(result.enabled, true);
      assert.equal(result.tag, null);
    });

    it("does not recurse infinitely", () => {
      const circular = { callSid: "CA123" };
      circular.self = circular;
      // Should not throw
      const result = scrubObject(circular);
      assert.equal(result.callSid, "CA123");
    });
  });

  describe("beforeSendScrubber", () => {
    it("scrubs extra fields", () => {
      const event = {
        message: "Tool error",
        extra: {
          organizationId: "org-uuid",
          transferTo: "+61400000000",
          callerPhone: "+61400111222",
          httpStatus: 500,
        },
      };
      const result = beforeSendScrubber(event);
      assert.equal(result.extra.organizationId, "org-uuid");
      assert.equal(result.extra.httpStatus, 500);
      assert.equal(result.extra.transferTo, "[scrubbed]");
      assert.equal(result.extra.callerPhone, "[scrubbed]");
    });

    it("strips user PII fields", () => {
      const event = {
        user: {
          id: "user-uuid",
          email: "john@example.com",
          ip_address: "1.2.3.4",
          username: "john",
        },
      };
      const result = beforeSendScrubber(event);
      assert.equal(result.user.id, "user-uuid");
      assert.equal(result.user.email, undefined);
      assert.equal(result.user.ip_address, undefined);
      assert.equal(result.user.username, undefined);
    });

    it("strips request body and secrets", () => {
      const event = {
        request: {
          data: { name: "John", phone: "+61400000000" },
          cookies: { session: "abc" },
          headers: {
            "x-internal-secret": "secret-value",
            authorization: "Bearer token",
            cookie: "session=abc",
            "user-agent": "test",
          },
        },
      };
      const result = beforeSendScrubber(event);
      assert.equal(result.request.data, undefined);
      assert.equal(result.request.cookies, undefined);
      assert.equal(result.request.headers["x-internal-secret"], undefined);
      assert.equal(result.request.headers.authorization, undefined);
      assert.equal(result.request.headers.cookie, undefined);
      assert.equal(result.request.headers["user-agent"], "test");
    });

    it("preserves message and error details", () => {
      const event = {
        message: "Tool error",
        exception: { values: [{ type: "TypeError", value: "Cannot read property x of null" }] },
      };
      const result = beforeSendScrubber(event);
      assert.equal(result.message, "Tool error");
      assert.deepEqual(result.exception, { values: [{ type: "TypeError", value: "Cannot read property x of null" }] });
    });
  });
});
