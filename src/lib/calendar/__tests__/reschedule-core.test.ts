import { describe, it, expect } from "vitest";
import {
  resolveRescheduledBooking,
  decideRescheduleLeg,
  buildRescheduleLegFields,
  partitionRescheduleChanges,
} from "../reschedule-core";
import type { FieldChange } from "@/lib/appointments/events";

// SCRUM-399: pure helpers shared by the AI reschedule (tool-handlers) and the
// dashboard reschedule (appointments/[id] PATCH). The DB-touching orchestration
// lives in the callers; only the field-carryover + classification is unit-tested here.

describe("resolveRescheduledBooking (SCRUM-390/399 carry-over)", () => {
  const existing = {
    attendee_name: "Michael Makhoul",
    attendee_phone: "+61400000000",
    attendee_email: "mike@example.com",
    notes: "Prefers morning",
    service_type_id: "svc-1",
    practitioner_id: "prac-1",
  };

  it("carries over every field from the existing booking when args are empty", () => {
    expect(resolveRescheduledBooking({}, existing)).toEqual({
      first_name: "Michael",
      last_name: "Makhoul",
      phone: "+61400000000",
      email: "mike@example.com",
      notes: "Prefers morning",
      service_type_id: "svc-1",
      practitioner_id: "prac-1",
      carried_refs: { service_type: true, practitioner: true },
    });
  });

  it("flags caller-supplied vs carried refs (SCRUM-444: carried refs skip the active check)", () => {
    // Time-only move: both refs carried.
    expect(resolveRescheduledBooking({}, existing).carried_refs)
      .toEqual({ service_type: true, practitioner: true });
    // Caller explicitly picks a service → that ref must pass the active check.
    expect(resolveRescheduledBooking({ service_type_id: "svc-2" }, existing).carried_refs)
      .toEqual({ service_type: false, practitioner: true });
    // Caller explicitly picks a practitioner.
    expect(resolveRescheduledBooking({ practitioner_id: "prac-2" }, existing).carried_refs)
      .toEqual({ service_type: true, practitioner: false });
    // Nothing to carry when the existing booking has no refs.
    expect(resolveRescheduledBooking({}, { ...existing, service_type_id: null, practitioner_id: null }).carried_refs)
      .toEqual({ service_type: false, practitioner: false });
  });

  it("lets an explicit complete new name override the existing name", () => {
    const r = resolveRescheduledBooking({ first_name: "Jane", last_name: "Doe" }, existing);
    expect(r.first_name).toBe("Jane");
    expect(r.last_name).toBe("Doe");
  });

  it("overrides only the fields the caller supplied (practitioner change keeps the rest)", () => {
    const r = resolveRescheduledBooking({ practitioner_id: "prac-2" }, existing);
    expect(r.practitioner_id).toBe("prac-2");
    expect(r.service_type_id).toBe("svc-1");
    expect(r.email).toBe("mike@example.com");
    expect(r.notes).toBe("Prefers morning");
  });

  it("falls back to the existing phone when the caller gives none", () => {
    expect(resolveRescheduledBooking({}, existing).phone).toBe("+61400000000");
    expect(resolveRescheduledBooking({ phone: "+61411111111" }, existing).phone).toBe("+61411111111");
  });

  it("normalizes a missing existing optional field to undefined (not null)", () => {
    const sparse = {
      attendee_name: "Cher",
      attendee_phone: "+61400000000",
      attendee_email: null,
      notes: null,
      service_type_id: null,
      practitioner_id: null,
    };
    const r = resolveRescheduledBooking({}, sparse);
    expect(r.email).toBeUndefined();
    expect(r.notes).toBeUndefined();
    expect(r.service_type_id).toBeUndefined();
    expect(r.practitioner_id).toBeUndefined();
    expect(r.name).toBe("Cher"); // single-token name passed through as `name`
  });
});

describe("decideRescheduleLeg (SCRUM-399 leg-worthiness)", () => {
  const before = {
    start_time: "2026-07-01T02:00:00+00:00",
    practitioner_id: "prac-1",
    service_type_id: "svc-1",
  };

  it("is NOT a leg when no time/practitioner/service field is in the updates", () => {
    const d = decideRescheduleLeg(before, { attendee_phone: "+61400000000", notes: "x" });
    expect(d.isLeg).toBe(false);
    expect(d.timeChanged).toBe(false);
    expect(d.practitionerChanged).toBe(false);
    expect(d.serviceChanged).toBe(false);
  });

  it("is NOT a leg when start_time is re-sent but the instant is unchanged (format differs)", () => {
    // The picker round-trips "+00:00" → ".000Z" — same instant, must not count as a move.
    const d = decideRescheduleLeg(before, { start_time: "2026-07-01T02:00:00.000Z" });
    expect(d.timeChanged).toBe(false);
    expect(d.isLeg).toBe(false);
  });

  it("is a leg when the start_time instant changes", () => {
    const d = decideRescheduleLeg(before, { start_time: "2026-07-01T03:00:00.000Z" });
    expect(d.timeChanged).toBe(true);
    expect(d.isLeg).toBe(true);
  });

  it("is a leg when the practitioner changes", () => {
    const d = decideRescheduleLeg(before, { practitioner_id: "prac-2" });
    expect(d.practitionerChanged).toBe(true);
    expect(d.isLeg).toBe(true);
  });

  it("is NOT a leg when the practitioner key is present but unchanged", () => {
    const d = decideRescheduleLeg(before, { practitioner_id: "prac-1" });
    expect(d.practitionerChanged).toBe(false);
    expect(d.isLeg).toBe(false);
  });

  it("treats clearing the practitioner (value → null) as a change", () => {
    const d = decideRescheduleLeg(before, { practitioner_id: null });
    expect(d.practitionerChanged).toBe(true);
    expect(d.isLeg).toBe(true);
  });

  it("is a leg when the service type changes", () => {
    const d = decideRescheduleLeg(before, { service_type_id: "svc-2" });
    expect(d.serviceChanged).toBe(true);
    expect(d.isLeg).toBe(true);
  });
});

