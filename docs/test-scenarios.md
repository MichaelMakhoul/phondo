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

## SECTION 16: Specific Practitioner Booking (SCRUM-186)

These scenarios verify that callers can request a specific practitioner and the system correctly handles per-practitioner availability, time-off, and booking.

### Scenario 16.1 — Book with Specific Practitioner (Happy Path)
**Prerequisites:** 2+ practitioners active (e.g., Dr. Sarah Chen, Lisa Thompson). Both have open slots today.
**Script:**
> "I'd like to book a check-up with Dr. Sarah Chen"
> (Follow normal booking flow — name, phone, etc.)

**Expected:**
- [ ] AI checks Dr. Chen's specific availability (not aggregate)
- [ ] Offers times when Dr. Chen is free
- [ ] Booking confirmation includes "with Dr. Sarah Chen"
- [ ] Appointment in dashboard has Dr. Chen as assigned practitioner

---

### Scenario 16.2 — Requested Practitioner is Fully Booked
**Prerequisites:** Block all of Dr. Chen's remaining slots today via existing appointments.
**Script:**
> "I want to see Dr. Chen today"

**Expected:**
- [ ] AI says Dr. Chen is not available today
- [ ] Suggests alternative: "Dr. Chen is fully booked today, but Lisa Thompson has availability at [times]. Would you like to book with her, or would you prefer a different day with Dr. Chen?"
- [ ] Does NOT silently book with a different practitioner

---

### Scenario 16.3 — Practitioner on Day Off (Blocked Time)
**Prerequisites:** Add a blocked time for Dr. Chen for today via dashboard (select her name, mark "All day", reason "Personal day").
**Script:**
> "Is Dr. Chen available today?"

**Expected:**
- [ ] AI says Dr. Chen is not available today (recognizes the block)
- [ ] Suggests next day Dr. Chen is available OR offers another practitioner
- [ ] Does NOT show Dr. Chen's slots as available

---

### Scenario 16.4 — Practitioner on Lunch Break (Time-Specific Block)
**Prerequisites:** Add a blocked time for Lisa Thompson today 12:00-1:00 PM (title "Lunch break").
**Script:**
> "Can I book with Lisa at 12:30?"

**Expected:**
- [ ] AI says Lisa is not available at 12:30
- [ ] Offers Lisa's next available time (e.g., "Lisa is on break until 1 PM. She has a slot at 1:00 PM — would that work?")
- [ ] Does NOT offer 12:30 for any practitioner assignment

---

### Scenario 16.5 — Org-Level Block Still Works
**Prerequisites:** Add an org-level blocked time (no practitioner selected) for a time slot.
**Script:**
> "What's available at [blocked time]?"

**Expected:**
- [ ] AI says no one is available at that time
- [ ] Org-level block applies to ALL practitioners
- [ ] Works the same as before the per-practitioner feature

---

### Scenario 16.6 — Practitioner Not Found by Name
**Script:**
> "I'd like to see Dr. Johnson" (no practitioner by that name exists)

**Expected:**
- [ ] AI says it doesn't have a practitioner by that name
- [ ] Lists available practitioners: "We have Dr. Sarah Chen and Lisa Thompson. Would you like to book with one of them?"
- [ ] Does NOT guess or make up a practitioner

---

### Scenario 16.7 — Caller Doesn't Specify Practitioner (Round-Robin)
**Script:**
> "I'd like to book a check-up" (no practitioner preference mentioned)

**Expected:**
- [ ] AI proceeds with normal booking flow (aggregate availability)
- [ ] System auto-assigns practitioner via round-robin
- [ ] Booking confirmation mentions which practitioner was assigned

---

### Scenario 16.8 — Dashboard: Block Time for Specific Practitioner
**Script (dashboard, not voice):**
> Go to Settings > Calendar > Blocked Times
> Click "Block Time"
> Select a practitioner from the dropdown
> Set date, time, reason
> Save

**Expected:**
- [ ] Practitioner dropdown shows all active practitioners + "All staff (org-wide)" option
- [ ] Saved block shows practitioner name in the list
- [ ] Block only affects that practitioner's availability, not others

---

### Scenario 16.9 — Per-Practitioner Availability in Prompt
**Script:**
> "Who's working today?"
> "How busy is Dr. Chen?"

