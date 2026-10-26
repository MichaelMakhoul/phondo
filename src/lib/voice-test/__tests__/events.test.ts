import { describe, it, expect, vi, afterEach } from "vitest";

// SCRUM-597: { type: "bookings_changed" } from the voice server becomes a window event
// the pages behind the bubble listen for. vitest runs in node: a minimal window
// (an EventTarget) stands in for the browser's.

import { BOOKINGS_CHANGED_EVENT, announceBookingsChanged, onBookingsChanged } from "../events";

afterEach(() => {
  delete (globalThis as any).window;
});

describe("bookings-changed events", () => {
  it("a listener runs on each announcement until it unsubscribes", () => {
    (globalThis as any).window = new EventTarget();
    const handler = vi.fn();
    const off = onBookingsChanged(handler);
    announceBookingsChanged();
    announceBookingsChanged();
    expect(handler).toHaveBeenCalledTimes(2);
    off();
    announceBookingsChanged();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(BOOKINGS_CHANGED_EVENT).toBe("phondo:bookings-changed");
  });

  it("is a no-op on the server (no window)", () => {
    expect(() => announceBookingsChanged()).not.toThrow();
    const off = onBookingsChanged(() => {});
    expect(() => off()).not.toThrow();
  });
});
