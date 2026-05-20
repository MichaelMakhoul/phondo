import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { isPiiKey, scrubObject, scrubSentryEvent } from "../sentry-scrub";

describe("isPiiKey (SCRUM-312)", () => {
  it("matches PII-named keys (case-insensitive, substring + anchored)", () => {
    for (const k of [
      "phone", "callerPhone", "email", "address", "transcript",
      "to", "from", "firstName", "last_name", "name", "dob", "dateOfBirth",
      "responseBody",
    ]) {
      expect(isPiiKey(k), k).toBe(true);
    }
  });

  it("does NOT match safe technical keys", () => {
    for (const k of [
      "orgId", "callSid", "upstreamStatus", "voiceId", "businessIdCount",
      "failureKind", "reason", "service", "code", "limit",
    ]) {
      expect(isPiiKey(k), k).toBe(false);
    }
  });
});

describe("scrubObject (SCRUM-312)", () => {
  it("replaces PII-keyed values with [scrubbed], leaves safe keys", () => {
    const out = scrubObject({ phone: "+61400000000", orgId: "uuid-1" }) as Record<string, unknown>;
    expect(out.phone).toBe("[scrubbed]");
    expect(out.orgId).toBe("uuid-1");
  });

  it("truncates long non-PII strings to 200 chars + marker", () => {
    const long = "x".repeat(500);
    const out = scrubObject({ note: long }) as Record<string, string>;
    expect(out.note).toBe("x".repeat(200) + "...[truncated]");
  });

  it("recurses into nested objects and arrays", () => {
    const out = scrubObject({
      nested: { email: "a@b.com", safe: 1 },
      list: [{ firstName: "Ada" }],
    }) as any;
    expect(out.nested.email).toBe("[scrubbed]");
    expect(out.nested.safe).toBe(1);
    expect(out.list[0].firstName).toBe("[scrubbed]");
  });

  it("fails CLOSED past depth 5 — deep value replaced with the sentinel (no PII leak)", () => {
    // 6+ levels deep: the inner object is replaced by the sentinel
    // rather than passed through, so deeply-nested PII never leaks.
    const deep = { a: { b: { c: { d: { e: { f: { email: "x@y.com" } } } } } } };
    const out = scrubObject(deep) as any;
    expect(out.a.b.c.d.e.f).toBe("[depth-capped]");
  });

  it("terminates on a cyclic object without throwing (depth cap bounds it)", () => {
    const cyclic: Record<string, unknown> = { safe: 1 };
    cyclic.self = cyclic;
    let out: any;
    expect(() => {
      out = scrubObject(cyclic);
    }).not.toThrow();
    expect(out.safe).toBe(1);
    // The cycle terminates at the sentinel rather than recursing forever.
    expect(out.self.self.self.self.self.self).toBe("[depth-capped]");
  });
});