**Expected:**
- [ ] AI knows which practitioners are on staff
- [ ] AI can say how many appointments each has today
- [ ] AI mentions if a practitioner is off (has an all-day block)

---

## SECTION 17: Call Recording Playback (SCRUM-207)

Verifies recordings are captured by the provider, posted to the Next.js webhook, stored in Supabase Storage, and played back via signed URL in the dashboard.

### Scenario 17.1 — Telnyx Recording Round-Trip (Deferred)
**Prerequisites:** Provisioned Telnyx number linked to an active assistant. Recording mode `auto` or `always` (NOT `never`). Call Control Application webhook URL set to `${APP_PUBLIC_URL}/api/webhooks/telnyx-recording-done`.

> **Skip until Telnyx AU regulatory approval is re-started.** As of 2026-04-13 the telephony decision flipped to Twilio-primary for AU (see `telephony_provider_strategy.md`), so Telnyx is a dormant fallback. Run 17.2 instead — it exercises the same recording pipeline on the primary provider.

**Script:**
> Call the Telnyx number. Let the AI greet you. Have a ~30 second conversation. Hang up.

**Expected:**
- [ ] Voice server logs show `[Recording] Started Telnyx recording for callSid=... recordingId=...`
- [ ] Within ~15 seconds of hang-up, Next.js logs show `[telnyx-recording-done]` webhook 200
- [ ] `calls.recording_storage_path` is populated for the new row
- [ ] Supabase Storage bucket `call-recordings` contains `<org_id>/<call_id>.mp3`
- [ ] Dashboard call detail page renders an audio player (no auth prompt)
- [ ] Signed URL in the `<audio src>` has a `?token=...` query string

### Scenario 17.2 — Twilio Recording Round-Trip (Primary)
**Prerequisites:** Twilio number with voice-server `/twiml` configured as voice URL. Org recording_consent_mode = `auto` or `always`.

**Script:**
> Call the Twilio number. Have a short conversation. Hang up.

**Expected:**
- [ ] Voice server logs show `[Recording] Started Twilio recording for callSid=...`
- [ ] `[twilio-recording-done]` webhook returns 200 in Next.js logs within ~15s
- [ ] Recording downloaded and uploaded to Supabase Storage
- [ ] Dashboard plays it via signed URL, no basic-auth prompt

### Scenario 17.3 — Recording Mode `never`
**Prerequisites:** Set org `recording_consent_mode` to `never`.

**Script:**
> Place a test call.

**Expected:**
- [ ] TwiML ring-first fallback `<Connect>` does NOT include `record="record-from-answer"` (Twilio path)
- [ ] Voice server does NOT call `recordings.create` via Twilio REST (line `[Recording] Started Twilio recording` is absent)
- [ ] Voice server does NOT call Telnyx Call Control `record_start` (line `[Recording] Started Telnyx recording` is absent)
- [ ] No recording webhook fires
- [ ] `recording_storage_path` remains null
- [ ] Dashboard shows no Recording card

### Scenario 17.4 — Idempotent Webhook Retry
**Script:**
> Manually replay a recording-done webhook (curl with same signature/body, or replay from provider portal).

**Expected:**
- [ ] Second call returns `{ ok: true }` without re-uploading (helper short-circuits on `recording_sid` match)
- [ ] Storage object unchanged (same size, timestamp)
- [ ] No duplicate DB update

### Scenario 17.5 — Legacy Call (Pre-SCRUM-207)
**Prerequisites:** Open an older call row that has `recording_url` set but no `recording_storage_path`.

**Expected:**
- [ ] Dashboard shows "Legacy recording (stored with provider). This recording predates in-app playback." message
- [ ] Does NOT attempt to play the broken provider URL

### Scenario 17.6 — Signed URL Expiry
**Script:**
> Open a call detail page. Wait ~11 minutes without interacting. Click play.

**Expected:**
- [ ] Playback might fail (URL expired)
- [ ] Reloading the page fetches a fresh signed URL and works
- [ ] No sensitive URL leaks into page source (only a short-lived signed URL)

### Scenario 17.7 — APP_PUBLIC_URL Missing (Hard-Fail)
**Prerequisites:** Temporarily unset `APP_PUBLIC_URL` on the voice-server (Fly secret).
**Script:**
> Place a test call with recording mode = `auto`.

