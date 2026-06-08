import { describe, it, expect } from "vitest";
import { getAppointmentLabels } from "../industry-labels";

describe("getAppointmentLabels (SCRUM-397)", () => {
  it("returns industry-specific labels for known industries", () => {
    expect(getAppointmentLabels("dental")).toEqual({ practitioner: "Dentist", service: "Treatment" });
    expect(getAppointmentLabels("legal")).toEqual({ practitioner: "Attorney", service: "Matter type" });
    expect(getAppointmentLabels("home_services")).toEqual({ practitioner: "Technician", service: "Job type" });
    expect(getAppointmentLabels("fitness")).toEqual({ practitioner: "Trainer", service: "Class" });
    expect(getAppointmentLabels("veterinary")).toEqual({ practitioner: "Vet", service: "Service" });
  });

  it("falls back to neutral defaults for unknown / generic / null industries", () => {
    const def = { practitioner: "Practitioner", service: "Service" };
    expect(getAppointmentLabels(null)).toEqual(def);
    expect(getAppointmentLabels(undefined)).toEqual(def);
    expect(getAppointmentLabels("")).toEqual(def);
    expect(getAppointmentLabels("universal")).toEqual(def);
    expect(getAppointmentLabels("other")).toEqual(def);
    expect(getAppointmentLabels("some_new_vertical")).toEqual(def);
  });
});
