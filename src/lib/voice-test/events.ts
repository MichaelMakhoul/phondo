// SCRUM-597: the voice server tells the browser when an owner session changed a
// booking ({ type: "bookings_changed" } on /ws/test). The hook re-broadcasts it as a
// window event so whatever is open behind the bubble — the appointments list, the
// calendar, any server-rendered page — refreshes instead of showing the old time.

export const BOOKINGS_CHANGED_EVENT = "phondo:bookings-changed";

/** Broadcast that a booking changed. */
export function announceBookingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(BOOKINGS_CHANGED_EVENT));
}

/** Run `handler` whenever a booking changes; returns the unsubscribe (for a useEffect cleanup). */
export function onBookingsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(BOOKINGS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(BOOKINGS_CHANGED_EVENT, handler);
}
