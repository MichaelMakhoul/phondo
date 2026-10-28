# Owner bookings follow each business's own required details

**Date:** 28 Oct 2026
**Builds on:** SCRUM-599/601. A follow-up to the owner's note on 28 Oct.

## The problem

SCRUM-601 told the owner assistant "a first name alone is fine". It also made owner bookings skip the business's required-last-name rule. That treats every business the same way.

Each business sets its own requirements. They live in the assistant's **Caller Data Collection** settings (`assistants.prompt_config.fields`, edited in Assistants → the assistant):

- **Universal fields:** first name and last name (required by default), phone (required), and email (optional by default).
- **Industry fields:**
  - home services: service address, problem description and urgency, all required;
  - dental: date of birth, insurance provider and reason for visit;
  - legal, veterinary, automotive and others each have their own.

A business can make any of these fields required or optional.

The receptionist asks callers for the required fields. But `handleBookAppointment` only enforces the name parts, so the other fields are collected by conversation alone.

## The rule

**An owner booking needs what that business's settings require.** Nothing more is asked for and nothing is skipped. All the checks happen before the read-back, so a booking never fails after the owner's yes.

## Design

1. **One source of truth.** The website's owner booking handler (`handleOwnerBookAppointment`) reads the same fields row that `handleBookAppointment` reads (org-scoped). The voice server doesn't need the list: the handler tells the model what is missing. Phone and browser sessions behave the same.
2. **Checked before any read-back:**
   - **First name:** always needed.
   - **Last name:** needed when the business requires it. A one-word name gets asked for its surname.
   - **Email:** needed when required. It comes in a new optional `customer_email` parameter and gets the booking path's existing format check.
   - **Every other required field** comes in a new `details` parameter: a list of `{ field, value }`, matched by the field's id or label.
   - **When something is missing,** the handler answers `invalid_details` and names everything missing in one go. For example: "This business's bookings also need John's last name, the service address and how urgent it is. Ask the owner, then call again." The answer also lists the missing fields as `data.missing_fields`.
3. **The read-back** says every detail it will save, using each field's own verification setting:
   - email spelled out;
   - an ID read back character by character;
   - a date of birth repeated;
   - the phone number digit by digit, as already done.
4. **Saving the booking:**
   - The email goes into the booking's email.
   - Other details are added to the job's note as `Label: value` lines, after the owner's own note. The note stays within the booking path's 500-character limit. If it can't fit, the handler asks the owner to shorten it; it is never cut silently.
   - Optional fields are not asked for, but are kept if the owner gives them.
5. **The rule applies to everyone again.** Revert the `!internal?.ownerBooking` last-name skip in `handleBookAppointment`. The owner handler checks first, so this check is only a backstop.
6. **When the owner says "I don't have his surname, just book it",** the booking is not made. The assistant says this business's settings need it, and that the owner can change that in Assistants → Caller Data Collection.
7. **Voice server:**
   - `owner_book_appointment` gains `customer_email` and `details`.
   - The confirmation-gate key includes both (details sorted by field), so a yes only confirms the exact details that were read back.
   - The prompt line "a first name alone is fine — never insist on a surname" becomes: "ask for exactly what the tool says this business needs — some need a last name, an email or an address — and nothing it doesn't".

## Tests

- **Per-business settings:**
  - last name required, and last name optional;
  - email required;
  - a home-services set (address, problem, urgency);
  - a dental set (date of birth, insurer);
  - a field the business made optional is never asked for.
- **Nothing fails after the yes:** every missing required field is caught before the read-back.
- **Details:**
  - matching by id or by label;
  - an unknown field is refused;
  - a blank value counts as missing;
  - an overlong note.
- **The read-back** says each detail using its own verification.
- **The gate:** a yes to one set of details never confirms another.
- **The parity test** (website ↔ voice gate) covers the new parameters.
- **The review battery and independent mutation rounds** run as before.
