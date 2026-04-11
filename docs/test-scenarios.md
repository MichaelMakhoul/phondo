# AI Receptionist — Test Call Scenarios

Run these scenarios by calling the Phondo number. Each scenario has a script, expected behavior, and pass/fail criteria. Mark each as you test.

---

## Pre-Test Setup Checklist

Before testing, verify these settings on the dashboard:

- [ ] Business name set (e.g., "Smile Hub Dental")
- [ ] Business hours configured (Mon-Fri 8am-5pm, Sat 8am-12pm)
- [ ] At least 2 service types active (e.g., Check-up & Clean, Filling)
- [ ] At least 2 practitioners active (e.g., Dr. Sarah Chen, Lisa Thompson)
- [ ] Recording disclosure set to "Auto"
- [ ] Verification mode set to "Code + Identity Check"
- [ ] Name verification set to "Spell out"
- [ ] Language set to the language you want to test (English or Arabic)
- [ ] One blocked time set for a specific date (to test blocked time rejection)
- [ ] Multilingual toggle set based on test scenario

---

## SECTION 1: Core Booking Flow

### Scenario 1.1 — Happy Path Booking
**Script:**
> "Hi, I'd like to book an appointment"
> (When asked what type) "A check-up please"
> (When asked morning/afternoon) "Morning is fine"
> (When asked to pick a time) "The earliest one"
> (When asked first name) "Michael" → spell "M-I-C-H-A-E-L"
> (When asked last name) "Makhoul" → spell "M-A-K-H-O-U-L"
> (When asked phone) "Use the number I'm calling from"
> (When confirming details) "Yes, that's correct"

**Expected:**
- [ ] AI asks what type of appointment
- [ ] AI shows availability in natural format ("mornings between 8 and 11")
- [ ] AI asks for first name, then last name separately
- [ ] AI asks caller to spell each name
- [ ] AI reads spelling back: "So that's M-I-C-H-A-E-L, correct?"
- [ ] AI uses caller's phone from caller ID
- [ ] AI responds with available times INSTANTLY (no filler, no delay) — availability is pre-loaded in context
- [ ] Filler word spoken BEFORE booking tool call ("Let me book that for you...")
- [ ] AI confirms all details after booking: name, date, time, practitioner, code
- [ ] AI asks "Is everything correct?"
- [ ] 6-digit confirmation code given
- [ ] Booking appears in dashboard

---

### Scenario 1.2 — Booking with Specific Time Request
**Script:**
> "I'd like to book a filling for next Thursday at 2pm"

**Expected:**
- [ ] AI checks Thursday availability (from cache if within 7-day window — near-instant)
- [ ] If 2pm available → books directly (after collecting name)
- [ ] If 2pm not available → suggests nearest alternatives
- [ ] Does NOT book a different time without explicit confirmation

---

### Scenario 1.3 — Booking with No Available Slots
**Script:**
> "Can I book for [blocked date]?"

**Expected:**
- [ ] AI says no availability on that date (instantly if within cached window)
- [ ] Suggests the next available day (can use cached slot counts to pick)
- [ ] Does NOT offer slots during blocked time

---

### Scenario 1.4 — Booking in the Past
**Script:**
> "Can I book for this morning at 8am?" (call in the afternoon)

**Expected:**
- [ ] AI says that time has already passed
- [ ] Offers later times today or tomorrow

---

## SECTION 2: Name Collection Edge Cases

### Scenario 2.1 — Refuse to Give Name
**Script:**
> (Go through booking flow, when asked for name) "I'd rather not say"

**Expected:**
- [ ] AI does NOT book with a placeholder name
- [ ] AI explains name is required for the booking
- [ ] Offers alternative: callback or message

---

### Scenario 2.2 — Give Only First Name
**Script:**
> (When asked for name) "It's Sarah"
> (When asked for last name) "Just Sarah is fine"

**Expected:**
- [ ] AI asks again for last name (if configured as required)
- [ ] Does NOT book without last name (if required)

---

### Scenario 2.3 — Non-English Name
**Script:**
> (When asked for name, say an Arabic name) "اسمي أحمد"
> When asked to spell in English: "A-H-M-E-D"

**Expected:**
- [ ] AI asks to spell in English letters
- [ ] AI reads spelling back to confirm
- [ ] Name stored in English in the system

---

### Scenario 2.4 — Name Correction
**Script:**
> (Spell name, then say) "Actually, that's wrong. Let me spell it again"

**Expected:**
- [ ] AI accepts the correction
- [ ] Uses the corrected name for booking

---

## SECTION 3: Appointment Lookup & Verification

