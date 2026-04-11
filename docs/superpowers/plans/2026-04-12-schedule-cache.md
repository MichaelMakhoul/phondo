# Schedule Cache — Context Injection for Instant Availability

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate mid-call tool call latency for availability queries by pre-fetching schedule data into an org-level shared cache and injecting it into the AI's system prompt, so the AI can answer "when are you free?" instantly.

**Architecture:** At call start, fetch 7 business days of schedule data (appointments, blocked times, practitioners) into a shared in-process org-level cache. Inject today + tomorrow's availability into the system prompt. Intercept `check_availability` and `get_current_datetime` tool calls in the voice server to resolve from cache locally (no HTTP round-trip). After write operations (book/cancel), apply optimistic deltas to the shared cache and notify all active sessions for that org via EventEmitter. Next.js fires a webhook to invalidate the cache on dashboard/CRM changes. TTL of 3 minutes as safety net.

**Tech Stack:** Node.js (voice server), Express (invalidation endpoint), Supabase (DB queries), EventEmitter (cross-session notifications)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `voice-server/lib/schedule-cache.js` | Org-level shared cache with TTL, EventEmitter, delta updates |
| Create | `voice-server/tests/schedule-cache.test.js` | Tests for cache module |
| Modify | `voice-server/lib/call-context.js` | Add `loadScheduleSnapshot()` to fetch 7-day schedule |
| Create | `voice-server/tests/schedule-snapshot.test.js` | Tests for snapshot loading |
| Modify | `voice-server/lib/prompt-builder.js:141-258` | Add `buildLiveScheduleSection()`, inject into scheduling section |
| Create | `voice-server/tests/schedule-prompt.test.js` | Tests for prompt injection |
| Modify | `voice-server/services/tool-executor.js:289-314` | Intercept read tools to resolve from cache |
| Create | `voice-server/tests/tool-executor-cache.test.js` | Tests for cache-resolved tool calls |
| Modify | `voice-server/server.js:1186-1268` | Wire cache at session start, refresh after writes, cleanup on end |
| Modify | `voice-server/server.js` (new route) | Add `POST /cache/invalidate` Express endpoint |
| Create | `src/lib/voice-cache/invalidate.ts` | Helper to fire invalidation webhook from Next.js |
| Modify | `src/lib/calendar/tool-handlers.ts` | Call invalidation after book/cancel operations |

---

## Task 1: Schedule Cache Module

**Files:**
- Create: `voice-server/lib/schedule-cache.js`
- Create: `voice-server/tests/schedule-cache.test.js`

### 1.1 — Write failing tests for core cache operations

- [ ] **Step 1: Write failing tests for get/set/invalidate**

```javascript
// voice-server/tests/schedule-cache.test.js
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Reset module cache between tests to get a fresh cache instance
let cache;
function loadFreshCache() {
  delete require.cache[require.resolve("../lib/schedule-cache")];
  cache = require("../lib/schedule-cache");
}

describe("ScheduleCache", () => {
  beforeEach(() => {
    loadFreshCache();
  });

  describe("getSchedule / setSchedule", () => {
    it("returns null for unknown org", () => {
      assert.equal(cache.getSchedule("org-unknown"), null);
    });

    it("stores and retrieves a schedule snapshot", () => {
      const snapshot = {
        appointments: [{ id: "appt-1", start_time: "2026-04-12T09:00:00+10:00" }],
        blockedTimes: [],
        practitioners: [],
        slots: { "2026-04-12": ["2026-04-12T10:00:00", "2026-04-12T10:30:00"] },
        serviceTypes: [{ id: "st-1", name: "Checkup", duration_minutes: 30 }],
        timezone: "Australia/Sydney",
        businessHours: { monday: { open: "09:00", close: "17:00" } },
        defaultDuration: 30,
      };
      cache.setSchedule("org-1", snapshot);
      const result = cache.getSchedule("org-1");
      assert.deepEqual(result.appointments, snapshot.appointments);
      assert.deepEqual(result.slots, snapshot.slots);
    });

    it("does not leak data between orgs", () => {
      cache.setSchedule("org-a", { appointments: [{ id: "a" }], slots: {}, blockedTimes: [], practitioners: [], serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30 });
      cache.setSchedule("org-b", { appointments: [{ id: "b" }], slots: {}, blockedTimes: [], practitioners: [], serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30 });
      assert.equal(cache.getSchedule("org-a").appointments[0].id, "a");
      assert.equal(cache.getSchedule("org-b").appointments[0].id, "b");
    });
  });

  describe("invalidate", () => {
    it("removes cached schedule for an org", () => {
      cache.setSchedule("org-1", { appointments: [], slots: {}, blockedTimes: [], practitioners: [], serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30 });
      assert.ok(cache.getSchedule("org-1"));
      cache.invalidate("org-1");
      assert.equal(cache.getSchedule("org-1"), null);
    });

    it("does not affect other orgs", () => {
      cache.setSchedule("org-1", { appointments: [], slots: {}, blockedTimes: [], practitioners: [], serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30 });
      cache.setSchedule("org-2", { appointments: [], slots: {}, blockedTimes: [], practitioners: [], serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30 });
      cache.invalidate("org-1");
      assert.equal(cache.getSchedule("org-1"), null);
      assert.ok(cache.getSchedule("org-2"));
    });
  });

  describe("TTL expiry", () => {
    it("returns null after TTL expires", () => {
      cache.setSchedule("org-1", { appointments: [], slots: {}, blockedTimes: [], practitioners: [], serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30 });
      // Manually backdate the fetchedAt timestamp
      cache._test.getEntry("org-1").fetchedAt = Date.now() - 4 * 60 * 1000; // 4 minutes ago
      assert.equal(cache.getSchedule("org-1"), null);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd voice-server && node --test tests/schedule-cache.test.js`
Expected: FAIL — module not found

### 1.2 — Implement the cache module

- [ ] **Step 3: Write the schedule cache module**

