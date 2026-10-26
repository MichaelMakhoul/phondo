# Owner assistant: more control (task #13) — design

**Scope**, approved by the owner in chat on 2026-10-27 ("alright go with task 13"). The assistant can:
- book new jobs;
- block out time in the diary;
- mark callbacks done;
- ring back people from the messages.

All of it is still one job at a time, with no bulk changes, and nothing outside the owner's own bookings and messages.

Two PRs:
- **PR A — SCRUM-599:** book, block, mark done.
- **PR B — SCRUM-600:** ring back. It reuses SCRUM-598's customer-call machinery.

## Guards — every new tool inherits them
- **Only the owner.** The phone line needs the PIN gate; the browser needs the logged-in org owner. Tools dispatch only on the envelope's `ownerVerified` plus a production `callId`. Model arguments never grant either.
- **Read-back, then a clear yes.** The first call changes nothing and returns the read-back. The second needs `confirmed: true`, and the voice server's confirmation gate keys it on every field the read-back named. The owner must have spoken after the read-back. A yes to one thing never does another.
- **Limits.** The owner-write rate limit applies. Only Phondo's own diary: an org on Cliniko or Cal.com is refused ("book it in Cliniko"). One item per call.
- **Recorded.**
  - Every change is written to the audit trail (appointment_events) or linked to the owner call.
  - The owner's recap email lists it, built from the records.
  - The voice server's stored summary describes it from the result data, never the model's prose.
- **Customer contact** happens only when the owner chooses it ("let them know?"), with all of PR 1's text rules.

## PR A — SCRUM-599

