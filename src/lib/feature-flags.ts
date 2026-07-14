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