```javascript
// voice-server/lib/schedule-cache.js
/**
 * Org-level shared schedule cache with TTL and cross-session notification.
 *
 * Why org-level (not session-level): multiple assistants for the same org
 * share the same appointment pool. A booking on Assistant A must be visible
 * to a concurrent call on Assistant B.
 *
 * Thread safety: Node.js is single-threaded — all cache mutations are atomic
 * within a single event loop tick. No locks needed.
 */

const { EventEmitter } = require("node:events");

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

/**
 * @typedef {object} ScheduleSnapshot
 * @property {Array<{id: string, start_time: string, end_time?: string, duration_minutes: number, status: string, practitioner_id?: string, attendee_name?: string, service_type_id?: string, confirmation_code?: string}>} appointments
 * @property {Array<{id: string, start_time: string, end_time: string}>} blockedTimes
 * @property {Array<{id: string, name: string, serviceTypeIds: string[]}>} practitioners
 * @property {Object<string, string[]>} slots - date string → array of available slot ISO strings
 * @property {Array<{id: string, name: string, duration_minutes: number}>} serviceTypes
 * @property {string} timezone
 * @property {object} businessHours
 * @property {number} defaultDuration
 */

/** @type {Map<string, {snapshot: ScheduleSnapshot, fetchedAt: number}>} */
const orgCache = new Map();

const emitter = new EventEmitter();
emitter.setMaxListeners(100); // Support many concurrent calls

/**
 * Get cached schedule for an org. Returns null if missing or expired.
 * @param {string} orgId
 * @returns {ScheduleSnapshot|null}
 */
function getSchedule(orgId) {
  const entry = orgCache.get(orgId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    orgCache.delete(orgId);
    return null;
  }
  return entry.snapshot;
}

/**
 * Store a schedule snapshot for an org.
 * @param {string} orgId
 * @param {ScheduleSnapshot} snapshot
 */
function setSchedule(orgId, snapshot) {
  orgCache.set(orgId, { snapshot, fetchedAt: Date.now() });
}

/**
 * Invalidate (remove) cached schedule for an org.
 * Active sessions listening for this org will re-fetch on next read.
 * @param {string} orgId
 */
function invalidate(orgId) {
  orgCache.delete(orgId);
  emitter.emit("schedule-changed", { orgId });
}

/**
 * Apply an optimistic delta after a successful write operation.
 * Mutates the cached snapshot in place (safe — Node.js single-threaded).
 *
 * @param {string} orgId
 * @param {"book"|"cancel"} action
 * @param {object} data - appointment data from the write result
 */
function applyDelta(orgId, action, data) {
  const entry = orgCache.get(orgId);
  if (!entry) return; // No cache to update

  const { snapshot } = entry;

  if (action === "book" && data.appointment) {
    // Add the new appointment
    snapshot.appointments.push(data.appointment);
    // Remove the booked slot from the relevant day
    const dateKey = data.appointment.start_time.split("T")[0];
    if (snapshot.slots[dateKey]) {
      const slotTime = data.appointment.start_time;
      snapshot.slots[dateKey] = snapshot.slots[dateKey].filter((s) => s !== slotTime);
    }
  }

  if (action === "cancel" && data.appointmentId) {
    // Remove the cancelled appointment
    const idx = snapshot.appointments.findIndex((a) => a.id === data.appointmentId);
    if (idx !== -1) {
      const removed = snapshot.appointments.splice(idx, 1)[0];
      // Re-add the freed slot (simplified — just mark cache as stale for recomputation)
      // Full slot recomputation is complex; safer to invalidate and let TTL re-fetch
      // But since we're within TTL, mark fetchedAt as old to trigger soft refresh
    }
    // For cancellations, invalidate to recompute slots (freed slot needs recalculation)
    // This is simpler and safer than trying to recompute availability inline
    invalidate(orgId);
    return;
  }

  // Touch fetchedAt to keep the entry alive
  entry.fetchedAt = Date.now();

  // Notify all active sessions for this org
  emitter.emit("schedule-changed", { orgId });
}

/**
 * Subscribe to schedule changes for an org.
 * @param {string} orgId
 * @param {function} callback - called with { orgId }
 * @returns {function} unsubscribe function
 */
function onScheduleChanged(orgId, callback) {
  const handler = (event) => {
    if (event.orgId === orgId) callback(event);
  };
  emitter.on("schedule-changed", handler);
  return () => emitter.off("schedule-changed", handler);
}

/**
 * Get the number of cached orgs (for monitoring).
 * @returns {number}
 */
function getCacheSize() {
  return orgCache.size;
}

/**
 * Clear all cache entries (for testing).
 */
function clearAll() {
  orgCache.clear();
}

// Expose internals for testing only
const _test = {
  getEntry: (orgId) => orgCache.get(orgId),
  CACHE_TTL_MS,
};

module.exports = {
  getSchedule,
  setSchedule,
  invalidate,
  applyDelta,
  onScheduleChanged,
  getCacheSize,
  clearAll,
  _test,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd voice-server && node --test tests/schedule-cache.test.js`
Expected: All tests PASS

- [ ] **Step 5: Write failing tests for delta updates and event subscription**

Append to `voice-server/tests/schedule-cache.test.js`:

```javascript
  describe("applyDelta", () => {
    it("adds a booked appointment and removes the slot", () => {
      cache.setSchedule("org-1", {
        appointments: [],
        blockedTimes: [],
        practitioners: [],
        slots: { "2026-04-12": ["2026-04-12T09:00:00", "2026-04-12T09:30:00", "2026-04-12T10:00:00"] },
        serviceTypes: [],
        timezone: "Australia/Sydney",
        businessHours: {},
        defaultDuration: 30,
      });

      cache.applyDelta("org-1", "book", {
        appointment: {
          id: "appt-new",
          start_time: "2026-04-12T09:00:00",
          end_time: "2026-04-12T09:30:00",
          duration_minutes: 30,
          status: "confirmed",
        },
      });

      const updated = cache.getSchedule("org-1");
      assert.equal(updated.appointments.length, 1);
      assert.equal(updated.appointments[0].id, "appt-new");
      // The 9:00 slot should be removed
      assert.ok(!updated.slots["2026-04-12"].includes("2026-04-12T09:00:00"));
      // Other slots remain
      assert.ok(updated.slots["2026-04-12"].includes("2026-04-12T09:30:00"));
    });

    it("invalidates cache on cancellation", () => {
      cache.setSchedule("org-1", {
        appointments: [{ id: "appt-1", start_time: "2026-04-12T09:00:00", duration_minutes: 30, status: "confirmed" }],
        blockedTimes: [],
        practitioners: [],
        slots: { "2026-04-12": ["2026-04-12T09:30:00"] },
        serviceTypes: [],
        timezone: "Australia/Sydney",
        businessHours: {},
        defaultDuration: 30,
      });

      cache.applyDelta("org-1", "cancel", { appointmentId: "appt-1" });

      // Cache should be invalidated (null) because slot recomputation is complex
      assert.equal(cache.getSchedule("org-1"), null);
    });

    it("is a no-op when org has no cache", () => {
      // Should not throw
      cache.applyDelta("org-missing", "book", { appointment: { id: "x", start_time: "2026-04-12T09:00:00" } });
      assert.equal(cache.getSchedule("org-missing"), null);
    });
  });

  describe("onScheduleChanged", () => {
    it("fires callback when schedule changes via invalidation", (t, done) => {
      cache.setSchedule("org-1", {
        appointments: [], blockedTimes: [], practitioners: [], slots: {},
        serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30,
      });

      const unsub = cache.onScheduleChanged("org-1", (event) => {
        assert.equal(event.orgId, "org-1");
        unsub();
        done();
      });

      cache.invalidate("org-1");
    });

    it("does not fire for different orgs", () => {
      let fired = false;
      const unsub = cache.onScheduleChanged("org-1", () => { fired = true; });
      cache.invalidate("org-2");
      assert.equal(fired, false);
      unsub();
    });

    it("fires callback on booking delta", (t, done) => {
      cache.setSchedule("org-1", {
        appointments: [], blockedTimes: [], practitioners: [], slots: { "2026-04-12": ["2026-04-12T09:00:00"] },
        serviceTypes: [], timezone: "UTC", businessHours: {}, defaultDuration: 30,
      });

      const unsub = cache.onScheduleChanged("org-1", (event) => {
        assert.equal(event.orgId, "org-1");
        unsub();
        done();
      });

      cache.applyDelta("org-1", "book", {
        appointment: { id: "x", start_time: "2026-04-12T09:00:00", duration_minutes: 30, status: "confirmed" },
      });
    });
  });
```

- [ ] **Step 6: Run all cache tests**