**Expected:**
- [ ] Voice server logs show `[Recording] APP_PUBLIC_URL not set — refusing to start recording`
- [ ] Sentry receives an exception event tagged `service: "recording-start"`
- [ ] No call to provider record-start API (Twilio `recordings.create` or Telnyx `record_start`)
- [ ] Call still proceeds normally — recording is just disabled
- [ ] `calls.recording_storage_path` remains null

---

## SECTION 18: Cleaned Transcript (SCRUM-208)

Verifies that post-call analysis produces a usable `cleaned_transcript` that strips STT artifacts (e.g., Korean/Hindi/Chinese tokens when the caller spoke Arabic/French/English).

### Scenario 18.1 — English-Only Call, Clean STT
**Script:**
> Have a completely English conversation (30s+).

**Expected:**
- [ ] `calls.cleaned_transcript` populated
- [ ] Dashboard transcript card shows Cleaned/Raw toggle buttons
- [ ] Cleaned view ≈ raw view (no unexpected rewriting)
- [ ] No `original` field on turns (because nothing changed)
- [ ] Default view is Cleaned

### Scenario 18.2 — Arabic Caller, STT Mis-Detection
**Prerequisites:** Assistant `supportedLanguages` = ["en", "ar"], multilingual enabled.
**Script:**
> Speak a few sentences in Arabic (e.g., "مرحبا، أريد حجز موعد غدا")

**Expected:**
- [ ] Raw transcript may contain garbled Korean/Hindi characters (known Gemini Live issue)
- [ ] Cleaned transcript shows the intended Arabic text
- [ ] `original` field retains the garbled STT output for comparison
- [ ] AI analysis summary is still sensible English
- [ ] Raw/Cleaned toggle lets you compare both views

### Scenario 18.3 — Mixed English + French
**Prerequisites:** `supportedLanguages` = ["en", "fr"], multilingual enabled.
**Script:**
> Greet in English, then switch to French mid-call.

**Expected:**
- [ ] Cleaned turns preserve the language each turn was actually spoken in
- [ ] No forced translation
- [ ] `language` field populated on each turn when detectable
- [ ] AI summary still in English (by design)

### Scenario 18.4 — Very Short Call (<20 chars transcript)
**Script:**
> Pick up, say "wrong number", hang up.

**Expected:**
- [ ] `cleaned_transcript` is null (analysis skipped for short calls)
- [ ] Dashboard falls back to Raw view automatically (toggle hidden)

### Scenario 18.5 — Severe STT Garbage (Can't Recover)
**Script:**
> Whisper or mumble unintelligibly for 20+ seconds.

**Expected:**
- [ ] Post-call analysis either returns `cleaned_transcript: null` or best-effort garbage
- [ ] No server crash, no pipeline failure
- [ ] Dashboard degrades gracefully to Raw

### Scenario 18.6 — Analysis Timeout / Failure
**Prerequisites:** Temporarily kill OpenAI API key in env.
**Script:**
> Make a normal test call.

**Expected:**
- [ ] Raw transcript still saved
- [ ] `cleaned_transcript` is null
- [ ] Dashboard still renders Raw view
- [ ] Sentry error logged for the missing key

### Scenario 18.7 — Cleanup Truncation Doesn't Drop Structured Fields
**Prerequisites:** Have a long, complex call (3+ minutes, multiple topics) that historically truncated `cleaned_transcript`.
**Script:**
> Place a long test call.

**Expected:**
- [ ] `calls.summary`, `caller_name`, `sentiment` are populated
- [ ] `calls.cleaned_transcript` may be null if cleanup truncated
- [ ] Sentry shows a separate `step: "cleanup"` exception WITHOUT a corresponding `step: "structured"` exception
- [ ] Dashboard displays the structured fields normally and falls back to Raw transcript view

---

## SECTION 19: Multilingual + Correction + Escape Hatch (SCRUM-209 / SCRUM-216)

Verifies the AI (1) auto-detects the caller's language without any per-assistant configuration, (2) honours corrections the caller makes to mis-heard data, and (3) falls back to a transfer-to-human or take-a-message escape hatch instead of looping forever on failed confirmations.