describe("scrubSentryEvent (SCRUM-312)", () => {
  it("reduces user to just the id (drops email/username/ip)", () => {
    const event = {
      user: { id: "user-uuid", email: "a@b.com", username: "ada", ip_address: "1.2.3.4" },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event);
    expect(out.user).toEqual({ id: "user-uuid" });
  });

  it("empties user when there is no id", () => {
    const event = { user: { email: "a@b.com" } } as unknown as ErrorEvent;
    expect(scrubSentryEvent(event).user).toEqual({});
  });

  it("deletes request.data + cookies + query_string, strips the URL query, and strips sensitive headers (case-insensitive)", () => {
    const event = {
      request: {
        data: { text: "my phone is +61400000000" },
        cookies: "session=secret",
        query_string: "email=a@b.com&phone=+61400000000",
        url: "https://app.phondo.ai/booking?email=a@b.com",
        headers: {
          // Mixed case — exercises the .toLowerCase() match path.
          "X-Internal-Secret": "shh",
          Authorization: "Bearer t",
          COOKIE: "session=secret",
          "content-type": "application/json",
        },
      },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event);
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    // Query string stripped, path preserved.
    expect(out.request?.url).toBe("https://app.phondo.ai/booking");
    expect(out.request?.headers).toEqual({ "content-type": "application/json" });
  });

  it("scrubs contexts (custom setContext PII) while keeping safe keys", () => {
    const event = {
      contexts: {
        booking: { callerPhone: "+61400000000", appointmentId: "appt-1" },
      },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event) as any;
    expect(out.contexts.booking.callerPhone).toBe("[scrubbed]");
    expect(out.contexts.booking.appointmentId).toBe("appt-1");
  });

  it("scrubs breadcrumbs: strips crumb URL query, scrubs crumb data, truncates long messages", () => {
    const event = {
      breadcrumbs: [
        {
          category: "fetch",
          data: { url: "https://app.phondo.ai/api?phone=+61400000000", status_code: 500 },
        },
        { category: "console", message: "z".repeat(400) },
      ],
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event) as any;
    expect(out.breadcrumbs[0].data.url).toBe("https://app.phondo.ai/api");
    expect(out.breadcrumbs[0].data.status_code).toBe(500);
    expect(out.breadcrumbs[1].message).toBe("z".repeat(200) + "...[truncated]");
  });

  it("runs the field-name scrubber over extra (PII scrubbed, safe kept)", () => {
    const event = {
      extra: { callerPhone: "+61400000000", upstreamStatus: 502, voiceId: "nova" },
    } as unknown as ErrorEvent;
    const out = scrubSentryEvent(event);
    expect(out.extra).toEqual({
      callerPhone: "[scrubbed]",
      upstreamStatus: 502,
      voiceId: "nova",
    });
  });

  it("is a no-op-safe passthrough when there is no user/request/extra", () => {
    const event = { message: "boom" } as unknown as ErrorEvent;
    expect(scrubSentryEvent(event)).toEqual({ message: "boom" });
  });

  it("fails CLOSED if scrubbing throws — minimal event, never the raw payload, never throws", () => {
    // An event whose `extra` getter throws simulates an exotic shape
    // that breaks the scrubber. Sentry would drop the original + leak
    // via the internal-exception path if we threw, so we must return a
    // sanitised minimal event instead.
    const event = {
      event_id: "evt-1",
      timestamp: 1_700_000_000,
      level: "error",
      platform: "javascript",
      exception: { values: [{ type: "TypeError", value: "leaky +61400000000" }] },
      extra: {} as Record<string, unknown>,
    } as unknown as ErrorEvent;
    Object.defineProperty(event, "extra", {
      get() {
        throw new Error("boom accessing extra");
      },
    });

    let out: ErrorEvent | null = null;
    expect(() => {
      out = scrubSentryEvent(event);
    }).not.toThrow();
    expect(out!.event_id).toBe("evt-1");
    expect(out!.tags).toEqual({ scrubber_failed: "true" });
    // Exception TYPE preserved, but NOT the value (which carried PII).
    expect(out!.exception?.values?.[0]).toEqual({ type: "TypeError" });
    expect(JSON.stringify(out)).not.toContain("+61400000000");
  });

  it("fails CLOSED to a fully-static envelope when even the minimal read throws (throwing getters everywhere)", () => {
    // Both scrubInternal AND buildFailClosedEvent's reads throw — the
    // last-resort envelope must touch nothing on `event` and still not
    // throw or leak.
    const event = {} as unknown as ErrorEvent;
    for (const field of ["extra", "event_id", "exception", "level", "platform", "timestamp"]) {
      Object.defineProperty(event, field, {
        get() {
          throw new Error(`boom +61400000000 (${field})`);
        },
      });
    }
    let out: ErrorEvent | null = null;
    expect(() => {
      out = scrubSentryEvent(event);
    }).not.toThrow();
    expect(out!.tags).toEqual({ scrubber_failed: "true" });
    expect(JSON.stringify(out)).not.toContain("+61400000000");
  });
});
