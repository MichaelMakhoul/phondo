"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

// SCRUM-597 (silent lens N6): when call-completed can't be reached for good, billing,
// notifications, webhooks and an owner's recap email are all lost — so the give-up
// lines are alertable ([ALERT:error]), not plain errors. Retries stay quiet.

const { notifyCallCompleted } = require("../lib/call-logger");

function capture() {
  const lines = [];
  const restore = [
    mock.method(console, "error", (...a) => lines.push(["error", a.map(String).join(" ")])),
    mock.method(console, "warn", (...a) => lines.push(["warn", a.map(String).join(" ")])),
  ];
  return { lines, restore: () => restore.forEach((m) => m.mock.restore()) };
}

describe("notifyCallCompleted: giving up is alertable", () => {
  it("a non-retryable error answer pages once, with the call id; nothing else does", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: false, status: 400, text: async () => "bad" }));
    const c = capture();
    try {
      await notifyCallCompleted("https://app.example.test", "s", { callId: "call-1", organizationId: "org-1" });
    } finally {
      c.restore();
      fetchMock.mock.restore();
    }
    const alerts = c.lines.filter(([, t]) => t.includes("[ALERT:error]"));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0][1], /post-call processing lost/);
  });

  it("network failures retry quietly, then page once when the retries run out", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("ECONNRESET"); });
    const timers = mock.method(globalThis, "setTimeout", (fn) => { fn(); return 0; });
    const c = capture();
    try {
      await notifyCallCompleted("https://app.example.test", "s", { callId: "call-1", organizationId: "org-1" });
    } finally {
      c.restore();
      timers.mock.restore();
      fetchMock.mock.restore();
    }
    assert.equal(c.lines.filter(([lvl]) => lvl === "warn").length, 2, "two quiet retries");
    const alerts = c.lines.filter(([, t]) => t.includes("[ALERT:error]"));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0][1], /any owner recap email lost/);
  });

  it("a 2xx answer: no alert", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, text: async () => "" }));
    const c = capture();
    try {
      await notifyCallCompleted("https://app.example.test", "s", { callId: "call-1", organizationId: "org-1" });
    } finally {
      c.restore();
      fetchMock.mock.restore();
    }
    assert.equal(c.lines.length, 0);
  });
});
