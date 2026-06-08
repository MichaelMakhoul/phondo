import { describe, it, expect, vi } from "vitest";
import {
  diffAppointmentFields,
  classifyEditEvent,
  recordAppointmentEvent,
  type AppointmentSnapshot,
  type FieldChange,
} from "../events";

const base: AppointmentSnapshot = {
  name: "Michael Makhoul",
  phone: "+61414141883",
  email: "mike@example.com",
  notes: "back entrance",
  startTime: "2026-06-18T02:30:00Z",
  practitioner: "Dr Sarah Chen",
  service: "Check-up & Clean",
  status: "confirmed",
};

describe("diffAppointmentFields (SCRUM-398)", () => {
  it("returns [] when nothing changed", () => {
    expect(diffAppointmentFields(base, { ...base })).toEqual([]);
  });

  it("detects a single field change with resolved values", () => {
    const after = { ...base, name: "Mena Makhoul" };
    expect(diffAppointmentFields(base, after)).toEqual([
      { field: "name", from: "Michael Makhoul", to: "Mena Makhoul" },
    ]);
  });

  it("detects practitioner + time changes (resolved names, ISO time)", () => {
    const after = { ...base, practitioner: "Lisa Thompson", startTime: "2026-06-18T01:00:00Z" };
    const changes = diffAppointmentFields(base, after);
    expect(changes).toContainEqual({ field: "time", from: "2026-06-18T02:30:00Z", to: "2026-06-18T01:00:00Z" });
    expect(changes).toContainEqual({ field: "practitioner", from: "Dr Sarah Chen", to: "Lisa Thompson" });
  });

  it("treats trimmed/'' values as null (no spurious change)", () => {
    expect(diffAppointmentFields({ notes: "  hi  " }, { notes: "hi" })).toEqual([]);
    expect(diffAppointmentFields({ notes: "" }, { notes: null })).toEqual([]);
    expect(diffAppointmentFields({ notes: "x" }, { notes: "" })).toEqual([
      { field: "notes", from: "x", to: null },
    ]);
  });

  it("normalizes synthetic emails (synthetic↔blank is a no-op; synthetic→real is a change)", () => {
    const synthetic = "booking-abc-123@noreply.phondo.ai";
    expect(diffAppointmentFields({ email: synthetic }, { email: null })).toEqual([]);
    expect(diffAppointmentFields({ email: synthetic }, { email: "real@x.com" })).toEqual([
      { field: "email", from: null, to: "real@x.com" },
    ]);
  });

  it("detects a status change", () => {
    expect(diffAppointmentFields(base, { ...base, status: "cancelled" })).toEqual([
      { field: "status", from: "confirmed", to: "cancelled" },
    ]);
  });
});

describe("classifyEditEvent (SCRUM-398)", () => {
  const change = (field: FieldChange["field"]): FieldChange => ({ field, from: "a", to: "b" });

  it("is status_changed for a status-only change", () => {
    expect(classifyEditEvent([change("status")])).toBe("status_changed");
  });

  it("is edited when other fields change (even alongside status)", () => {
    expect(classifyEditEvent([change("name")])).toBe("edited");
    expect(classifyEditEvent([change("status"), change("name")])).toBe("edited");
  });

  it("defaults to edited for an empty change set", () => {
    expect(classifyEditEvent([])).toBe("edited");
  });
});

describe("recordAppointmentEvent (SCRUM-398)", () => {
  const input = {
    appointmentId: "a1",
    organizationId: "o1",
    eventType: "edited" as const,
    actorType: "staff" as const,
    channel: "dashboard" as const,
    changedFields: [{ field: "name" as const, from: "A", to: "B" }],
  };

  it("inserts into appointment_events with snake_case mapping", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const admin: any = { from: vi.fn().mockReturnValue({ insert }) };
    await recordAppointmentEvent(admin, input);
    expect(admin.from).toHaveBeenCalledWith("appointment_events");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        appointment_id: "a1",
        organization_id: "o1",
        event_type: "edited",
        actor_type: "staff",
        channel: "dashboard",
        changed_fields: input.changedFields,
      })
    );
  });

  it("skips a no-op edited/status_changed event (no changed fields)", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const admin: any = { from: vi.fn().mockReturnValue({ insert }) };
    await recordAppointmentEvent(admin, { ...input, changedFields: [] });
    expect(insert).not.toHaveBeenCalled();
  });

  it("never throws when the insert errors or throws (best-effort)", async () => {
    const erroring: any = { from: () => ({ insert: vi.fn().mockResolvedValue({ error: { message: "boom" } }) }) };
    const throwing: any = { from: () => ({ insert: vi.fn().mockRejectedValue(new Error("network")) }) };
    await expect(recordAppointmentEvent(erroring, input)).resolves.toBeUndefined();
    await expect(recordAppointmentEvent(throwing, input)).resolves.toBeUndefined();
  });
});
