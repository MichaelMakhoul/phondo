// src/lib/owner-assistant/tool-names.ts
// SCRUM-586/598: the owner assistant's tool names — the internal route dispatches on
// this list (its switch is exhaustive over OwnerToolName). A module of its own so the
// route's tests mock the handlers with THIS list, never a copy that hides a new tool.
export const OWNER_TOOL_NAMES = [
  "owner_list_appointments",
  "owner_list_messages",
  "owner_reschedule_appointment",
  "owner_cancel_appointment",
  "owner_call_customer",
] as const;
export type OwnerToolName = (typeof OWNER_TOOL_NAMES)[number];
