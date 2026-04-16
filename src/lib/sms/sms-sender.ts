/**
 * Utilities for computing and validating alphanumeric SMS sender IDs.
 *
 * Twilio alphanumeric sender ID rules (Australia + other supported countries):
 * - 1 to 11 characters total
 * - Alphanumeric + space only (no punctuation, no unicode)
 * - Must contain at least one letter
 *
 * Free to use in supported countries — no extra number rental.
 * One-way only (recipient can't reply) — fine for confirmations.
 */

const MAX_LENGTH = 11;

/**
 * Compute a default SMS sender from a business/org name.
 * Returns null if the name can't be sanitized into a valid sender.
 */
export function computeDefaultSmsSender(name: string | null | undefined): string | null {
  if (!name) return null;
  const sanitized = name
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH);
  if (!sanitized || !/[A-Za-z]/.test(sanitized)) return null;
  return sanitized;
}

/**
 * Validate a user-supplied sender ID. Returns null if valid, or an error message.
 */
export function validateSmsSender(sender: string): string | null {
  if (!sender) return "Sender cannot be empty";
  if (sender.length > MAX_LENGTH) return `Sender must be at most ${MAX_LENGTH} characters`;
  if (!/^[A-Za-z0-9 ]+$/.test(sender)) return "Sender can only contain letters, numbers, and spaces";
  if (!/[A-Za-z]/.test(sender)) return "Sender must contain at least one letter";
  return null;
}

/**
 * True if a string looks like a phone number (starts with + and digits).
 * Used to distinguish alphanumeric sender IDs from E.164 phone numbers.
 */
export function isPhoneNumberSender(sender: string): boolean {
  return /^\+\d+$/.test(sender);
}

/**
 * Shared marker for the "Reply STOP to opt-out" line in outbound SMS templates.
 * Keep templates and the opt-out rewriter in sync — if you change the text
 * of the opt-out line, update the `OPT_OUT_MARKER_TEXT` below and re-run
 * the sms-sender tests.
 *
 * The rewriter uses this regex to locate and replace the opt-out line when
 * the sender is alphanumeric (recipients can't reply to alphanumeric IDs).
 */
export const OPT_OUT_MARKER_TEXT = "Reply STOP to opt-out.";
// Matches "Reply STOP to opt-out" / "opt out" / "optout" (any hyphen/space)
// at the tail of the body, with or without the trailing period.
export const OPT_OUT_MARKER_RE = /\n+Reply STOP to opt[\s-]?out\.?\s*$/i;