### `owner_book_appointment`: book a new job
- **Arguments:**
  - `customer_name` (required);
  - `customer_phone` (required);
  - `start` (org-local `YYYY-MM-DDTHH:mm`, like a move's `new_datetime`);
  - `service_type_id` (optional), from the SERVICE TYPES list the owner prompt prints with IDs;
  - `notes` (optional, short);
  - `notify_customer` (`text` | `none`);
  - `confirmed`.
- **Read-back** ("Book Jane Smith (0412 345 678) for a hot water service on Thursday, October 29 at 2:00 PM?"):
  - checks the org uses Phondo's own diary;
  - checks the time parses, is ahead and is within the booking horizon;
  - checks the phone normalises;
  - asks "let them know?" with text or none. A call about a new booking isn't offered in v1.
- **The write:** `handleBookAppointment` (the receptionist's own booking path: hours, conflicts, confirmation code, practitioner assignment). It runs with `internal.callId` set to the owner call, so the booking links to that call.
- **After the write:**
  - an `appointment_events` row: `created`, `staff`, `voice`, `call_id` set to the owner call. The recap already reads `created` as "booked".
  - the cache is refreshed;
  - the confirmation text goes out if asked for, via `sendAppointmentConfirmationSMS`.
- **Outcomes:** `booked` | `needs_confirmation` | `slot_taken` | `invalid_time` | `not_booked` (the booking path's own reason) | `rate_limited` | `external_calendar`.

### `owner_block_time`: block out time
- **Arguments:** `start` and `end` (org-local `YYYY-MM-DDTHH:mm`), `reason` (optional short title, e.g. "Quote visit"), `confirmed`. A block covers everyone.
- **Read-back:**
  - **Wording:** "Block out Friday, October 30 from 1:00 PM to 5:00 PM for everyone?"
  - **Jobs already in that time are listed:** "they stay booked unless you move or cancel them". They're never touched.
  - **Limits:** end after start, the block ahead of now, at most 14 days. Longer goes to the dashboard.
- **The write:** a `blocked_times` row, the same as the dashboard's POST:
  - `title` from the reason, or "Time off";
  - `reason` reads "Added by your assistant";
  - `created_by` is the org owner's user id, when it can be read;
  - `created_on_call_id` is the owner call (new column);
  - then the voice schedule cache is invalidated.
- **Outcomes:** `blocked` | `needs_confirmation` | `invalid_time` | `rate_limited` | `external_calendar`.

### `owner_mark_callback_done`: mark a callback done
- **Arguments:** `callback_id` (from `owner_list_messages`), `note` (optional short), `confirmed`.
- **Read-back:** "Mark Sue Brown's callback (blocked drain, received Monday 9:12 AM) as done?" A callback already done or cancelled is `not_found`.
- **The write:** a conditional update from `pending` to `completed`, the same as `PATCH /api/v1/callbacks/[id]`:
  - `completed_at`;
  - `completed_by` is the org owner's user id;
  - `completion_notes` is the note, or "Marked done on your assistant line";
  - `completed_on_call_id` is the owner call (new column).
- **Outcomes:** `callback_done` | `needs_confirmation` | `not_found` | `rate_limited`.

### Migration 00173 (additive, needs owner go-ahead to apply)
`blocked_times.created_on_call_id uuid NULL REFERENCES calls(id) ON DELETE SET NULL`, and `callback_requests.completed_on_call_id`, the same. No policy changes: both tables keep their existing RLS.

### Recap email
`RecapChange` gains `blocked` and `callback_done`. `buildOwnerRecap` adds the call's blocks and the callbacks it marked done, from those columns. Example rows:
- "Blocked out Friday, October 30 from 1:00 PM to 5:00 PM (everyone)";
- "Marked Sue Brown's callback as done".

A new booking already reads "Booked Jane Smith for …".

### Voice server
- **`owner-tools.js`:**
  - three definitions;
  - the names added to `OWNER_TOOL_NAMES` and `OWNER_WRITE_TOOL_NAMES`;
  - `OWNER_CHANGE_TOOL_NAMES` gets the book and block tools, which change availability;
  - `OWNER_SUCCESS_OUTCOMES` gets `booked`, `blocked` and `callback_done`.
- **`owner-tool-runner.js`:**
  - the confirmation keys:
    - book: name, phone, start, service and notes;
    - block: start, end and reason;
    - callback: callback_id;
  - summary lines from the data;
  - the in-flight notices.
- **`owner-prompt.js`:**
  - the three flows;
  - "booking new jobs" comes off NOT IN THIS VERSION.
- **`tool-executor.js`:** test-mode simulation and the write list.

### Website
- `tool-names.ts`;
- the route's argument plucking (strings, `confirmed === true`);
- the three handlers;
- `customer-contact.ts` kind `booked` (text only);
- the recap;
- parity tests.

## PR B — SCRUM-600 (outline; detailed when PR A is done)
**`owner_call_customer` purpose `return_call`.** The assistant rings back a pending callback (or today's missed call) "about your message: …". The message is customer-written, so it's quoted, labelled as data and sanitized. The same checks apply:
- AU only;
- 8 am to 8 pm;
- the caps;
- do-not-call;
- the number must exactly match the callback's.

On the call, the receptionist's tools can book a job for them. After it:
- one outcome email with a Next step;
- the callback is NOT marked done automatically. The email says whether it can be, and the owner marks it (one tap, or "mark it done").

## Rulings
- Calls about a new booking aren't offered in v1 (text or none). Calls only exist for cancel, move, confirm and find-a-new-time.
- Blocking never cancels or moves jobs. It lists them, and the owner deals with each one.
- No unblock tool in v1: the dashboard removes blocks, and the recap email shows every block made.
- **Practitioner choice is deferred.** Neither owner session loads a staff list (both pass `practitioners: []`), so v1 has no `practitioner_id`. Bookings are assigned the way the receptionist's are, and blocks cover everyone; the read-back says "for everyone". Follow-up: load the staff for owner sessions, print them with IDs, then add `practitioner_id` to book and block.
- **Review round 1 rulings (2026-10-27):**
  - **Repeats are handed back, never doubled.** A booking with the same number and time on the same call returns the booking already made, checked before booking because two or more staff would otherwise take a second one. A block with the same start and end on the same call returns the block already made.
  - **A repeated booking's text is never sent twice.** The text log is read first; the text goes out only if the first attempt never got to it.
  - **All-day means one whole day,** as the dashboard makes it and shows it as one date. Longer blocks keep their start and end.
  - **A callback's note is read back and keyed,** because it's written to the record.
  - **Owner calls get 30 tool calls per call.** The classic pipeline still allows 10 rounds per turn.
  - **The diary check reads its two lookups with their faults.** A fault is "error", never "Phondo's own diary".
  - **The receptionist's schedule snapshot loads blocks that overlap its window.** Before this it loaded only blocks wholly inside the window.
  - **Deploy order is strict:** migration 00173, then the website, then the voice server. Before the migration, the recap's new reads fail.
