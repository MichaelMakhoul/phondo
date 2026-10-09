/**
 * Central UI feature flags.
 *
 * These gate what the product SHOWS to users, independent of any backend
 * capability. Keep them as plain module constants so they can be imported
 * from both server and client components and used for module-level filtering.
 */

/**
 * Master switch for every SMS / text-messaging surface in the UI.
 *
 * SMS is disabled for now — we don't yet have a registered A2P / alphanumeric
 * sender, so advertising or exposing SMS settings would promise a feature
 * customers can't use. While this is `false`, all SMS/text mentions are hidden
 * from the dashboard, pricing, and marketing pages.
 *
 * Backend send paths are independently gated and stay off regardless of this
 * flag (CALLER_SMS_ENABLED, DUNNING_SMS_ENABLED, CUSTOMER_SMS_ENABLED). To
 * bring SMS back, flip this to `true` AND re-check those backend gates.
 */
export const SMS_UI_ENABLED = false;

/**
 * Owner assistant line (SCRUM-585): shows Settings → "Your assistant line"
 * and opens /api/v1/owner-access. Read server-side only (the Settings page is
 * a server component; the route reads process.env), so no NEXT_PUBLIC mirror.
 *
 * Independent of the voice server's OWNER_ASSISTANT_ENABLED, which gates the
 * PIN prompt on real calls. Turn that one on first, then this one for the same
 * orgs so owners can register — never the reverse, or an owner could set a
 * PIN that nothing honours.
 */
export function isOwnerAssistantUiEnabled(): boolean {
  return process.env.OWNER_ASSISTANT_UI_ENABLED === "true";
}