Run: `cd voice-server && node --test tests/schedule-cache.test.js`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/lib/schedule-cache.js voice-server/tests/schedule-cache.test.js
git commit -m "feat(SCRUM-179): add org-level schedule cache with TTL, deltas, and event subscription"
```

---

## Task 2: Schedule Snapshot Loader

**Files:**
- Modify: `voice-server/lib/call-context.js`
- Create: `voice-server/tests/schedule-snapshot.test.js`

This task adds a function that fetches 7 business days of schedule data from the DB and computes available slots. It's called once at call start and the result is stored in the shared cache.

### 2.1 — Write failing tests for snapshot loading

- [ ] **Step 1: Write failing test**

```javascript
// voice-server/tests/schedule-snapshot.test.js
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Mock fetch and Supabase before requiring the module
const originalFetch = global.fetch;

describe("loadScheduleSnapshot", () => {
  let loadScheduleSnapshot;

  beforeEach(() => {
    delete require.cache[require.resolve("../lib/call-context")];
    // Mock Supabase — the snapshot loader uses supabase queries
    // We'll test the pure computation logic separately
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("is exported from call-context", () => {
    const mod = require("../lib/call-context");
    assert.equal(typeof mod.loadScheduleSnapshot, "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd voice-server && node --test tests/schedule-snapshot.test.js`
Expected: FAIL — `loadScheduleSnapshot` not exported

### 2.2 — Implement the snapshot loader

- [ ] **Step 3: Add `loadScheduleSnapshot` to `voice-server/lib/call-context.js`**

Add the following function before the `module.exports` line (before line 423). Also update the exports.

```javascript
/**
 * Generate all business dates from today up to `days` business days ahead.
 * Skips days that are closed according to businessHours.
 *
 * @param {string} timezone - IANA timezone
 * @param {object} businessHours - { monday: { open, close }, ... }
 * @param {number} days - Number of business days to generate
 * @returns {string[]} Array of "YYYY-MM-DD" date strings
 */
function getBusinessDates(timezone, businessHours, days) {
  if (!timezone || !businessHours) return [];

  const dates = [];
  const now = new Date();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  // Start from today in the org's timezone
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });

  for (let offset = 0; dates.length < days && offset < 21; offset++) {
    const d = new Date(now.getTime() + offset * 86400000);
    const dateStr = formatter.format(d); // "YYYY-MM-DD"
    const dayName = dayNames[d.getDay()]; // Not timezone-aware for day name
    // Use Intl to get the correct day name in the org's timezone
    const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone });
    const tzDayName = dayFormatter.format(d).toLowerCase();

    const dayHours = businessHours[tzDayName];
    if (dayHours && dayHours.open && dayHours.close && !dayHours.closed) {
      dates.push(dateStr);
    }
  }
  return dates;
}

/**
 * Generate time slots for a date given business hours and slot duration.
 * Returns array of ISO-like local time strings: "YYYY-MM-DDThh:mm:00"
 *
 * @param {string} date - "YYYY-MM-DD"
 * @param {string} open - "HH:MM" (e.g., "09:00")
 * @param {string} close - "HH:MM" (e.g., "17:00")
 * @param {number} durationMinutes - Slot duration (default 30)
 * @returns {string[]}
 */
function generateTimeSlots(date, open, close, durationMinutes = 30) {
  const [openH, openM] = open.split(":").map(Number);
  const [closeH, closeM] = close.split(":").map(Number);
  const openMin = openH * 60 + (openM || 0);
  const closeMin = closeH * 60 + (closeM || 0);

  const slots = [];
  for (let m = openMin; m + durationMinutes <= closeMin; m += durationMinutes) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    slots.push(`${date}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`);
  }
  return slots;
}

/**
 * Load a 7-business-day schedule snapshot for an organization.
 * Used to populate the shared schedule cache at call start.
 *
 * @param {string} organizationId
 * @param {object} orgConfig - { timezone, businessHours, defaultAppointmentDuration }
 * @param {Array} serviceTypes - [{ id, name, duration_minutes }]
 * @returns {Promise<object|null>} ScheduleSnapshot or null on failure
 */
async function loadScheduleSnapshot(organizationId, orgConfig, serviceTypes) {
  const { timezone, businessHours, defaultAppointmentDuration } = orgConfig;
  if (!timezone || !businessHours) {
    console.warn("[ScheduleSnapshot] No timezone or business hours configured — skipping cache");
    return null;
  }

  const supabase = getSupabase();
  const duration = defaultAppointmentDuration || 30;

  // Get 7 business days from today
  const dates = getBusinessDates(timezone, businessHours, 7);
  if (dates.length === 0) return null;

  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];

  // Convert date boundaries to UTC for Supabase queries
  const rangeStartLocal = `${firstDate}T00:00:00`;
  const rangeEndLocal = `${lastDate}T23:59:59`;

  // Simple UTC conversion using timezone offset
  const rangeStartUtc = new Date(new Date(rangeStartLocal).toLocaleString("en-US", { timeZone: timezone })).toISOString();
  const rangeEndUtc = new Date(new Date(rangeEndLocal).toLocaleString("en-US", { timeZone: timezone })).toISOString();

  // Parallel fetch: appointments, blocked times, practitioners
  const [apptResult, blockedResult, practResult] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, start_time, end_time, duration_minutes, status, practitioner_id, attendee_name, service_type_id, confirmation_code")
      .eq("organization_id", organizationId)
      .in("status", ["confirmed", "pending"])
      .gte("start_time", rangeStartUtc)
      .lte("start_time", rangeEndUtc),
    supabase
      .from("blocked_times")
      .select("id, start_time, end_time")
      .eq("organization_id", organizationId)
      .gte("start_time", rangeStartUtc)
      .lte("start_time", rangeEndUtc),
    supabase
      .from("practitioners")
      .select("id, name, is_active")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
  ]);

  if (apptResult.error) {
    console.error("[ScheduleSnapshot] Failed to fetch appointments:", apptResult.error);
    return null;
  }
  if (blockedResult.error) {
    console.error("[ScheduleSnapshot] Failed to fetch blocked times:", blockedResult.error);
    // Non-fatal — continue without blocked times
  }

  const appointments = apptResult.data || [];
  const blockedTimes = blockedResult.data || [];
  const practitioners = (practResult.data || []).map((p) => ({ id: p.id, name: p.name }));

  // Fetch practitioner-service assignments if we have practitioners
  let practitionerServiceMap = {};
  if (practitioners.length > 0) {
    const { data: psData } = await supabase
      .from("practitioner_services")
      .select("practitioner_id, service_type_id")
      .in("practitioner_id", practitioners.map((p) => p.id));

    if (psData) {
      for (const ps of psData) {
        if (!practitionerServiceMap[ps.practitioner_id]) {
          practitionerServiceMap[ps.practitioner_id] = [];
        }
        practitionerServiceMap[ps.practitioner_id].push(ps.service_type_id);
      }
    }
  }

  // Enrich practitioners with their service type IDs
  const enrichedPractitioners = practitioners.map((p) => ({
    ...p,
    serviceTypeIds: practitionerServiceMap[p.id] || [],
  }));

  // Compute available slots for each date
  const slots = {};
  const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const nowMinutes = nowInTz.getHours() * 60 + nowInTz.getMinutes();
  const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, "0")}-${String(nowInTz.getDate()).padStart(2, "0")}`;

  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  for (const date of dates) {
    // Get business hours for this day
    const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone });
    const dateObj = new Date(date + "T12:00:00"); // Noon to avoid timezone date-shift issues
    const dayName = dayFormatter.format(dateObj).toLowerCase();
    const hours = businessHours[dayName];
    if (!hours || !hours.open || !hours.close) continue;

    let daySlots = generateTimeSlots(date, hours.open, hours.close, duration);

    // Filter past slots for today
    if (date === todayStr) {
      daySlots = daySlots.filter((slot) => {
        const [, timeStr] = slot.split("T");
        const [h, m] = timeStr.split(":").map(Number);
        return h * 60 + m > nowMinutes;
      });
    }

    // Filter blocked times
    for (const blocked of blockedTimes) {
      const bStart = new Date(blocked.start_time);
      const bEnd = new Date(blocked.end_time);
      daySlots = daySlots.filter((slot) => {
        // Convert slot to a comparable Date
        // Slot is in org-local format — parse as local time in org timezone
        const slotDate = new Date(slot); // Naive parse, close enough for same-day comparison
        const slotEnd = new Date(slotDate.getTime() + duration * 60000);
        return !(slotDate < bEnd && slotEnd > bStart);
      });
    }

    // Filter existing appointments
    const dayAppts = appointments.filter((a) => a.start_time.startsWith(date) || a.start_time.includes(date));
    // More robust: convert appointment times to local-day comparison
    for (const appt of appointments) {
      const apptDate = new Date(appt.start_time);
      // Use timezone-aware formatting to get the local date
      const apptLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(apptDate);
      if (apptLocalDate !== date) continue;

      const { hours: aH, minutes: aM } = getTimeComponents(apptDate, timezone);
      const apptStartMin = aH * 60 + aM;
      const apptDuration = appt.duration_minutes || duration;
      const apptEndMin = apptStartMin + apptDuration;

      daySlots = daySlots.filter((slot) => {
        const [, timeStr] = slot.split("T");
        const [sH, sM] = timeStr.split(":").map(Number);
        const slotStartMin = sH * 60 + sM;
        const slotEndMin = slotStartMin + duration;
        return !(slotStartMin < apptEndMin && slotEndMin > apptStartMin);
      });
    }

    slots[date] = daySlots;
  }

  return {
    appointments,
    blockedTimes,
    practitioners: enrichedPractitioners,
    slots,
    serviceTypes: serviceTypes || [],
    timezone,
    businessHours,
    defaultDuration: duration,
  };
}

/**
 * Get hours and minutes from a Date in a specific timezone.
 * @param {Date} date
 * @param {string} timezone
 * @returns {{ hours: number, minutes: number }}
 */
function getTimeComponents(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone,
  });
  const timeStr = formatter.format(date);
  const [hours, minutes] = timeStr.split(":").map(Number);
  return { hours, minutes };
}
```

Update the `module.exports` at the end of `call-context.js`:

```javascript
module.exports = { loadCallContext, loadTestCallContext, loadScheduleSnapshot, getBusinessDates, generateTimeSlots, _test: { getTimeComponents } };
```

- [ ] **Step 4: Run snapshot export test**

Run: `cd voice-server && node --test tests/schedule-snapshot.test.js`
Expected: PASS

- [ ] **Step 5: Add pure function tests for `getBusinessDates` and `generateTimeSlots`**

Append to `voice-server/tests/schedule-snapshot.test.js`:

```javascript
describe("getBusinessDates", () => {
  let getBusinessDates;

  beforeEach(() => {
    delete require.cache[require.resolve("../lib/call-context")];
    getBusinessDates = require("../lib/call-context").getBusinessDates;
  });

  it("returns empty array with no timezone", () => {
    assert.deepEqual(getBusinessDates(null, { monday: { open: "09:00", close: "17:00" } }, 5), []);
  });

  it("returns empty array with no business hours", () => {
    assert.deepEqual(getBusinessDates("Australia/Sydney", null, 5), []);
  });

  it("skips closed days", () => {
    const hours = {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: { closed: true },
      sunday: { closed: true },
    };
    const dates = getBusinessDates("Australia/Sydney", hours, 7);
    assert.equal(dates.length, 7);
    // All dates should be weekdays
    for (const d of dates) {
      const day = new Date(d + "T12:00:00").getDay();
      assert.ok(day >= 1 && day <= 5, `${d} is a weekend`);
    }
  });
});

describe("generateTimeSlots", () => {
  let generateTimeSlots;

  beforeEach(() => {
    delete require.cache[require.resolve("../lib/call-context")];
    generateTimeSlots = require("../lib/call-context").generateTimeSlots;
  });

  it("generates 30-minute slots", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "12:00", 30);
    assert.equal(slots.length, 6); // 9:00, 9:30, 10:00, 10:30, 11:00, 11:30
    assert.equal(slots[0], "2026-04-12T09:00:00");
    assert.equal(slots[5], "2026-04-12T11:30:00");
  });

  it("generates 45-minute slots", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "12:00", 45);
    assert.equal(slots.length, 4); // 9:00, 9:45, 10:30, 11:15
  });

  it("returns empty for zero-width window", () => {
    const slots = generateTimeSlots("2026-04-12", "09:00", "09:00", 30);
    assert.equal(slots.length, 0);
  });
});
```

- [ ] **Step 6: Run all snapshot tests**

Run: `cd voice-server && node --test tests/schedule-snapshot.test.js`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/lib/call-context.js voice-server/tests/schedule-snapshot.test.js
git commit -m "feat(SCRUM-179): add schedule snapshot loader with 7-day availability computation"
```

