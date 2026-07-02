import crypto from "crypto";

/**
 * 6-digit booking confirmation code. Shared by the internal and Cliniko booking
 * paths; codes are UNIQUE table-wide (appointments_confirmation_code_key), so
 * inserts retry on 23505 collisions (see SCRUM-431 / SCRUM-450).
 */
export function generateConfirmationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}
