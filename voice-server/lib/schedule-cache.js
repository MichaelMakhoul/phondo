/**
 * Schedule Cache — Org-Level Shared In-Process Cache
 *
 * Eliminates mid-call HTTP round-trips for availability checks by caching
 * schedule snapshots (appointments, slots, practitioners, etc.) per org.
 *
 * Multiple concurrent call sessions for the same org share a single cache
 * entry. Node.js single-threaded execution means mutations are atomic
 * within a single event loop tick — no locking needed.
 *
 * Cache entries expire after CACHE_TTL_MS (3 minutes). Writes trigger
 * optimistic deltas so callers see their own mutations immediately.
 */

const { EventEmitter } = require("node:events");

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

/** @type {Map<string, { snapshot: object, fetchedAt: number }>} */
const cache = new Map();

const emitter = new EventEmitter();
// Prevent warnings when many concurrent calls subscribe for the same org
emitter.setMaxListeners(0);

/**
 * Returns cached ScheduleSnapshot or null if missing/expired.
 * @param {string} orgId
 * @returns {object|null}
 */
function getSchedule(orgId) {
  const entry = cache.get(orgId);
  if (!entry) return null;

  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(orgId);
    return null;
  }

  return entry.snapshot;
}

/**
 * Stores a snapshot with the current timestamp.
 * @param {string} orgId
 * @param {object} snapshot
 */
function setSchedule(orgId, snapshot) {
  cache.set(orgId, { snapshot, fetchedAt: Date.now() });
}

/**
 * Deletes the cache entry for an org and emits "schedule-changed".
 * @param {string} orgId
 */
function invalidate(orgId) {
  cache.delete(orgId);
  emitter.emit("schedule-changed", { orgId });
}

/**
 * Optimistic update after a write operation.
 *
 * - "book": pushes appointment to snapshot.appointments, removes the
 *   booked slot from snapshot.slots[dateKey], emits event.
 * - "cancel": invalidates the whole cache (slot recomputation is too
 *   complex to do inline).
 * - No-op if the org has no cache entry.
 *
 * @param {string} orgId
 * @param {"book"|"cancel"} action
 * @param {object} data - For "book": { appointment, dateKey, slotTime }
 */
function applyDelta(orgId, action, data) {
  const entry = cache.get(orgId);
  if (!entry) return;

  if (action === "cancel") {
    invalidate(orgId);
    return;
  }

  if (action === "book") {
    const { appointment, dateKey, slotTime } = data;
    const hasPractitioners = (entry.snapshot.practitioners || []).length > 0;

    if (hasPractitioners) {
      // Multi-practitioner orgs: we don't know which practitioner was assigned
      // (that happens server-side in pickPractitionerRoundRobin). A surgical
      // slot removal would be wrong — e.g., if 2 of 3 dentists are free at 9am,
      // removing the 9am slot hides valid availability. Safest to invalidate
      // and let the next read re-fetch from DB.
      invalidate(orgId);
      return;
    }

    // Single-practitioner / no-practitioner orgs: surgical delta is safe
    entry.snapshot.appointments.push(appointment);

    if (entry.snapshot.slots[dateKey]) {
      const dateSlots = entry.snapshot.slots[dateKey];
      if (Array.isArray(dateSlots)) {
        // Flat format — remove directly
        entry.snapshot.slots[dateKey] = dateSlots.filter((s) => s !== slotTime);
      } else if (dateSlots._any) {
        // Structured format — remove from _any
        dateSlots._any = dateSlots._any.filter((s) => s !== slotTime);
      }
    }

    emitter.emit("schedule-changed", { orgId });
  }
}

/**
 * Subscribe to schedule changes for a specific org.
 * Returns an unsubscribe function.
 *
 * @param {string} orgId
 * @param {function} callback - Called with { orgId }
 * @returns {function} unsubscribe
 */
function onScheduleChanged(orgId, callback) {
  const listener = (event) => {
    if (event.orgId === orgId) {
      callback(event);
    }
  };
  emitter.on("schedule-changed", listener);

  return () => {
    emitter.off("schedule-changed", listener);
  };
}

/**
 * Returns the number of cached orgs (for monitoring).
 * @returns {number}
 */
function getCacheSize() {
  return cache.size;
}

/**
 * Clears all cache entries (for testing).
 */
function clearAll() {
  cache.clear();
}

module.exports = {
  getSchedule,
  setSchedule,
  invalidate,
  applyDelta,
  onScheduleChanged,
  getCacheSize,
  clearAll,
  _test: {
    getEntry: (orgId) => cache.get(orgId),
    CACHE_TTL_MS,
  },
};