---

## Task 3: Prompt Builder — Live Schedule Section

**Files:**
- Modify: `voice-server/lib/prompt-builder.js:141-258`
- Create: `voice-server/tests/schedule-prompt.test.js`

### 3.1 — Write failing tests for live schedule formatting

- [ ] **Step 1: Write failing test**

```javascript
// voice-server/tests/schedule-prompt.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("buildLiveScheduleSection", () => {
  let buildLiveScheduleSection;

  beforeEach(() => {
    delete require.cache[require.resolve("../lib/prompt-builder")];
    // buildLiveScheduleSection should be exported
    buildLiveScheduleSection = require("../lib/prompt-builder").buildLiveScheduleSection;
  });

  it("is exported from prompt-builder", () => {
    assert.equal(typeof buildLiveScheduleSection, "function");
  });

  it("includes current date/time header", () => {
    const snapshot = {
      slots: { "2026-04-12": ["2026-04-12T09:00:00", "2026-04-12T09:30:00"] },
      appointments: [],
      timezone: "Australia/Sydney",
      serviceTypes: [],
    };
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.includes("LIVE SCHEDULE"), "Missing LIVE SCHEDULE header");
    assert.ok(result.includes("2026-04-12"), "Missing current date");
  });

  it("lists available slots for today and tomorrow", () => {
    const snapshot = {
      slots: {
        "2026-04-12": ["2026-04-12T14:00:00", "2026-04-12T14:30:00"],
        "2026-04-13": ["2026-04-13T09:00:00", "2026-04-13T09:30:00", "2026-04-13T10:00:00"],
      },
      appointments: [],
      timezone: "Australia/Sydney",
      serviceTypes: [],
    };
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.includes("2:00 PM") || result.includes("14:00"), "Missing today slot");
    assert.ok(result.includes("9:00 AM") || result.includes("09:00"), "Missing tomorrow slot");
  });

  it("shows 'fully booked' when no slots available", () => {
    const snapshot = {
      slots: { "2026-04-12": [] },
      appointments: [],
      timezone: "Australia/Sydney",
      serviceTypes: [],
    };
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.toLowerCase().includes("fully booked") || result.toLowerCase().includes("no slots"), "Missing fully booked message");
  });

  it("instructs AI to use context for today/tomorrow and tool for other dates", () => {
    const snapshot = {
      slots: { "2026-04-12": ["2026-04-12T09:00:00"] },
      appointments: [],
      timezone: "Australia/Sydney",
      serviceTypes: [],
    };
    const result = buildLiveScheduleSection(snapshot, "2026-04-12");
    assert.ok(result.includes("check_availability"), "Missing fallback instruction for other dates");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd voice-server && node --test tests/schedule-prompt.test.js`
