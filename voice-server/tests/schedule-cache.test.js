const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

function loadModule() {
  delete require.cache[require.resolve("../lib/schedule-cache")];
  return require("../lib/schedule-cache");
}

function makeSnapshot(overrides = {}) {
  return {
    appointments: [],
    blockedTimes: [],
    practitioners: [{ id: "p1", name: "Dr Smith", serviceTypeIds: ["st1"] }],
    slots: {
      "2026-04-12": [
        "2026-04-12T09:00:00",
        "2026-04-12T09:30:00",
        "2026-04-12T10:00:00",
      ],
    },
    serviceTypes: [{ id: "st1", name: "General Checkup", duration_minutes: 30 }],
    timezone: "Australia/Sydney",
    businessHours: {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
    },
    defaultDuration: 30,
    ...overrides,
  };
}

describe("schedule-cache", () => {
  let mod;

  beforeEach(() => {
    mod = loadModule();
  });

  describe("getSchedule", () => {
    it("returns null for unknown org", () => {
      assert.equal(mod.getSchedule("org-unknown"), null);
    });

    it("returns stored snapshot after setSchedule", () => {
      const snap = makeSnapshot();
      mod.setSchedule("org-1", snap);
      const result = mod.getSchedule("org-1");
      assert.deepEqual(result, snap);
    });

    it("returns null after TTL expiry", () => {
      const snap = makeSnapshot();
      mod.setSchedule("org-1", snap);

      // Backdate fetchedAt beyond TTL
      const entry = mod._test.getEntry("org-1");
      entry.fetchedAt = Date.now() - mod._test.CACHE_TTL_MS - 1;

      assert.equal(mod.getSchedule("org-1"), null);
    });
  });

  describe("org isolation", () => {
    it("does not leak data between orgs", () => {
      const snapA = makeSnapshot({ timezone: "Australia/Sydney" });
      const snapB = makeSnapshot({ timezone: "America/New_York" });

      mod.setSchedule("org-a", snapA);
      mod.setSchedule("org-b", snapB);

      assert.equal(mod.getSchedule("org-a").timezone, "Australia/Sydney");
      assert.equal(mod.getSchedule("org-b").timezone, "America/New_York");
    });
  });

  describe("invalidate", () => {
    it("removes the cache entry", () => {
      mod.setSchedule("org-1", makeSnapshot());
      mod.invalidate("org-1");
      assert.equal(mod.getSchedule("org-1"), null);
    });

    it("does not affect other orgs", () => {
      mod.setSchedule("org-1", makeSnapshot());
      mod.setSchedule("org-2", makeSnapshot());
      mod.invalidate("org-1");

      assert.equal(mod.getSchedule("org-1"), null);
      assert.notEqual(mod.getSchedule("org-2"), null);
    });
  });

  describe("applyDelta", () => {
    it("book: adds appointment and removes slot", () => {
      const snap = makeSnapshot();
      mod.setSchedule("org-1", snap);

      const appointment = {
        id: "apt-1",
        start_time: "2026-04-12T09:00:00",
        end_time: "2026-04-12T09:30:00",
        duration_minutes: 30,
        status: "confirmed",
        practitioner_id: "p1",
        attendee_name: "Jane Doe",
        service_type_id: "st1",
        confirmation_code: "ABC123",
      };

      mod.applyDelta("org-1", "book", {
        appointment,
        dateKey: "2026-04-12",
        slotTime: "2026-04-12T09:00:00",
      });

      const updated = mod.getSchedule("org-1");
      assert.equal(updated.appointments.length, 1);
      assert.deepEqual(updated.appointments[0], appointment);
      assert.equal(updated.slots["2026-04-12"].includes("2026-04-12T09:00:00"), false);
      assert.equal(updated.slots["2026-04-12"].length, 2);
    });

    it("cancel: invalidates cache entirely", () => {
      mod.setSchedule("org-1", makeSnapshot());
      mod.applyDelta("org-1", "cancel", { appointmentId: "apt-1" });
      assert.equal(mod.getSchedule("org-1"), null);
    });

    it("no-op when org has no cache entry", () => {
      // Should not throw
      mod.applyDelta("org-missing", "book", {
        appointment: { id: "apt-1" },
        dateKey: "2026-04-12",
        slotTime: "2026-04-12T09:00:00",
      });
      assert.equal(mod.getSchedule("org-missing"), null);
    });
  });

  describe("onScheduleChanged", () => {
    it("fires on invalidation", () => {
      mod.setSchedule("org-1", makeSnapshot());

      let fired = false;
      mod.onScheduleChanged("org-1", (event) => {
        fired = true;
        assert.equal(event.orgId, "org-1");
      });

      mod.invalidate("org-1");
      assert.equal(fired, true);
    });

    it("does NOT fire for a different org", () => {
      mod.setSchedule("org-1", makeSnapshot());
      mod.setSchedule("org-2", makeSnapshot());

      let fired = false;
      mod.onScheduleChanged("org-1", () => {
        fired = true;
      });

      mod.invalidate("org-2");
      assert.equal(fired, false);
    });

    it("fires on booking delta", () => {
      mod.setSchedule("org-1", makeSnapshot());

      let fired = false;
      mod.onScheduleChanged("org-1", (event) => {
        fired = true;
        assert.equal(event.orgId, "org-1");
      });

      mod.applyDelta("org-1", "book", {
        appointment: { id: "apt-1", start_time: "2026-04-12T09:30:00" },
        dateKey: "2026-04-12",
        slotTime: "2026-04-12T09:30:00",
      });

      assert.equal(fired, true);
    });

    it("unsubscribe stops callback from firing", () => {
      mod.setSchedule("org-1", makeSnapshot());

      let callCount = 0;
      const unsub = mod.onScheduleChanged("org-1", () => {
        callCount++;
      });

      mod.invalidate("org-1");
      assert.equal(callCount, 1);

      unsub();

      mod.setSchedule("org-1", makeSnapshot());
      mod.invalidate("org-1");
      assert.equal(callCount, 1);
    });
  });

  describe("getCacheSize", () => {
    it("reflects the number of cached orgs", () => {
      assert.equal(mod.getCacheSize(), 0);
      mod.setSchedule("org-1", makeSnapshot());
      assert.equal(mod.getCacheSize(), 1);
      mod.setSchedule("org-2", makeSnapshot());
      assert.equal(mod.getCacheSize(), 2);
      mod.invalidate("org-1");
      assert.equal(mod.getCacheSize(), 1);
    });
  });

  describe("clearAll", () => {
    it("removes all entries", () => {
      mod.setSchedule("org-1", makeSnapshot());
      mod.setSchedule("org-2", makeSnapshot());
      mod.clearAll();
      assert.equal(mod.getCacheSize(), 0);
      assert.equal(mod.getSchedule("org-1"), null);
      assert.equal(mod.getSchedule("org-2"), null);
    });
  });
});
