// SCRUM-586: the reply both availability paths (built-in: tool-handlers.ts, and
// Cliniko: cliniko-booking.ts) give when no appointment type was chosen and the org
// has types to pick from. One builder, so the owner assistant can recognise this
// clarification and never read it to the owner as a list of free times. Its own
// module so the Cliniko path can use it without importing tool-handlers (a cycle).

const QUESTION = "Before I check availability, what type of appointment would you like to book?";

/** `typeLines` is the org's types, one "- Name (N min)" line each. */
export function serviceTypeQuestion(typeLines: string): string {
  return `${QUESTION}\n\nAvailable appointment types:\n${typeLines}\n\nPlease ask the caller which type they'd like to book.`;
}

/** True for a serviceTypeQuestion() reply — a request for the type, not availability. */
export function isServiceTypeQuestion(message: string): boolean {
  return message.startsWith(QUESTION);
}