Expected: FAIL — `buildLiveScheduleSection` not exported

### 3.2 — Implement the live schedule section

- [ ] **Step 3: Add `buildLiveScheduleSection` to `voice-server/lib/prompt-builder.js`**

Add this function before `buildSchedulingSection()` (before line 141):

```javascript
/**
 * Format a time string "HH:MM:00" into a natural spoken format like "9:00 AM".
 * @param {string} isoTime - e.g., "2026-04-12T09:00:00"
 * @returns {string}
 */
function formatSlotTime(isoTime) {
  const [, timeStr] = isoTime.split("T");
  const [h, m] = timeStr.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${displayH}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Build a live schedule section for injection into the system prompt.
 * Shows today and tomorrow's availability from the cached snapshot.
 * Instructs the AI to answer availability questions from this context
 * instead of calling check_availability for these dates.
 *
 * @param {object} snapshot - ScheduleSnapshot from the cache
 * @param {string} todayStr - "YYYY-MM-DD" in org timezone
 * @returns {string}
 */
function buildLiveScheduleSection(snapshot, todayStr) {
  if (!snapshot || !snapshot.slots) return "";

  const lines = [];
  lines.push("");
  lines.push("LIVE SCHEDULE (pre-loaded, use this instead of calling check_availability for listed dates):");

  // Current date/time
  const now = new Date();
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h12", timeZone: snapshot.timezone,
  });
  const currentTime = timeFormatter.format(now);
  lines.push(`Current date: ${todayStr}, Current time: ${currentTime} (${snapshot.timezone})`);

  // Get sorted dates from the snapshot
  const dates = Object.keys(snapshot.slots).sort();

  // Show today and tomorrow in detail, summary for rest
  const detailDates = dates.slice(0, 2);
  const summaryDates = dates.slice(2);

  for (const date of detailDates) {
    const daySlots = snapshot.slots[date] || [];
    const dayLabel = date === todayStr ? "Today" : "Tomorrow";
    const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: snapshot.timezone });
    const dateObj = new Date(date + "T12:00:00");
    const formattedDate = dayFormatter.format(dateObj);

    if (daySlots.length === 0) {
      lines.push(`${dayLabel} (${formattedDate}): Fully booked - no slots available.`);
    } else {
      const times = daySlots.map(formatSlotTime);
      lines.push(`${dayLabel} (${formattedDate}): ${times.join(", ")} (${daySlots.length} slots)`);
    }
  }

  // Brief summary for remaining cached dates
  if (summaryDates.length > 0) {
    lines.push("");
    lines.push("Upcoming days (slot count only — call check_availability for specific times on these dates):");
    for (const date of summaryDates) {
      const daySlots = snapshot.slots[date] || [];
      const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: snapshot.timezone });
      const dateObj = new Date(date + "T12:00:00");
      const formattedDate = dayFormatter.format(dateObj);
      lines.push(`- ${formattedDate}: ${daySlots.length === 0 ? "Fully booked" : `${daySlots.length} slots available`}`);
    }
  }

  // Instructions for the AI
  lines.push("");
  lines.push("SCHEDULE USAGE RULES:");
  lines.push("- For TODAY and TOMORROW: Use the slot times above directly. Do NOT call check_availability or get_current_datetime — you already have the data.");
  lines.push("- For dates listed with slot counts only: Call check_availability to get the specific times.");
  lines.push("- For dates NOT listed above: Call check_availability as usual (these are beyond the cached window).");
  lines.push("- IMPORTANT: When booking, you MUST still call book_appointment — never confirm a booking without calling the tool.");

  return lines.join("\n");
}
```

Export `buildLiveScheduleSection` from the module. Find the `module.exports` at the end of the file and add it:

In `voice-server/lib/prompt-builder.js`, update the exports (around line 867-870) to include `buildLiveScheduleSection`:

```javascript
module.exports = {
  buildPromptFromConfig,
  buildSchedulingSection,
  buildSystemPrompt,
  buildLiveScheduleSection, // <-- ADD THIS
  getGreeting,
  _test: { sanitizeForPrompt, buildVerificationInstructions, buildBehaviorsSection },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd voice-server && node --test tests/schedule-prompt.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/lib/prompt-builder.js voice-server/tests/schedule-prompt.test.js
git commit -m "feat(SCRUM-179): add live schedule section for system prompt injection"
```

---

## Task 4: Tool Executor — Local Cache Resolution

**Files:**
- Modify: `voice-server/services/tool-executor.js:289-314`
- Create: `voice-server/tests/tool-executor-cache.test.js`

This task makes `check_availability` and `get_current_datetime` resolve from the session's cached snapshot when possible, falling back to the API only for cache misses.

### 4.1 — Write failing tests

- [ ] **Step 1: Write failing test for cache-resolved availability**

```javascript
// voice-server/tests/tool-executor-cache.test.js
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("executeToolCall with cache", () => {
  let executeToolCall;
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Ensure clean module state
    delete require.cache[require.resolve("../services/tool-executor")];
    process.env.INTERNAL_API_URL = "http://localhost:3000";
    process.env.INTERNAL_API_SECRET = "test-secret";
    executeToolCall = require("../services/tool-executor").executeToolCall;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.INTERNAL_API_URL;
    delete process.env.INTERNAL_API_SECRET;
  });

  it("resolves get_current_datetime from context.timezone without API call", async () => {
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ message: "API datetime" }) }; };

    const result = await executeToolCall("get_current_datetime", {}, {
      organizationId: "org-1",
      assistantId: "asst-1",
      organization: { timezone: "Australia/Sydney" },
      scheduleSnapshot: { timezone: "Australia/Sydney", slots: {} },
    });

    assert.ok(!fetchCalled, "Should not have called fetch");
    assert.ok(result.message.includes("Australia/Sydney") || result.message.includes("AEST") || result.message.includes("AEDT") || result.message.includes(":"), "Should include timezone info");
  });

  it("resolves check_availability from cache for a cached date", async () => {
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ message: "API response" }) }; };

    const result = await executeToolCall("check_availability", { date: "2026-04-12" }, {
      organizationId: "org-1",
      assistantId: "asst-1",
      organization: { timezone: "Australia/Sydney" },
      scheduleSnapshot: {
        timezone: "Australia/Sydney",
        slots: { "2026-04-12": ["2026-04-12T09:00:00", "2026-04-12T09:30:00", "2026-04-12T10:00:00"] },
        serviceTypes: [],
        defaultDuration: 30,
      },
    });

    assert.ok(!fetchCalled, "Should not have called fetch for a cached date");
    assert.ok(result.message.includes("9:00") || result.message.includes("09:00"), "Should include slot times");
  });

  it("falls back to API for dates not in cache", async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ success: true, message: "Available: 9:00 AM, 10:00 AM" }) };
    };

    const result = await executeToolCall("check_availability", { date: "2026-05-01" }, {
      organizationId: "org-1",
      assistantId: "asst-1",
      organization: { timezone: "Australia/Sydney" },
      scheduleSnapshot: {
        timezone: "Australia/Sydney",
        slots: { "2026-04-12": ["2026-04-12T09:00:00"] },
      },
    });

    assert.ok(fetchCalled, "Should have called fetch for uncached date");
  });

  it("still calls API for book_appointment (write operation)", async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ success: true, message: "Appointment booked." }) };
    };

    await executeToolCall("book_appointment", { datetime: "2026-04-12T09:00:00", first_name: "John", last_name: "Doe", phone: "+61400000000" }, {
      organizationId: "org-1",
      assistantId: "asst-1",
      organization: { timezone: "Australia/Sydney" },
      scheduleSnapshot: { timezone: "Australia/Sydney", slots: {} },
    });

    assert.ok(fetchCalled, "Write operations must always call API");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd voice-server && node --test tests/tool-executor-cache.test.js`