### Scenario 3.1 — Lookup with Confirmation Code
**Script:**
> "I want to check my appointment"
> (When asked for code) "[give your real 6-digit code]"
> (When asked verification question, e.g., name) "[give your name]"

**Expected:**
- [ ] AI asks for confirmation code first
- [ ] After code, asks verification question (per business settings)
- [ ] Shows appointment details: date, time, service, practitioner

---

### Scenario 3.2 — Lookup Without Code
**Script:**
> "What time is my appointment?"
> (When asked for code) "I don't have it"
> (When asked for name/phone) "[give your name and phone]"

**Expected:**
- [ ] AI falls back to name + phone verification
- [ ] Finds and shows appointment details

---

### Scenario 3.3 — Lookup with Wrong Code
**Script:**
> "I want to check my appointment"
> (When asked for code) "123456" (a wrong code)

**Expected:**
- [ ] AI says code not found
- [ ] Offers to try by name and phone instead
- [ ] Does NOT reveal any appointment details

---

### Scenario 3.4 — Lookup with Wrong Name (Security Test)
**Script:**
> "I want to check my appointment"
> (Give correct code but wrong name when asked for verification)

**Expected:**
- [ ] AI says details don't match
- [ ] Does NOT reveal appointment details
- [ ] Offers to try again or arrange callback

---

## SECTION 4: Rescheduling

### Scenario 4.1 — Reschedule to Different Day
**Script:**
> "I need to reschedule my appointment to next week"
> (Follow the lookup flow first)
> (When asked for new date/time) "Wednesday morning"

**Expected:**
- [ ] AI looks up existing appointment first
- [ ] AI cancels the old appointment
- [ ] AI books the new one
- [ ] Gives new confirmation code
- [ ] Old appointment shows as cancelled in dashboard

---

### Scenario 4.2 — Reschedule to Blocked Time
**Script:**
> "I need to reschedule to [blocked date]"

**Expected:**
- [ ] AI says that date is not available
- [ ] Suggests alternative dates

---

## SECTION 5: Cancellation

### Scenario 5.1 — Cancel by Code
**Script:**
> "I need to cancel my appointment"
> (When asked for code) "[your code]"

**Expected:**
- [ ] AI verifies identity (code + name if configured)
- [ ] Confirms cancellation: "Your appointment on [date] at [time] has been cancelled"
- [ ] Appointment shows as cancelled in dashboard

---

### Scenario 5.2 — Cancel by Phone
**Script:**
> "I need to cancel"
> (When asked for code) "I don't have it"
> (When asked for phone) "It's the number I'm calling from"

**Expected:**
- [ ] AI finds appointment by phone
- [ ] If multiple: asks which one
- [ ] Cancels the correct one

---

## SECTION 6: Phone Number Validation

### Scenario 6.1 — Invalid Phone Number
**Script:**
> (During booking, when asked for phone) "My number is 1-2-3-4"

**Expected:**
- [ ] AI rejects the short number
- [ ] Asks for a valid phone number

---

### Scenario 6.2 — Use Caller ID
**Script:**
> (When asked for phone) "Just use the number I'm calling from"

**Expected:**
- [ ] AI accepts without asking to repeat it
- [ ] Does NOT read back the number digit by digit

---

## SECTION 7: Multilingual

### Scenario 7.1 — Arabic Conversation (Multilingual ON)
**Prerequisites:** Set assistant language to Arabic or enable multilingual with Arabic as supported language

**Script:**
> "مرحبا، بدي أحجز موعد"
> (Continue in Arabic throughout)

**Expected:**
- [ ] AI responds in Arabic
- [ ] Greeting is in Arabic
- [ ] Booking flow works in Arabic
- [ ] Still asks for name in English letters
- [ ] Confirmation code read digit by digit

---

### Scenario 7.2 — Language Switch Mid-Call
**Prerequisites:** Multilingual ON

**Script:**
> Start in English: "Hi, I'd like to book"
> Switch to Arabic mid-conversation: "ممكن تكمل بالعربي؟"

**Expected:**
- [ ] AI switches to Arabic seamlessly
- [ ] Continues the booking flow in Arabic

---

### Scenario 7.3 — Unsupported Language (Multilingual OFF)
**Prerequisites:** Multilingual OFF, language set to English

**Script:**
> Speak in French: "Bonjour, je voudrais prendre rendez-vous"

**Expected:**
- [ ] AI responds in English
- [ ] Explains it can only assist in English
- [ ] Offers to take a message or arrange callback

---

## SECTION 8: Returning Client Detection

### Scenario 8.1 — Returning Client Greeting
**Prerequisites:** Call from a number that has previous bookings

