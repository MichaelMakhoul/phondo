/**
 * SCRUM-619: the page's own volume for the assistant's voice, 0 to 1. A phone that
 * routes the session as a call can ignore its media volume keys; this always works.
 */

/**
 * The gain for a slider position: its square, so equal steps of the slider sound like
 * equal steps of loudness (half way is -12 dB, not -6).
 */
export function volumeGain(volume: number): number {
  const value = clampVolume(volume);
  return value * value;
}

/** A volume between 0 and 1; anything that isn't a number is full volume. */
export function clampVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
