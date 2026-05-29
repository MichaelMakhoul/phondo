const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAudioSessionGuard } = require("../lib/audio-session-guard");

// A deterministic fake timer harness so the auth-deadline reaper can be tested
// without real time. setTimer returns an id; fire(id) runs that callback once;
// fireAll() runs every still-pending callback.
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimer(fn) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    fire(id) {
      const fn = pending.get(id);
      if (fn) {
        pending.delete(id);
        fn();
      }
    },
    fireAll() {
      for (const [id, fn] of [...pending.entries()]) {
        pending.delete(id);
        fn();
      }
    },
    pendingCount() {
      return pending.size;
    },
  };
}

// ── concurrency ceiling ───────────────────────────────────────────────────────

test("acquire returns a controller under capacity and counts active sessions", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 3, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal(guard.stats().active, 0);
  const a = guard.acquire(() => {});
  const b = guard.acquire(() => {});
  assert.ok(a && b);
  assert.equal(guard.stats().active, 2);
});

test("acquire returns null once the concurrent ceiling is reached", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 2, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.ok(guard.acquire(() => {}));
  assert.ok(guard.acquire(() => {}));
  assert.equal(guard.acquire(() => {}), null);
  assert.equal(guard.stats().active, 2);
});

test("release frees a slot so a rejected-at-capacity connection can later acquire", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 1, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const a = guard.acquire(() => {});
  assert.equal(guard.acquire(() => {}), null);
  a.release();
  assert.equal(guard.stats().active, 0);
  assert.ok(guard.acquire(() => {}));
});

test("release is idempotent — a double release does not double-decrement", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 5, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const a = guard.acquire(() => {});
  guard.acquire(() => {});
  a.release();
  a.release();
  assert.equal(guard.stats().active, 1);
});

test("active count floors at 0 and never goes negative", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 5, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const a = guard.acquire(() => {});
  a.release();
  a.release();
  assert.equal(guard.stats().active, 0);
});

// ── auth-deadline reaper ──────────────────────────────────────────────────────

test("auth timeout fires onAuthTimeout for a connection that never authenticates", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 5, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  let reaped = false;
  guard.acquire(() => { reaped = true; });
  t.fireAll();
  assert.equal(reaped, true);
});

test("markAuthenticated cancels the reaper — onAuthTimeout never fires for a real call", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 5, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  let reaped = false;
  const a = guard.acquire(() => { reaped = true; });
  a.markAuthenticated();
  assert.equal(t.pendingCount(), 0); // timer cleared
  t.fireAll();
  assert.equal(reaped, false);
});

test("release before the deadline cancels the reaper", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 5, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  let reaped = false;
  const a = guard.acquire(() => { reaped = true; });
  a.release();
  assert.equal(t.pendingCount(), 0);
  t.fireAll();
  assert.equal(reaped, false);
});

test("markAuthenticated is idempotent and does not resurrect a released slot", () => {
  const t = fakeTimers();
  const guard = createAudioSessionGuard({ maxConcurrent: 5, authDeadlineMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const a = guard.acquire(() => {});
  a.markAuthenticated();
  a.markAuthenticated();
  a.release();
  a.markAuthenticated(); // no-op after release
  assert.equal(guard.stats().active, 0);
});

test("a late-firing timer is a no-op once the slot has authenticated", () => {
  const t = fakeTimers();
  let reaped = false;
  let capturedId = null;
  // clearTimer is intentionally a no-op here so the timer stays pending after
  // markAuthenticated — proving the fire-time `!authenticated` re-check alone
  // (not just clearTimer) prevents a spurious terminate of a live call.
  const guard = createAudioSessionGuard({
    maxConcurrent: 5,
    authDeadlineMs: 1000,
    setTimer: (fn) => { capturedId = t.setTimer(fn); return capturedId; },
    clearTimer: () => {},
  });
  const a = guard.acquire(() => { reaped = true; });
  a.markAuthenticated();
  t.fire(capturedId); // stale timer fires after auth
  assert.equal(reaped, false);
});
