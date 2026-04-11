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

    // Push the new appointment
    entry.snapshot.appointments.push(appointment);

    // Remove the booked slot from the date's available slots
    if (entry.snapshot.slots[dateKey]) {
      entry.snapshot.slots[dateKey] = entry.snapshot.slots[dateKey].filter(
        (s) => s !== slotTime
      );
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
