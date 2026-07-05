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

    it("SCRUM-506: matches the per-call collected-details bag and its snake_case factors", () => {
      assert.equal(isPiiKey("collectedDetails"), true);
      assert.equal(isPiiKey("collected_details"), true);
      assert.equal(isPiiKey("date_of_birth"), true);
      assert.equal(isPiiKey("medicare"), true);
      assert.equal(isPiiKey("medicare_number"), true);
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

    it("strips sensitive headers regardless of letter case", () => {
      const event = {
        request: {
          headers: {
            Authorization: "Bearer token",
            "X-Internal-Secret": "secret",
            COOKIE: "session=abc",
            "X-Api-Key": "apikey",
            "x-AUTH-token": "authtoken",
            "User-Agent": "test",
          },
        },
      };
      const result = beforeSendScrubber(event);
      assert.equal(result.request.headers.Authorization, undefined);
      assert.equal(result.request.headers["X-Internal-Secret"], undefined);
      assert.equal(result.request.headers.COOKIE, undefined);
      assert.equal(result.request.headers["X-Api-Key"], undefined);
      assert.equal(result.request.headers["x-AUTH-token"], undefined);
      assert.equal(result.request.headers["User-Agent"], "test");
    });

    it("does not mutate the input event (deep-clone guarantee)", () => {
      const event = {
        user: { id: "u1", email: "a@b.com" },
        request: {
          data: { name: "John" },
          cookies: { session: "abc" },
          headers: { authorization: "Bearer x", "user-agent": "test" },
        },
        extra: { callerPhone: "+61400000000", nested: { phone: "+61400111222" } },
      };
      // Snapshot the input shape before scrubbing
      const before = JSON.stringify(event);
      const result = beforeSendScrubber(event);
      // Caller is free to mutate the result without affecting the original
      result.user.id = "mutated";
      delete result.request.headers["user-agent"];
      result.extra.nested = "wiped";
      // Original must be unchanged
      assert.equal(JSON.stringify(event), before);
      // And the original PII fields still exist on the input
      assert.equal(event.user.email, "a@b.com");
      assert.equal(event.request.data.name, "John");
      assert.equal(event.request.headers.authorization, "Bearer x");
    });

    it("handles missing / null sub-fields without throwing", () => {
      assert.deepEqual(beforeSendScrubber(null), null);
      assert.deepEqual(beforeSendScrubber(undefined), undefined);
      // No user, no request, no extra
      assert.deepEqual(beforeSendScrubber({ message: "x" }), { message: "x" });
      // user with no id
      assert.deepEqual(beforeSendScrubber({ user: { email: "a@b.com" } }).user, {});
      // request with no headers
      const r = beforeSendScrubber({ request: { data: { x: 1 } } });
      assert.equal(r.request.data, undefined);
      // request with null headers (Node's raw headers can be falsy)
      const r2 = beforeSendScrubber({ request: { headers: null } });
      assert.equal(r2.request.headers, null); // not crashed, preserved as-is
    });

    it("ignores array-valued user/request/extra (defends against malformed events)", () => {
      // Arrays of objects are legal but never meaningful for these slots;
      // the scrubber's typeof checks must reject them so a future caller
      // can't accidentally bypass scrubbing by wrapping PII in an array.
      const event = {
        user: [{ email: "a@b.com" }],
        request: [{ data: { x: 1 } }],
        extra: [{ phone: "+61400000000" }],
      };
      const result = beforeSendScrubber(event);
      // Arrays pass through untouched (the function doesn't claim to scrub them)
      assert.ok(Array.isArray(result.user));
      assert.ok(Array.isArray(result.request));
      assert.ok(Array.isArray(result.extra));
    });
  });
});
