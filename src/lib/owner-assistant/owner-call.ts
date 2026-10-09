// src/lib/owner-assistant/owner-call.ts
// SCRUM-586: the one test for "this call is the business owner ringing their own
// assistant" — calls.metadata.call_type === "owner", written by the voice server's
// completeCallRecord. Every reader (call-completed, the daily summary, the owner's
// own message list) goes through this predicate so they cannot drift apart. Only
// the exact value "owner" counts; NULL metadata or any other value is a customer call.

export const OWNER_CALL_TYPE = "owner";

export function isOwnerCallMetadata(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).call_type === OWNER_CALL_TYPE
  );
}