Note: there is NO "Multilingual Support" toggle or language multi-select in the assistant settings anymore — SCRUM-216 removed them. The assistant is always multilingual and always auto-detects.

### Scenario 19.1 — Auto-detect English (baseline)
**Prerequisites:** Any assistant. Dashboard has no language setting to configure.

**Script:**
> Call in English. Greet with "Hi, I'd like to book an appointment."

**Expected:**
- [ ] AI greets in English and responds in English throughout
- [ ] System prompt contains "You are multilingual. Auto-detect..." — NO "supportedLanguages" reference
- [ ] Cleaned transcript shows every turn with `language: "en"`

### Scenario 19.2 — Auto-detect Arabic
**Script:**
> Call and greet in Arabic: "مرحبا، أريد حجز موعد"

**Expected:**
- [ ] AI responds in Arabic from the first turn
- [ ] No "I can only assist in English" refusal
- [ ] Cleaned transcript turns labelled `language: "ar"` on user turns (at least)
- [ ] AI's letter spellings (if any) use Arabic letter names — documented caveat, acceptable for now

### Scenario 19.3 — Mid-call language switch
**Script:**
> Start in English ("Hi, I'm calling for an appointment"), switch to French mid-call ("Je voudrais changer l'heure"), then back to English.

**Expected:**
- [ ] AI switches to French when the caller switches
- [ ] AI switches back to English on the third turn
- [ ] No "please speak one language" complaints
- [ ] Cleaned transcript turns labelled with the correct language per turn

### Scenario 19.4 — Correction authority (the core bug fix)
**Script:**
> When the AI asks for your name and gets it wrong (e.g. hears "Michel" instead of "Michael"), correct it once: "No — it's Michael, with an 'a-e' in the middle." Continue the call normally. Let the AI use your name 3+ more times (confirmations, goodbye).

**Expected:**
- [ ] Immediately after the correction, the AI explicitly acknowledges the change ("Let me update that, Michael" or similar) — NOT silently re-confirming
- [ ] Every subsequent reference to your name in the call uses the corrected version, NOT the mis-heard one
- [ ] `calls.caller_name` in the DB at end of call matches the corrected name
- [ ] Cleaned transcript's structured fields match the corrected name

### Scenario 19.5 — Escape hatch WITH transfer available + office open
**Prerequisites:** Assistant has `behaviors.transferToHuman = true`, at least one active transfer rule exists, and the business is currently within business hours.

**Script:**
> When asked for your email, deliberately say something the AI is likely to mishear. Correct it twice ("No, it's actually michael..."). After the second correction, DO NOT correct it a third time — wait for the AI's response.

**Expected:**
- [ ] After the second failed confirmation, the AI stops re-confirming
- [ ] AI acknowledges the difficulty briefly ("I'm really sorry, I'm having trouble catching this") — it does NOT just silently retry
- [ ] AI offers BOTH options in a single turn: "Would you like me to transfer you to a team member who can help right now, or would you prefer I take a message and have them call you back?" — it ASKS, it does NOT auto-transfer
- [ ] If you pick transfer → `transfer_call` tool fires with the caller connected to the transfer target
- [ ] If you pick message → `schedule_callback` tool fires with the name + phone + notes captured so far
- [ ] If you say "just drop the email, forget about it" → AI respects the decision, confirms it won't use the email, and continues the call using the other info you already provided. Does NOT ask for the email again.
- [ ] No 4th or 5th re-confirmation loop under any path

### Scenario 19.6 — Escape hatch WITHOUT transfer (or after hours)
**Prerequisites:** Either `behaviors.transferToHuman = false` OR no active transfer rules OR the business is currently after hours.

**Script:**
> Same as 19.5 — mis-hear-then-correct twice on the email field. Stop correcting after the second attempt.

**Expected:**
- [ ] AI stops re-confirming after the second failure
- [ ] AI does NOT offer a transfer (because it's unavailable) — skips the two-option choice and goes directly to the message path
- [ ] AI says something like "I'm sorry, I'm having trouble with this — let me take a message and someone will call you back to get the details right"
- [ ] `schedule_callback` tool fires with the name + phone + notes captured so far
- [ ] If you say "just drop the email, forget about it" → AI respects the decision and continues with the info already captured
- [ ] The call ends cleanly, not in a confirmation loop

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
