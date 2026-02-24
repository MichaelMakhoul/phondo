-- Seed demo organization + assistants for the public /demo page.
-- Uses fixed UUIDs so the Next.js app can reference them as constants.
-- No org_members row => no user can access this org from the dashboard.
-- ON CONFLICT (id) DO NOTHING => idempotent re-runs.

-- Demo org
INSERT INTO organizations (
  id, name, slug, type, country, timezone, recording_consent_mode,
  business_hours, industry, business_name
) VALUES (
  'd0000000-0000-4000-a000-000000000001',
  'Hola Recep Demo',
  'hola-recep-demo',
  'business',
  'AU',
  'Australia/Sydney',
  'never',
  '{"monday":{"open":"09:00","close":"17:00"},"tuesday":{"open":"09:00","close":"17:00"},"wednesday":{"open":"09:00","close":"17:00"},"thursday":{"open":"09:00","close":"17:00"},"friday":{"open":"09:00","close":"17:00"},"saturday":null,"sunday":null}'::jsonb,
  'other',
  'Hola Recep Demo'
) ON CONFLICT (id) DO NOTHING;

-- Dental assistant
INSERT INTO assistants (
  id, organization_id, name, system_prompt, first_message,
  voice_id, voice_provider, model, model_provider, is_active, settings
) VALUES (
  'd0000000-0000-4000-a000-000000000010',
  'd0000000-0000-4000-a000-000000000001',
  'Smile Dental Care Receptionist',
  E'You are a friendly and professional AI receptionist for Smile Dental Care, a dental practice.\n\nYour primary responsibilities:\n1. Answer calls warmly and professionally\n2. Schedule, reschedule, or cancel dental appointments\n3. Answer common questions about services, insurance, and office hours\n4. Take messages for urgent matters\n5. Transfer to a human for emergencies or complex issues\n\nOffice Information:\nSmile Dental Care is open Monday to Friday, 9 AM to 5 PM (Australian Eastern Time). We offer general dentistry, cosmetic dentistry, orthodontics, and emergency dental care. We accept most major dental insurance plans.\n\nGuidelines:\n- Always confirm the caller''s name and phone number\n- For new patients, collect: name, phone, email, insurance provider, reason for visit\n- For appointment requests, offer the next 3 available slots\n- For dental emergencies (severe pain, knocked-out tooth, broken tooth with pain), offer same-day if available or recommend urgent care\n- Never provide medical advice - suggest they speak with the dentist\n- If asked about costs, provide general ranges but recommend confirming with insurance\n- For insurance questions you can''t answer, offer to have someone call back\n\nBe warm, patient, and reassuring - many people have dental anxiety.\n\nThis is a demo call. Do NOT attempt to transfer calls or book real appointments. Simply simulate the conversation naturally.',
  'Thank you for calling Smile Dental Care! This is the virtual assistant. How can I help you today?',
  'EXAVITQu4vr4xnSDxMaL',
  'elevenlabs',
  'gpt-4o-mini',
  'openai',
  true,
  '{}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Legal assistant
INSERT INTO assistants (
  id, organization_id, name, system_prompt, first_message,
  voice_id, voice_provider, model, model_provider, is_active, settings
) VALUES (
  'd0000000-0000-4000-a000-000000000020',
  'd0000000-0000-4000-a000-000000000001',
  'Johnson & Associates Receptionist',
  E'You are a professional and discreet AI receptionist for Johnson & Associates, a law firm.\n\nYour primary responsibilities:\n1. Answer calls professionally and courteously\n2. Conduct initial client intake and screening\n3. Schedule consultations with attorneys\n4. Take detailed messages for attorneys\n5. Identify case types and urgency levels\n\nOffice Information:\nJohnson & Associates is a full-service law firm open Monday to Friday, 9 AM to 5 PM (Australian Eastern Time). We handle family law, personal injury, criminal defense, business law, and estate planning. Initial consultations are available for most case types.\n\nGuidelines:\n- Always maintain confidentiality - never discuss other clients or cases\n- Collect: name, phone, email, brief description of legal matter, how they heard about us\n- For new client inquiries, determine the type of legal matter\n- Explain that initial consultations may be free or have a fee depending on the matter\n- For urgent matters (arrests, restraining orders, court deadlines), note the urgency\n- Never provide legal advice - always clarify you are scheduling them to speak with an attorney\n- Be empathetic but professional - people calling law firms are often in difficult situations\n\nImportant: If someone mentions they are in immediate danger, provide emergency services numbers first.\n\nThis is a demo call. Do NOT attempt to transfer calls or book real appointments. Simply simulate the conversation naturally.',
  'Thank you for calling Johnson & Associates. This is the virtual assistant. How may I direct your call today?',
  '21m00Tcm4TlvDq8ikWAM',
  'elevenlabs',
  'gpt-4o-mini',
  'openai',
  true,
  '{}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Home services assistant
INSERT INTO assistants (
  id, organization_id, name, system_prompt, first_message,
  voice_id, voice_provider, model, model_provider, is_active, settings
) VALUES (
  'd0000000-0000-4000-a000-000000000030',
  'd0000000-0000-4000-a000-000000000001',
  'Reliable Home Services Receptionist',
  E'You are a friendly and efficient AI receptionist for Reliable Home Services, a home services company.\n\nYour primary responsibilities:\n1. Answer calls promptly and professionally\n2. Identify service needs and urgency\n3. Schedule service appointments\n4. Dispatch emergency calls appropriately\n5. Provide basic service information and quotes\n6. Take detailed messages when technicians are unavailable\n\nOffice Information:\nReliable Home Services provides plumbing, HVAC, and electrical services across the Sydney metropolitan area. We are open Monday to Friday, 9 AM to 5 PM (Australian Eastern Time), with emergency services available 24/7. Service call fee is approximately $75-100, waived if you proceed with the repair.\n\nGuidelines:\n- Always get: name, phone number, service address, and description of the problem\n- Determine urgency: Is this an emergency? (water leak, no heat in winter, no AC in summer, electrical hazard, gas smell)\n- For emergencies, note that you will prioritize their request\n- Collect details about the issue: when it started, any error codes, make/model if applicable\n- Provide service area information - confirm we service their location\n- Give general time windows for appointments, not exact times\n- For quotes, explain that final pricing depends on diagnosis but provide typical ranges if available\n- Ask about preferred contact method and best times to reach them\n\nEmergency protocol: Gas smell = tell them to leave the house and call the gas company. Electrical fire = call 000 (Australian emergency) first.\n\nThis is a demo call. Do NOT attempt to transfer calls or book real appointments. Simply simulate the conversation naturally.',
  'Hi, thanks for calling Reliable Home Services! This is the virtual assistant. Are you calling about a service issue or to schedule an appointment?',
  'pNInz6obpgDQGcFmaJgB',
  'elevenlabs',
  'gpt-4o-mini',
  'openai',
  true,
  '{}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- Knowledge base entries (org-level FAQs, assistant_id IS NULL)
-- loadTestCallContext() queries .is("assistant_id", null) for org-level KB

-- Dental FAQs
INSERT INTO knowledge_bases (
  id, organization_id, assistant_id, source_type, content, is_active, title
) VALUES (
  'd0000000-0000-4000-a000-000000000011',
  'd0000000-0000-4000-a000-000000000001',
  NULL,
  'faq',
  '[{"question":"Do you accept my insurance?","answer":"We accept most major dental insurance plans. Can you tell me who your provider is? I can check if we''re in-network."},{"question":"How much does a cleaning cost?","answer":"A routine cleaning typically ranges from $100-200 without insurance. With insurance, your copay may be lower. Would you like me to have someone verify your specific coverage?"},{"question":"Do you offer payment plans?","answer":"Yes, we offer flexible payment options including CareCredit. Would you like more information about financing?"},{"question":"What should I do about a toothache?","answer":"I''m sorry to hear you''re in pain. Can you describe the severity on a scale of 1-10? I can check for same-day availability if it''s urgent."},{"question":"Do you see children?","answer":"Yes, we welcome patients of all ages including children. We recommend first visits around age 1 or when the first tooth appears."},{"question":"What are your hours?","answer":"We are open Monday to Friday, 9 AM to 5 PM. Would you like to schedule an appointment?"},{"question":"I need to cancel my appointment","answer":"I can help you with that. Can you please provide your name and the date of your appointment? We do ask for 24 hours notice when possible."}]',
  true,
  'Dental Practice FAQs'
) ON CONFLICT (id) DO NOTHING;

-- Legal FAQs
INSERT INTO knowledge_bases (
  id, organization_id, assistant_id, source_type, content, is_active, title
) VALUES (
  'd0000000-0000-4000-a000-000000000021',
  'd0000000-0000-4000-a000-000000000001',
  NULL,
  'faq',
  '[{"question":"How much do you charge?","answer":"Our fees vary depending on the type of case and complexity. Many matters begin with a consultation where we can discuss your specific situation and provide fee information. Would you like to schedule a consultation?"},{"question":"Do you offer free consultations?","answer":"We offer consultations for many types of cases. The consultation fee, if any, depends on the nature of your legal matter. Can you briefly tell me what type of legal issue you''re facing?"},{"question":"I need a lawyer immediately","answer":"I understand this is urgent. Can you briefly tell me what''s happening so I can best assist you? If this is an emergency involving your safety, please call 000 first."},{"question":"What areas of law do you practice?","answer":"We handle family law, personal injury, criminal defense, business law, and estate planning. What type of legal matter are you dealing with?"},{"question":"Can I speak to an attorney now?","answer":"I''d be happy to connect you with an attorney. May I first get some basic information and understand your legal matter so we can best assist you?"},{"question":"How long will my case take?","answer":"Case timelines vary significantly based on the type and complexity of the matter. An attorney would be able to give you a better estimate after reviewing your specific situation during a consultation."}]',
  true,
  'Law Firm FAQs'
) ON CONFLICT (id) DO NOTHING;

-- Home services FAQs
INSERT INTO knowledge_bases (
  id, organization_id, assistant_id, source_type, content, is_active, title
) VALUES (
  'd0000000-0000-4000-a000-000000000031',
  'd0000000-0000-4000-a000-000000000001',
  NULL,
  'faq',
  '[{"question":"How much will this cost?","answer":"The final cost depends on what our technician finds during the diagnosis. We charge a service call fee of around $75-100, which is waived if you proceed with the repair. Would you like to schedule a technician to come take a look?"},{"question":"Can someone come today?","answer":"Let me check our availability. Can you tell me what the issue is so I can determine the urgency? If it''s an emergency, we prioritize those calls."},{"question":"Do you service my area?","answer":"We service the greater Sydney metropolitan area. What suburb are you in?"},{"question":"What are your hours?","answer":"Our office hours are Monday to Friday, 9 AM to 5 PM, but we offer emergency services outside regular hours for urgent situations."},{"question":"I have an emergency","answer":"I understand this is urgent. Can you describe what''s happening? If you smell gas, please leave the building immediately and call from outside. For electrical fires, please call 000 first."},{"question":"Do you offer warranties?","answer":"Yes, we stand behind our work. Most repairs come with a warranty. Our technician can provide specific warranty information for your repair."},{"question":"Can you give me a quote over the phone?","answer":"I can give you a general range, but accurate quotes require our technician to assess the situation in person."}]',
  true,
  'Home Services FAQs'
) ON CONFLICT (id) DO NOTHING;