Expected: FAIL — `get_current_datetime` and `check_availability` still call fetch

### 4.2 — Implement cache resolution in tool executor

- [ ] **Step 3: Modify `executeToolCall` in `voice-server/services/tool-executor.js`**

Add cache resolution logic at the top of `executeToolCall()` (around line 289). The key changes:

1. `get_current_datetime` resolves from `context.organization.timezone` (already available) — no API call needed
2. `check_availability` checks `context.scheduleSnapshot.slots[date]` — if the date exists in the cache, format and return locally
3. Everything else (writes, uncached dates) falls through to the existing API call

Replace the existing `executeToolCall` function (lines 289-314) with:

```javascript
async function executeToolCall(functionName, args, context) {
  // ── Transfer call (handled locally via Twilio) ──
  if (functionName === "transfer_call") {
    return executeTransferCall(args, context);
  }

  // ── Schedule callback ──
  if (functionName === "schedule_callback") {
    if (context.testMode) {
      return simulateCallbackWrite(args);
    }
    return executeCalendarCall(functionName, args, context);
  }

  // ── Cache-resolved reads (no HTTP round-trip) ──
  if (functionName === "get_current_datetime" && context.organization?.timezone) {
    return resolveCurrentDatetime(context.organization.timezone);
  }

  if (functionName === "check_availability" && context.scheduleSnapshot) {
    const cached = resolveAvailabilityFromCache(args, context.scheduleSnapshot);
    if (cached) return cached; // Cache hit — return immediately
    // Cache miss (date not in window) — fall through to API
  }

  if (CALENDAR_FUNCTIONS.includes(functionName)) {
    // In test mode, simulate write operations instead of hitting the real API
    if (context.testMode && (functionName === "book_appointment" || functionName === "cancel_appointment")) {
      return simulateCalendarWrite(functionName, args);
    }
    // list_service_types is always a read — no simulation needed
    return executeCalendarCall(functionName, args, context);
  }

  console.warn(`[ToolExecutor] Unknown function: ${functionName}`);
  return { message: `Unknown function: ${functionName}` };
}

/**
 * Resolve get_current_datetime locally from the session's timezone.
 * Eliminates the most pointless API call — the voice server already knows the timezone.
 */
function resolveCurrentDatetime(timezone) {
  try {
    const now = new Date();
    const dateFormatter = new Intl.DateTimeFormat("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      timeZone: timezone,
    });
    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit", minute: "2-digit", hourCycle: "h12",
      timeZone: timezone,
    });
    const isoDateFormatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit",
      timeZone: timezone,
    });
    const dateStr = dateFormatter.format(now);
    const timeStr = timeFormatter.format(now);
    const isoDate = isoDateFormatter.format(now);

    return {
      message: `Current date and time: ${dateStr}, ${timeStr} (${timezone}). Today's date in YYYY-MM-DD format: ${isoDate}.`,
    };
  } catch (err) {
    console.error("[ToolExecutor] Failed to resolve datetime locally:", err.message);
    return null; // Fall through to API
  }
}

/**
 * Resolve check_availability from the cached schedule snapshot.
 * Returns formatted availability if the date is in the cache, or null for cache miss.
 */