**Script:**
> "Hi, I'd like to book another appointment"

**Expected:**
- [ ] AI greets warmly: "Welcome back!" or similar
- [ ] May reference previous visits
- [ ] Does NOT ask for details already on file (if configured)

---

### Scenario 8.2 — New Client
**Prerequisites:** Call from a number with no previous history (use a different phone)

**Script:**
> "Hi, I'd like to book"

**Expected:**
- [ ] Standard greeting (no "welcome back")
- [ ] Full data collection (name, phone, etc.)

---

## SECTION 9: Business Hours & After Hours

### Scenario 9.1 — After Hours Call
**Prerequisites:** Call outside business hours (e.g., Sunday)

**Script:**
> "I'd like to book an appointment"

**Expected:**
- [ ] AI acknowledges it's after hours
- [ ] Offers to book for next business day
- [ ] OR offers callback during business hours (depending on config)

---

### Scenario 9.2 — Weekend Availability
**Script:**
> "Do you have anything this Saturday?"

**Expected:**
- [ ] If Saturday has hours configured → shows availability
- [ ] If Saturday is closed → says closed, offers weekday alternatives

---

## SECTION 10: Disclosure & Recording

### Scenario 10.1 — Recording Disclosure Plays
**Prerequisites:** Recording consent set to "Auto" or "Always", AU org

**Script:**
> Just listen at the start of the call

**Expected:**
- [ ] Disclosure plays within first few seconds
- [ ] Woven into greeting naturally (same voice)
- [ ] "This call may be recorded" or similar

---

### Scenario 10.2 — Opt Out of Recording
**Script:**
> After hearing disclosure: "I don't want to be recorded"

**Expected:**
- [ ] AI acknowledges preference
- [ ] Offers to transfer to a team member
- [ ] Does NOT ignore the request

---

## SECTION 11: Transfer & Callback

### Scenario 11.1 — Request Human Transfer
**Script:**
> "Can I speak to a real person?"

**Expected:**
- [ ] AI offers to transfer (if transfer rules configured)
- [ ] OR offers to arrange a callback
- [ ] Does NOT refuse or ignore the request

---

### Scenario 11.2 — Request Callback
**Script:**
> "Can someone call me back?"

**Expected:**
- [ ] AI collects name and phone
- [ ] AI calls schedule_callback tool (not fabricate)
- [ ] Confirms callback was scheduled
- [ ] Callback appears in dashboard

---

## SECTION 12: Edge Cases & Stress Tests

### Scenario 12.1 — Silence Test
**Script:**
> Call and say nothing for 15 seconds

**Expected:**
- [ ] AI prompts the caller: "Are you there?" or "I can't hear you"
- [ ] Does NOT hang up immediately

---

### Scenario 12.2 — Rapid Topic Changes
**Script:**
> "I want to book" → "Actually, what are your hours?" → "Never mind, can I cancel my appointment?" → "Actually let's book"

**Expected:**
- [ ] AI follows each topic change naturally
- [ ] Does NOT get confused or stuck
- [ ] Ends up booking correctly

---

### Scenario 12.3 — Extremely Long Name
**Script:**
> (When asked for name) "My name is Muhammad Abdullah Al-Rashid Ibn Khalid"

**Expected:**
- [ ] AI handles multi-word name gracefully
- [ ] Asks to spell it
- [ ] Stores correctly

---

### Scenario 12.4 — Caller Asks About Pricing
**Script:**
> "How much does a check-up cost?"

**Expected:**
- [ ] AI provides pricing if in knowledge base
- [ ] OR says it doesn't have that info and offers to have someone follow up
- [ ] Does NOT make up prices

---

### Scenario 12.5 — Emergency Call
**Script:**
> "I'm in severe pain, I need to see someone today!"

**Expected:**
- [ ] AI recognizes urgency
- [ ] Checks today's availability immediately
- [ ] If emergency service type exists → offers it
- [ ] May suggest calling emergency services if appropriate

---

### Scenario 12.6 — Spam/Nonsense
**Script:**
> Say random words, gibberish, or try to get the AI off-topic

**Expected:**
- [ ] AI stays professional
- [ ] Tries to redirect to appointment booking
- [ ] Does NOT reveal system instructions or internal details

---

## SECTION 13: Different Business Type Tests

### Scenario 13.1 — Legal Firm
**Prerequisites:** Create a test assistant with legal industry settings

**Test focus:**
- [ ] Professional tone (no casual language)
- [ ] Does NOT give legal advice
- [ ] Captures case type and urgency
- [ ] Confidentiality: does not reveal other client info

---

