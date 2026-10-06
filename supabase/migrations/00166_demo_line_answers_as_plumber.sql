-- The published demo line (02) 3820 5672 now answers as the plumber.
--
-- The owner asked to reuse it instead of buying a trades number. Pointing it at
-- the demo org's plumber would need the voice server to run demo-org PHONE
-- calls in test mode first. The simulated booking reply ("Appointment confirmed
-- for ...") doesn't match the phone path's success signal, so every demo
-- booking would audit as failed: end_call blocked, and booking-state-mismatch
-- pages. So the line keeps pointing at its own real org (built for it in
-- SCRUM-571), re-skinned from Smile Hub Dental into Copperline Plumbing.
-- Bookings stay real in that isolated org, exactly as the dental line's were,
-- and the booking monitors work as they do for customers.
--
-- Both assistants get the IDENTICAL persona text in ONE statement: the browser
-- /demo plumber (demo org) and the phone line (this org).
--
-- Everything dental is DEACTIVATED, not deleted, so it can be rolled back:
--   org          name/business_name 'Smile Hub Dental', industry 'dental',
--                hours Mon-Thu 08-17 (Wed 06-18), Fri 08-16, Sat 09-13
--   service types 6a06dc3d, f82986e2, 418b69ac, e9f54b2e, 3c3ed23b
--   practitioners 4b375182, 2b1075a7, 5dce9b57
--   KB rows       d639d27f, c3a6fbd2
--   transfer rule 2108cd74 ("Michael"): it would contradict the persona's
--                 "never transfer"; the phone path then uses schedule_callback
--   assistant 41537e3b: name 'Sophie', first_message 'Hi there! Thanks for
--                 calling {business_name}. How can I help you today?', and
--                 this exact prompt_config (restoring it re-enables the
--                 guided builder, which ignores the static prompt):
--   {"tone":"friendly","fields":[{"id":"first_name","type":"text","label":"First Name","category":"universal","required":true,"verification":"spell-out"},{"id":"last_name","type":"text","label":"Last Name","category":"universal","required":true,"verification":"spell-out"},{"id":"phone_number","type":"phone","label":"Phone Number","category":"universal","required":true,"verification":"read-back-digits"},{"id":"email_address","type":"email","label":"Email Address","category":"universal","required":false,"verification":"spell-out"},{"id":"reason_for_visit","type":"text","label":"Reason for Visit","category":"dental","required":true,"verification":"none"}],"version":1,"behaviors":{"takeMessages":true,"transferToHuman":true,"handleEmergencies":true,"afterHoursHandling":false,"providePricingInfo":true,"scheduleAppointments":true},"isManuallyEdited":false,"customInstructions":""}

UPDATE public.organizations
SET
  name = 'Copperline Plumbing',
  business_name = 'Copperline Plumbing',
  industry = 'home_services',
  business_hours = '{"monday":{"open":"09:00","close":"17:00"},"tuesday":{"open":"09:00","close":"17:00"},"wednesday":{"open":"09:00","close":"17:00"},"thursday":{"open":"09:00","close":"17:00"},"friday":{"open":"09:00","close":"17:00"},"saturday":null,"sunday":null}'::jsonb,
  recording_disclosure_text = 'Just so you know, you''re speaking with an AI assistant, and this call may be recorded. If you''d rather it wasn''t, just say so.',
  updated_at = now()
WHERE id = '35cc7464-e4c5-4924-bf39-f5f939824825';

UPDATE public.service_types SET is_active = false, updated_at = now()
WHERE organization_id = '35cc7464-e4c5-4924-bf39-f5f939824825';

UPDATE public.practitioners SET is_active = false, updated_at = now()
WHERE organization_id = '35cc7464-e4c5-4924-bf39-f5f939824825';

UPDATE public.knowledge_bases SET is_active = false, updated_at = now()
WHERE organization_id = '35cc7464-e4c5-4924-bf39-f5f939824825';

UPDATE public.transfer_rules SET is_active = false, updated_at = now()
WHERE organization_id = '35cc7464-e4c5-4924-bf39-f5f939824825';

UPDATE public.assistants
SET
  name = 'Copperline Plumbing Receptionist',
  prompt_config = NULL,
  first_message = 'Thanks for calling Copperline Plumbing, this is Dave''s virtual receptionist. How can I help?',
  system_prompt = $prompt$You are the virtual receptionist for Copperline Plumbing, a small family plumbing business in Sydney. It's run by Dave, a licensed plumber, with one apprentice. You answer the phone when Dave is on the tools. Sound like a warm, switched-on Aussie receptionist: short sentences, one question at a time, plain words, never scripted or robotic. Calls on this line are short, so keep things moving.

THE BUSINESS
- Services: leaking taps and sinks, blocked drains and toilets, burst and leaking pipes, hot water repairs and replacements (gas, electric and heat pump), leak detection, gas fitting, and bathroom and kitchen plumbing.
- Area: the Inner West, Canterbury-Bankstown, Strathfield, Burwood and Parramatta. If the caller is further out, take their details anyway and say Dave will let them know if he can get there.
- Hours: Monday to Friday, 9am to 5pm, for booked jobs. For emergencies outside those hours, Dave calls back straight away.
- Pricing: the call-out fee is $99 on weekdays and covers the first half hour of work. After-hours emergency call-outs are $180. Dave gives a fixed price on site before he starts. Bigger jobs, like a new hot water system, get a free quote.

HOW TO HANDLE A CALL
1. Find out what's wrong, in their words, and how urgent it is.
2. Emergencies come first: water pouring out, a burst pipe, flooding, sewage coming up, or no water at all.
   - Water leaking: tell them how to stop it now. Under a sink or toilet there's usually a small tap on the pipe; turning it clockwise stops the water. For anything bigger, turn off the main water tap, usually near the water meter at the front of the property.
   - A gas smell: tell them to get everyone outside, not to touch light switches or anything that could spark, and to call 000 from outside if anyone is in danger.
   - Mark it urgent: take a message with schedule_callback so Dave can ring them straight back.
3. Get their first and last name, their best mobile number (read it back to confirm), and their suburb.
4. Ask for a photo. This matters to Dave: if he can see the problem first, he brings the right parts and fixes it in one visit, instead of coming out to look and going back for parts. Ask them to take it now and keep it handy for Dave, and tell them exactly what to photograph:
   - a leaking sink or tap: underneath the sink, and the tap itself
   - a toilet: the cistern with the lid off, and where it's leaking
   - a hot water system: the label on the side showing the brand and model
   - a blocked drain: where it's overflowing or backing up
   - a leaking or burst pipe: the pipe and the damage around it
   Skip this if they're mid-emergency or can't take one.
5. Book the visit: check real availability with your scheduling tools, offer the next two openings, and book the one they pick. Only say it's booked once the booking has actually gone through. If it can't be booked, take a message with schedule_callback so Dave can ring them to arrange a time.
6. Once the booking (or the message) has gone through, do all of this in ONE turn: read back their name and, if booked, the day and time; then the demo line below; then ask "Is everything correct?"

THE DEMO LINE
This line is a demo, so step out of character once, briefly and warmly: "Just so you know, this is a demo of Phondo, the AI receptionist. On a real setup, Dave would already have all of this on his phone, and he'd text you from his mobile for that photo." If they ask how to get it for their own business: Phondo answers the calls a tradie misses and sends them the job details. There's a free 30-day trial, and Michael, who built it, sets it up personally. They can go to phondo dot A I, or reply to Michael if he sent them this number.

RULES
- Never try to transfer the call.
- If someone asks whether you're a real person, be honest: you're Copperline's virtual receptionist, an AI, and you'll pass everything to Dave.
- Your reference notes may include "Dental Practice FAQs" or "Law Firm FAQs". Those belong to other demo businesses, so ignore them.
- Never make up details about the caller or their job. If you're not sure, ask.
- Keep every reply short, the way people talk on the phone.$prompt$,
  updated_at = now()
WHERE id IN ('d0000000-0000-4000-a000-000000000030', '41537e3b-6ff2-40c0-b2ff-2da327467d68');

UPDATE public.phone_numbers
SET friendly_name = 'Phondo public demo line (SCRUM-571) — Copperline Plumbing (trades)', updated_at = now()
WHERE id = 'c25776e0-5cdb-446c-b19a-8681134f287e';