function resolveAvailabilityFromCache(args, snapshot) {
  const { date, service_type_id } = args;
  if (!date || !snapshot.slots) return null;

  // Check if this date is in our cached window
  if (!(date in snapshot.slots)) return null; // Cache miss

  const daySlots = snapshot.slots[date];

  // If service_type_id is provided and we have service types, filter by duration
  // (The cache computes slots using the default duration; service-specific durations
  // may differ. For now, return the default-duration slots — the booking API handles
  // the actual conflict check with correct duration.)

  if (daySlots.length === 0) {
    // Format the date nicely for the message
    const dateObj = new Date(date + "T12:00:00");
    const formatted = new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "long", day: "numeric",
      timeZone: snapshot.timezone,
    }).format(dateObj);
    return {
      message: `No available slots on ${formatted}. The schedule is fully booked for this day. Please suggest an alternative date.`,
    };
  }

  // Group slots into ranges for natural presentation
  const times = daySlots.map((slot) => {
    const [, timeStr] = slot.split("T");
    const [h, m] = timeStr.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${displayH}:${String(m).padStart(2, "0")} ${period}`;
  });

  const dateObj = new Date(date + "T12:00:00");
  const formatted = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric",
    timeZone: snapshot.timezone,
  }).format(dateObj);

  return {
    message: `Available times on ${formatted}: ${times.join(", ")}. (${daySlots.length} slots available, ${snapshot.defaultDuration || 30}-minute appointments)`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd voice-server && node --test tests/tool-executor-cache.test.js`
Expected: All tests PASS

- [ ] **Step 5: Run existing tool-executor tests to check for regressions**

Run: `cd voice-server && node --test tests/tool-executor-routing.test.js`
Expected: All existing tests still PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/services/tool-executor.js voice-server/tests/tool-executor-cache.test.js
git commit -m "feat(SCRUM-179): resolve check_availability and get_current_datetime from cache locally"
```

---

## Task 5: Server.js — Wire Cache Into Call Lifecycle

**Files:**
- Modify: `voice-server/server.js`

This is the integration task. It wires the cache module into the call lifecycle:
- At call start: fetch schedule snapshot, store in shared cache, subscribe to changes
- Pass snapshot to tool executor context
- After write tool calls: apply delta to cache
- On session end: unsubscribe from cache events
- Add Express endpoint for external invalidation

### 5.1 — Add imports and cache invalidation endpoint

- [ ] **Step 1: Add imports at the top of `server.js`**

Near the existing requires at the top of `voice-server/server.js` (after the `require("./lib/call-context")` line), add:

```javascript
const scheduleCache = require("./lib/schedule-cache");
const { loadScheduleSnapshot } = require("./lib/call-context");
const { buildLiveScheduleSection } = require("./lib/prompt-builder");
```

Note: `loadCallContext` is already imported. Update the destructured import to also include `loadScheduleSnapshot`.

- [ ] **Step 2: Add the Express invalidation endpoint**

Add this route after the existing Express routes (e.g., after the health check or TwiML routes). Find a suitable location in the Express route section:

```javascript
/**
 * Cache invalidation endpoint — called by the Next.js app when schedule data
 * changes via dashboard, CRM webhook, or other non-voice-server source.
 *
 * POST /cache/invalidate
 * Headers: X-Internal-Secret: <shared secret>
 * Body: { organizationId: string }
 */
app.post("/cache/invalidate", express.json(), (req, res) => {
  const secret = req.headers["x-internal-secret"];
  if (!secret || secret !== INTERNAL_API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { organizationId } = req.body;
  if (!organizationId) {
    return res.status(400).json({ error: "organizationId required" });
  }

  console.log(`[CacheInvalidate] Invalidating schedule cache for org=${organizationId}`);
  scheduleCache.invalidate(organizationId);
  res.json({ success: true });
});
```

- [ ] **Step 3: Commit endpoint addition**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/server.js
git commit -m "feat(SCRUM-179): add cache invalidation endpoint and imports"
```

### 5.2 — Wire cache into call start

- [ ] **Step 4: Modify session initialization to load schedule snapshot**

In `voice-server/server.js`, after the system prompt is built (around line 1268, after `session.setSystemPrompt(systemPrompt + callerContext)`), add schedule cache logic:

```javascript
          // ── Schedule cache: pre-fetch availability snapshot ──
          let scheduleSnapshot = null;
          if (session.calendarEnabled || session.serviceTypes?.length > 0) {
            try {
              // Check shared cache first
              scheduleSnapshot = scheduleCache.getSchedule(context.organizationId);
              if (!scheduleSnapshot) {
                // Cache miss — fetch from DB and store in shared cache
                scheduleSnapshot = await loadScheduleSnapshot(
                  context.organizationId,
                  context.organization,
                  context.serviceTypes
                );
                if (scheduleSnapshot) {
                  scheduleCache.setSchedule(context.organizationId, scheduleSnapshot);
                  console.log(`[ScheduleCache] Loaded snapshot for org=${context.organizationId} (${Object.keys(scheduleSnapshot.slots).length} days, ${Object.values(scheduleSnapshot.slots).flat().length} total slots)`);
                }
              } else {
                console.log(`[ScheduleCache] Cache hit for org=${context.organizationId}`);
              }

              // Inject live schedule into system prompt
              if (scheduleSnapshot) {
                const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: context.organization.timezone }));
                const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, "0")}-${String(nowInTz.getDate()).padStart(2, "0")}`;
                const liveSection = buildLiveScheduleSection(scheduleSnapshot, todayStr);
                if (liveSection) {
                  // Append live schedule to the system prompt
                  const currentPrompt = session.messages[0]?.content || "";
                  session.setSystemPrompt(currentPrompt + "\n" + liveSection);
                }
              }
            } catch (err) {
              console.warn("[ScheduleCache] Failed to load schedule snapshot (non-fatal):", err.message);
              // Non-fatal — voice server continues without cache, tools work as before
            }
          }
          // Store snapshot reference on session for tool executor access
          session.scheduleSnapshot = scheduleSnapshot;

          // Subscribe to cache changes from other sessions (same org)
          if (scheduleSnapshot) {
            session._cacheUnsub = scheduleCache.onScheduleChanged(context.organizationId, async (event) => {
              try {
                const fresh = scheduleCache.getSchedule(event.orgId);
                if (fresh) {
                  session.scheduleSnapshot = fresh;
                  console.log(`[ScheduleCache] Session ${session.callSid} updated from shared cache`);
                }
              } catch (err) {
                console.warn("[ScheduleCache] Failed to refresh session from cache event:", err.message);
              }
            });
          }
```

- [ ] **Step 5: Pass `scheduleSnapshot` to tool executor context**

Find where `executeToolCall` is called in the classic pipeline (around line 1879+). The tool call context object needs `scheduleSnapshot` added. Look for the call to `executeToolCall(toolCall.function.name, args, { ... })` and add `scheduleSnapshot: session.scheduleSnapshot` to the context object.

There are two places where `executeToolCall` is called:

**Classic pipeline** (in `handleUserSpeech` → tool call loop, around line 1879-1890):

Find the `executeToolCall` call and add `scheduleSnapshot`:

```javascript
          const toolResult = await executeToolCall(toolCall.function.name, args, {
            organizationId: session.organizationId,
            assistantId: session.assistantId,
            callSid: session.callSid,
            callId: session.callRecordId,
            transferRules: session.transferRules,
            testMode: session.testMode,
            organization: session.organization,
            callerPhone: session.callerPhone,
            orgPhoneNumber: session.orgPhoneNumber,
            telephonyProvider: session.telephonyProvider,
            scheduleSnapshot: session.scheduleSnapshot, // <-- ADD THIS
          });