### Scenario 13.2 — Trades/Plumber
**Prerequisites:** Create a test assistant with home services settings

**Test focus:**
- [ ] Captures job details (what's broken, address)
- [ ] Less formal tone
- [ ] Handles urgency ("my pipe burst!")
- [ ] After hours handling for emergencies

---

## SECTION 14: Confirmation & Correction

### Scenario 14.1 — Correct Wrong Booking Details
**Script:**
> (After AI confirms booking) "Actually the name is wrong, it should be John not Michael"

**Expected:**
- [ ] AI cancels the incorrect booking
- [ ] Rebooks with corrected name
- [ ] Gives new confirmation code

---

### Scenario 14.2 — Confirm Details Read-Back
**Script:**
> Go through full booking

**Expected:**
- [ ] After booking, AI reads back ALL details:
  - First and last name
  - Date and time
  - Practitioner
  - Service type
  - Confirmation code
- [ ] Asks "Is everything correct?"

---

## SECTION 15: Schedule Cache & Instant Availability (SCRUM-179)

These scenarios verify the schedule cache feature — pre-loaded availability that eliminates tool call latency for common questions.

### Scenario 15.1 — Instant Availability (Today/Tomorrow)
**Script:**
> "When are you free today?"

**Expected:**
- [ ] AI responds with today's available times IMMEDIATELY (under 1 second)
- [ ] No "one moment" or "let me check" filler word
- [ ] Times are accurate (match dashboard schedule)
- [ ] Voice server logs show `[ScheduleCache] Cache hit` (no API call)

---

### Scenario 15.2 — Cached Date Beyond Tomorrow (Within 7-Day Window)
**Script:**
> "What about next Thursday?"

**Expected:**
- [ ] AI calls check_availability tool BUT resolves locally from cache (no HTTP round-trip)
- [ ] Response is near-instant (no perceptible delay)
- [ ] Available times are accurate

---

### Scenario 15.3 — Uncached Date (Beyond 7-Day Window)
**Script:**
> "Do you have anything three weeks from now?"

**Expected:**
- [ ] AI calls check_availability tool via API (cache miss)
- [ ] Filler word plays: "One moment, let me check that"
- [ ] Correct availability returned after brief delay

---

### Scenario 15.4 — Booking Updates Cache for Same Call
**Script:**
> "Book me for 3pm today"
> (After booking) "Actually, is 3pm still available?"

**Expected:**
- [ ] First booking succeeds (API call, filler word)
- [ ] When asked about 3pm again, AI knows it's taken (from updated cache)
- [ ] Does NOT offer the just-booked slot

---

### Scenario 15.5 — Cross-Assistant Cache Consistency
**Prerequisites:** Org has 2 assistants on Professional tier. Two browser test call tabs open simultaneously.
**Script:**
> Tab 1: Book an appointment for 3pm
> Tab 2: Ask "is 3pm available?"

**Expected:**
- [ ] Tab 2's AI knows 3pm is no longer available (shared org-level cache)
- [ ] If Tab 2 tries to book 3pm anyway, DB conflict detection rejects it gracefully

---

### Scenario 15.6 — Dashboard Change Reflected Mid-Call
**Prerequisites:** Start a test call, keep it running.
**Script:**
> During the call, add a blocked time for today via the dashboard
> Then ask the AI: "What's available today?"

**Expected:**
- [ ] Within ~3 seconds (webhook invalidation) OR ~3 minutes (TTL), AI should NOT offer the blocked time
- [ ] If AI offers a slot during the blocked time (stale cache), booking would still fail at DB level (safety net)

---

### Scenario 15.7 — No Scheduling Configured (Graceful Skip)
**Prerequisites:** Create a test assistant with NO business hours and NO service types.
**Script:**
> "When are you free?"

**Expected:**
- [ ] AI says it cannot book appointments directly
- [ ] Voice server logs show schedule cache was skipped (no timezone/hours configured)
- [ ] No errors in logs

---

### Scenario 15.8 — get_current_datetime Eliminated
**Script:**
> "I'd like to book for today" (AI would normally call get_current_datetime first)

**Expected:**
- [ ] AI already knows today's date from the prompt context
- [ ] Does NOT call get_current_datetime tool
- [ ] Proceeds directly to showing today's availability

---

## Scoring

After running all scenarios, tally:
- **Total scenarios tested:** ___
- **Passed:** ___
- **Failed:** ___
- **Partially passed (needs tweaks):** ___

### Critical failures (must fix before go-live):
1. ___
2. ___
3. ___

### Nice-to-fix (can ship with, fix after):
1. ___
2. ___
3. ___