describe("buildRescheduleLegFields (SCRUM-399 new-row carry-over)", () => {
  const before = {
    attendee_name: "Michael Makhoul",
    attendee_first_name: "Michael",
    attendee_last_name: "Makhoul",
    attendee_phone: "+61400000000",
    attendee_email: "mike@example.com",
    start_time: "2026-07-01T02:00:00+00:00",
    end_time: "2026-07-01T02:30:00+00:00",
    duration_minutes: 30,
    status: "confirmed",
    notes: "Prefers morning",
    service_type_id: "svc-1",
    practitioner_id: "prac-1",
  };

  it("carries over every field from the old row, applying only a time change", () => {
    const fields = buildRescheduleLegFields(before, {
      start_time: "2026-07-01T03:00:00.000Z",
      end_time: "2026-07-01T03:30:00.000Z",
      duration_minutes: 30,
    });
    expect(fields.start_time).toBe("2026-07-01T03:00:00.000Z");
    expect(fields.end_time).toBe("2026-07-01T03:30:00.000Z");
    expect(fields.attendee_name).toBe("Michael Makhoul");
    expect(fields.attendee_email).toBe("mike@example.com");
    expect(fields.service_type_id).toBe("svc-1");
    expect(fields.practitioner_id).toBe("prac-1");
    expect(fields.notes).toBe("Prefers morning");
  });

  it("defaults the new leg's status to confirmed (a move is active, not the old status)", () => {
    const fields = buildRescheduleLegFields({ ...before, status: "pending" }, {
      start_time: "2026-07-01T03:00:00.000Z",
    });
    expect(fields.status).toBe("confirmed");
  });

  it("honors an explicit status in the updates", () => {
    const fields = buildRescheduleLegFields(before, {
      start_time: "2026-07-01T03:00:00.000Z",
      status: "pending",
    });
    expect(fields.status).toBe("pending");
  });

  it("applies a cleared (null) optional field from the updates", () => {
    const fields = buildRescheduleLegFields(before, {
      practitioner_id: null,
      attendee_email: null,
    });
    expect(fields.practitioner_id).toBeNull();
    expect(fields.attendee_email).toBeNull();
    // unchanged carry-overs stay
    expect(fields.service_type_id).toBe("svc-1");
  });

  it("applies an edited name (both denormalized parts and the display name)", () => {
    const fields = buildRescheduleLegFields(before, {
      attendee_first_name: "Mena",
      attendee_last_name: "Makhoul",
      attendee_name: "Mena Makhoul",
      practitioner_id: "prac-2",
    });
    expect(fields.attendee_first_name).toBe("Mena");
    expect(fields.attendee_name).toBe("Mena Makhoul");
  });
});

describe("partitionRescheduleChanges (SCRUM-399 leg vs in-place split)", () => {
  it("splits a mixed diff into structural (time/practitioner/service) and in-place (name/phone/email/notes)", () => {
    const changes: FieldChange[] = [
      { field: "time", from: "a", to: "b" },
      { field: "practitioner", from: "Smith", to: "Jones" },
      { field: "service", from: "Cleaning", to: "Checkup" },
      { field: "name", from: "Michael", to: "Mena" },
      { field: "phone", from: "1", to: "2" },
      { field: "email", from: null, to: "x@y.com" },
      { field: "notes", from: null, to: "note" },
    ];
    const { legWorthy, inPlace } = partitionRescheduleChanges(changes);
    expect(legWorthy.map((c) => c.field)).toEqual(["time", "practitioner", "service"]);
    expect(inPlace.map((c) => c.field)).toEqual(["name", "phone", "email", "notes"]);
  });

  it("excludes a status change from both buckets (the new leg's badge carries status)", () => {
    const changes: FieldChange[] = [
      { field: "time", from: "a", to: "b" },
      { field: "status", from: "confirmed", to: "pending" },
    ];
    const { legWorthy, inPlace } = partitionRescheduleChanges(changes);
    expect(legWorthy.map((c) => c.field)).toEqual(["time"]);
    expect(inPlace).toEqual([]);
  });

  it("returns empty buckets for an empty diff", () => {
    expect(partitionRescheduleChanges([])).toEqual({ legWorthy: [], inPlace: [] });
  });
});