```

**Gemini Live pipeline** (in `onToolCall` callback, around line 1419-1430):

Find the `executeToolCall` call in the Gemini onToolCall and add `scheduleSnapshot`:

```javascript
                onToolCall: async (toolCall) => {
                  console.log(`[GeminiLive] Tool call: ${toolCall.name}(${JSON.stringify(toolCall.args).slice(0, 80)})`);
                  const result = await executeToolCall(toolCall.name, toolCall.args, {
                    organizationId: session.organizationId,
                    assistantId: session.assistantId,
                    callSid: session.callSid,
                    callId: session.callRecordId,
                    transferRules: session.transferRules,
                    organization: session.organization,
                    callerPhone: session.callerPhone,
                    orgPhoneNumber: session.orgPhoneNumber,
                    telephonyProvider: session.telephonyProvider || "twilio",
                    scheduleSnapshot: session.scheduleSnapshot, // <-- ADD THIS
                  });
```

- [ ] **Step 6: Apply delta after write tool calls**

After each tool call result is received, check if it was a write operation and apply the delta. In the classic pipeline tool call loop (after the `executeToolCall` call), add:

```javascript
          // Apply optimistic cache delta for write operations
          if (session.scheduleSnapshot && toolResult.message) {
            if (toolCall.function.name === "book_appointment" && !toolResult.message.includes("not available") && !toolResult.message.includes("conflict")) {
              // Extract appointment info from the booking result
              scheduleCache.applyDelta(session.organizationId, "book", {
                appointment: {
                  id: "pending-" + Date.now(), // Temp ID — will be refreshed on next cache load
                  start_time: args.datetime,
                  duration_minutes: session.serviceTypes?.find((st) => st.id === args.service_type_id)?.duration_minutes || session.organization?.defaultAppointmentDuration || 30,
                  status: "confirmed",
                  practitioner_id: null,
                  service_type_id: args.service_type_id || null,
                },
              });
            }
            if (toolCall.function.name === "cancel_appointment") {
              // Cancellation invalidates cache (slot recomputation is complex)
              scheduleCache.invalidate(session.organizationId);
            }
          }
```

Add the same logic in the Gemini Live pipeline after `executeToolCall` returns.

- [ ] **Step 7: Clean up cache subscription on session end**

In the session cleanup function (around the `cleanupSession` definition or wherever sessions are cleaned up on disconnect), add:

```javascript
          // Unsubscribe from cache events
          if (session._cacheUnsub) {
            session._cacheUnsub();
            session._cacheUnsub = null;
          }
```

- [ ] **Step 8: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/server.js
git commit -m "feat(SCRUM-179): wire schedule cache into call lifecycle with delta updates"
```

---

## Task 6: Next.js — Webhook Invalidation Helper

**Files:**
- Create: `src/lib/voice-cache/invalidate.ts`
- Modify: `src/lib/calendar/tool-handlers.ts`

### 6.1 — Create the invalidation helper

- [ ] **Step 1: Create `src/lib/voice-cache/invalidate.ts`**

```typescript
/**
 * Fire a cache invalidation webhook to the voice server when schedule data
 * changes outside the voice server (dashboard, CRM, webhook).
 *
 * This is Layer 2 of the cache freshness strategy:
 * - Layer 1: Optimistic deltas (voice server writes, instant)
 * - Layer 2: Webhook invalidation (dashboard/CRM writes, <100ms) ← THIS
 * - Layer 3: TTL safety net (3 minutes, catches everything)
 */

const VOICE_SERVER_URL = process.env.VOICE_SERVER_PUBLIC_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

/**
 * Notify the voice server that an org's schedule data has changed.
 * Fire-and-forget — failures are logged but never block the caller.
 *
 * @param organizationId - The org whose schedule changed
 */
export async function invalidateVoiceScheduleCache(organizationId: string): Promise<void> {
  if (!VOICE_SERVER_URL || !INTERNAL_API_SECRET) {
    // Voice server not configured — skip silently
    return;
  }

  try {
    const res = await fetch(`${VOICE_SERVER_URL}/cache/invalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": INTERNAL_API_SECRET,
      },
      body: JSON.stringify({ organizationId }),
      signal: AbortSignal.timeout(3000), // 3s timeout — don't block the caller
    });

    if (!res.ok) {
      console.warn(`[VoiceCacheInvalidate] Voice server returned ${res.status} for org=${organizationId}`);
    }
  } catch (err: unknown) {
    // Fire-and-forget — log and move on
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[VoiceCacheInvalidate] Failed to invalidate cache for org=${organizationId}:`, message);
  }
}
```

- [ ] **Step 2: Commit helper**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add src/lib/voice-cache/invalidate.ts
git commit -m "feat(SCRUM-179): add voice server cache invalidation webhook helper"
```

### 6.2 — Add invalidation calls to calendar tool handlers

- [ ] **Step 3: Add invalidation call after successful bookings in `src/lib/calendar/tool-handlers.ts`**

Add the import at the top of the file:

```typescript
import { invalidateVoiceScheduleCache } from "@/lib/voice-cache/invalidate";
```

Then find `bookInternal()` (around line 1369). After the successful appointment insert and notification (around line 1543-1560), add:

```typescript
    // Invalidate voice server schedule cache (fire-and-forget)
    invalidateVoiceScheduleCache(organizationId).catch(() => {});
```

Similarly, find `handleCancelAppointment()` (around line 1009). After the successful status update to 'cancelled', add the same call:

```typescript
    // Invalidate voice server schedule cache (fire-and-forget)
    invalidateVoiceScheduleCache(organizationId).catch(() => {});
```

Also add it after any `handleLookupAppointment` operations that modify data (if any), and after `handleScheduleCallback` (if callbacks affect scheduling).

- [ ] **Step 4: Add invalidation to any dashboard API routes that modify appointments**

Search the codebase for other places where appointments, blocked_times, or practitioners are modified:

Common locations to add `invalidateVoiceScheduleCache(orgId).catch(() => {})`:
- Any PATCH/DELETE route for appointments in `src/app/api/v1/`
- Any POST/PATCH/DELETE route for blocked_times
- Any POST/PATCH/DELETE route for practitioners or service_types

For each route found, import the helper and add the fire-and-forget call after the successful DB operation.

- [ ] **Step 5: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add src/lib/calendar/tool-handlers.ts src/lib/voice-cache/invalidate.ts
# Also add any other modified API route files
git commit -m "feat(SCRUM-179): fire cache invalidation webhook after schedule mutations"
```

---

## Task 7: Wire Cache Into Test Call Path

**Files:**
- Modify: `voice-server/server.js` (test call WebSocket handler)

The test call path (`/ws/test`) uses `loadTestCallContext()` instead of `loadCallContext()`. It needs the same cache wiring.

- [ ] **Step 1: Find the test call WebSocket handler in `server.js`**

Search for `/ws/test` or `loadTestCallContext` in server.js. Add the same schedule cache logic (fetch snapshot, inject into prompt, pass to tool executor) that was added for the production call path in Task 5.

The pattern is identical:
1. After `loadTestCallContext()` returns, load/check schedule cache
2. Inject `buildLiveScheduleSection()` into the system prompt
3. Store `scheduleSnapshot` on the session
4. Pass it in tool executor context

- [ ] **Step 2: Commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add voice-server/server.js
git commit -m "feat(SCRUM-179): wire schedule cache into test call path"
```

---

## Task 8: Integration Testing & Verification

- [ ] **Step 1: Run all voice server tests**

Run: `cd /Users/michaelmakhoul/projects/phondo/voice-server && node --test 'tests/*.test.js'`
Expected: All tests PASS (zero failures)

- [ ] **Step 2: Run all Next.js tests**

Run: `cd /Users/michaelmakhoul/projects/phondo && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Run TypeScript type checking**

Run: `cd /Users/michaelmakhoul/projects/phondo && npx tsc --noEmit`
Expected: Zero type errors

- [ ] **Step 4: Run linting**

Run: `cd /Users/michaelmakhoul/projects/phondo && npm run lint`
Expected: Exit 0 (no errors)

- [ ] **Step 5: Manual verification**

Verify the following scenarios work:
1. Start a test call via browser → AI should mention available times without delay
2. Ask "when can I come in?" → AI responds instantly (no filler word, no tool call for today/tomorrow)
3. Ask "what about next Thursday?" → AI calls check_availability (may use cache or API depending on date)
4. Book an appointment → tool call still goes to API, booking succeeds
5. Start a second test call (same org) → should see the booking reflected in availability
6. Check voice server logs for `[ScheduleCache]` entries confirming cache hits/misses

- [ ] **Step 6: Final commit**

```bash
cd /Users/michaelmakhoul/projects/phondo
git add -A
git commit -m "feat(SCRUM-179): complete schedule cache integration with tests"
```

---

## Architecture Decision Records

### Why org-level cache (not session-level)?
Multiple assistants for the same org share the same appointment pool. A booking on Assistant A must immediately be visible to a concurrent call on Assistant B. Org-level ensures data consistency across all entry points.

### Why optimistic deltas for bookings, invalidation for cancellations?
Bookings are additive — easy to apply surgically (remove one slot, add one appointment). Cancellations free a slot, which requires recomputing availability considering blocked times and other appointments. This recomputation is complex and error-prone to do inline. Simpler and safer to invalidate and let the next read trigger a fresh fetch.

### Why 3-minute TTL?
Short enough to catch external changes (dashboard edits, CRM syncs) that bypass the webhook. Long enough that most calls (average 2-5 minutes for an SMB) complete within a single cache lifetime. 5 minutes was considered but felt too long for freshness guarantees; 1 minute was too aggressive (excessive DB queries for orgs with frequent calls).

### Why not Supabase Realtime?
Adds connection management complexity (subscribe per call, handle disconnects, reconnect logic) for an edge case (concurrent callers booking the same slot) that the existing DB conflict detection already handles gracefully. The in-process EventEmitter gives 90% of the benefit for 10% of the complexity. Supabase Realtime becomes worthwhile at agency tier (high call volume, many orgs).
