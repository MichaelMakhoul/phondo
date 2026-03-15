# Claude Code Implementation Prompt: Phondo AI Receptionist Platform

## Context & Background

You are working on **Phondo**, an AI Receptionist SaaS platform built with Next.js 15, Supabase, Vapi, and Stripe. Based on extensive market research, we're making strategic changes to align with actual market demand and maximize product-market fit.

### Key Market Research Findings

1. **The Problem is Quantified**: Small businesses lose an average of $126,000 annually from missed calls. 62% of inbound calls go unanswered, and 85% of customers who reach voicemail never call back.

2. **Best Entry Vertical**: Dental practices show the clearest product-market fit - they miss 30-68% of calls during business hours, and each missed new patient call costs $850-$1,300 in first-year revenue. 70% of dental practices are predicted to use AI receptionists by 2026.

3. **Pricing Sweet Spot**: The market gap is at $49-$199/month with flat-rate, predictable pricing. Per-minute billing creates the most customer complaints and churn.

4. **Self-Service Wins**: 78% of SMBs prefer self-serve SaaS adoption. Setup time expectations have compressed - users expect "up and running in under an hour."

5. **Critical Pain Points to Solve**:
   - Billing unpredictability (biggest churn driver)
   - Quality inconsistency
   - Missing calendar integrations
   - Spam call filtering (surprisingly high demand)
   - After-hours coverage

6. **Agency Model is Valid**: Vapi explicitly allows white-labeling when you build your own UI. Multiple platforms (Vapify, VoiceAIWrapper, VapiWrap) operate this way. Keep the agency tier but deprioritize it for Phase 2.

---

## Strategic Changes to Implement

### 1. Target Market Pivot: SMB-First, Agencies Later

**Current State**: Platform targets agencies as primary market with SMBs secondary.

**New Strategy**: Flip the priority. Target SMBs first (specifically dental practices), with agencies as a Phase 2 expansion.

**Rationale**: 
- SMBs have immediate, quantified pain ($126K/year lost revenue)
- Faster feedback loops and product iteration
- Agencies require more complex features (white-label, subaccounts, rebilling) that delay time-to-market
- Can still serve agencies later with proven SMB product

**Implementation**:
- Simplify onboarding flow for solo business owners
- Add "Industry" selection during onboarding (Dental, Legal, Home Services, Other)
- Create industry-specific templates and defaults
- Remove agency-specific UI elements from initial release

### 2. Pricing Model Overhaul

**Current Pricing** (problematic):
```
Free: $0/mo, 50 min, 1 assistant, 0 phone numbers
Starter: $49/mo, 500 min
Professional: $149/mo, 2000 min
Business: $349/mo, 5000 min
+ $0.15/min overage
```

**New Pricing** (market-aligned):
```
Starter: $49/mo
- 100 calls/month (not minutes - more predictable)
- 1 assistant
- 1 phone number
- Basic features (answering, transcripts, notifications)
- Email support

Professional: $99/mo  
- 250 calls/month
- 3 assistants
- 2 phone numbers
- Calendar integration (Cal.com, Calendly)
- Call transfer capability
- CRM webhook integration
- Priority support

Growth: $199/mo
- Unlimited calls
- 10 assistants
- 5 phone numbers
- Human escalation option
- Advanced analytics
- Custom voice selection
- White-glove onboarding call

Enterprise: Custom pricing
- Multi-location support
- Custom integrations
- Dedicated account manager
- SLA guarantees
```

**Key Changes**:
- Switch from minutes to calls (more predictable for users)
- Remove free tier (creates tire-kickers, not converters)
- Offer 14-day free trial instead
- No overage charges - upgrade prompts when approaching limits
- 30-day money-back guarantee

### 3. Feature Priority Reordering

**Must-Have for MVP (Phase 1)**:
1. ✅ AI call answering (already built)
2. ✅ Phone number provisioning (already built)
3. ✅ Call transcripts and recordings (already built)
4. ⏳ Browser-based test calls (critical for activation)
5. ❌ Knowledge base from website URL (critical for setup speed)
6. ❌ Real-time notifications (email + SMS summaries)
7. ❌ Spam call filtering
8. ❌ Basic calendar integration (Cal.com)
9. ❌ Call transfer to human fallback
10. ❌ Industry-specific templates (Dental, Legal, Home Services)

**Phase 2 (Post-Launch)**:
- Advanced analytics and ROI reporting
- Bilingual support (English/Spanish)
- Outbound calling (appointment reminders)
- CRM integrations (HubSpot, then vertical-specific)
- Human escalation service option

**Phase 3 (Agency Features)**:
- White-label branding
- Subaccount management
- Rebilling system
- Custom domains

---

## Technical Implementation Tasks

### Task 1: Database Schema Updates

Update the Supabase schema to support new requirements:

```sql
-- Add industry and business context to organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_phone TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_address TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_website TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{"monday": {"open": "09:00", "close": "17:00"}, "tuesday": {"open": "09:00", "close": "17:00"}, "wednesday": {"open": "09:00", "close": "17:00"}, "thursday": {"open": "09:00", "close": "17:00"}, "friday": {"open": "09:00", "close": "17:00"}, "saturday": null, "sunday": null}';

-- Add industry enum type
CREATE TYPE industry_type AS ENUM ('dental', 'legal', 'home_services', 'medical', 'real_estate', 'other');

-- Knowledge base table for website scraping and FAQs
CREATE TABLE IF NOT EXISTS knowledge_bases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL CHECK (source_type IN ('website', 'faq', 'document', 'manual')),
    source_url TEXT,
    content TEXT NOT NULL,
    content_embedding VECTOR(1536), -- For semantic search if needed later
    metadata JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX idx_knowledge_bases_assistant ON knowledge_bases(assistant_id) WHERE is_active = true;
CREATE INDEX idx_knowledge_bases_org ON knowledge_bases(organization_id);

-- Call outcomes table for better analytics
ALTER TABLE calls ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('answered', 'voicemail', 'transferred', 'spam', 'abandoned', 'failed'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_spam BOOLEAN DEFAULT false;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_phone TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS caller_name TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS action_taken TEXT; -- e.g., 'appointment_booked', 'message_taken', 'transferred', 'info_provided'
ALTER TABLE calls ADD COLUMN IF NOT EXISTS follow_up_required BOOLEAN DEFAULT false;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative'));

-- Calendar integrations table
CREATE TABLE IF NOT EXISTS calendar_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id UUID REFERENCES assistants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('cal_com', 'calendly', 'google_calendar')),
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    calendar_id TEXT,
    booking_url TEXT,
    settings JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Call transfer configurations
CREATE TABLE IF NOT EXISTS transfer_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    trigger_keywords TEXT[], -- Keywords that trigger transfer
    trigger_intent TEXT, -- e.g., 'emergency', 'complaint', 'complex_question'
    transfer_to_phone TEXT NOT NULL,
    transfer_to_name TEXT,
    announcement_message TEXT, -- What AI says before transferring
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email_on_missed_call BOOLEAN DEFAULT true,
    email_on_voicemail BOOLEAN DEFAULT true,
    email_on_appointment_booked BOOLEAN DEFAULT true,
    email_daily_summary BOOLEAN DEFAULT true,
    sms_on_missed_call BOOLEAN DEFAULT false,
    sms_on_voicemail BOOLEAN DEFAULT false,
    sms_phone_number TEXT,
    webhook_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Industry-specific templates
CREATE TABLE IF NOT EXISTS assistant_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    industry TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    first_message TEXT NOT NULL,
    sample_faqs JSONB DEFAULT '[]',
    voice_id TEXT,
    recommended_settings JSONB DEFAULT '{}',
    is_featured BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscription changes: switch to call-based limits
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS calls_limit INTEGER;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS calls_used INTEGER DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS assistants_limit INTEGER;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS phone_numbers_limit INTEGER;

-- Usage tracking update for calls instead of minutes
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS record_type TEXT DEFAULT 'call' CHECK (record_type IN ('call', 'minute', 'sms', 'transfer'));

-- RLS policies for new tables
ALTER TABLE knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_templates ENABLE ROW LEVEL SECURITY;

-- Knowledge bases: org members can read/write their org's data
CREATE POLICY "Users can manage their org knowledge bases" ON knowledge_bases
    FOR ALL USING (
        organization_id IN (
            SELECT organization_id FROM org_members WHERE user_id = auth.uid()
        )
    );

-- Calendar integrations: org members can manage
CREATE POLICY "Users can manage their org calendar integrations" ON calendar_integrations
    FOR ALL USING (
        organization_id IN (
            SELECT organization_id FROM org_members WHERE user_id = auth.uid()
        )
    );

-- Transfer rules: org members can manage
CREATE POLICY "Users can manage their org transfer rules" ON transfer_rules
    FOR ALL USING (
        organization_id IN (
            SELECT organization_id FROM org_members WHERE user_id = auth.uid()
        )
    );

-- Notification preferences: users can manage their own
CREATE POLICY "Users can manage their notification preferences" ON notification_preferences
    FOR ALL USING (user_id = auth.uid());

-- Assistant templates: anyone can read
CREATE POLICY "Anyone can read assistant templates" ON assistant_templates
    FOR SELECT USING (true);
```

### Task 2: Onboarding Flow Redesign

Create a new multi-step onboarding flow optimized for "5-minute to first call":

**File: `app/(auth)/onboarding/page.tsx`**

The onboarding flow should have these steps:

1. **Step 1: Business Info** (30 seconds)
   - Business name
   - Industry selection (dropdown: Dental Practice, Law Firm, Home Services, Medical Practice, Real Estate, Other)
   - Business phone number
   - Website URL (optional but encouraged)

2. **Step 2: AI Receptionist Setup** (2 minutes)
   - Auto-select industry template based on Step 1
   - Show pre-filled system prompt (editable)
   - Show pre-filled greeting message (editable)
   - Voice selection with audio preview
   - If website URL provided, show "Import from website" button

3. **Step 3: Test Your AI** (2 minutes)
   - Browser-based test call using Vapi Web SDK
   - Show real-time transcript
   - Allow immediate edits and re-test
   - "Sounds good!" button to proceed

4. **Step 4: Go Live** (1 minute)
   - Phone number selection (area code picker)
   - Show pricing tiers with "Start 14-day free trial" CTA
   - Credit card collection (Stripe Elements)
   - Forward existing number option (instructions)

**Key UX Requirements**:
- Progress indicator showing all steps
- Back button on each step
- Save progress to localStorage (resume if user leaves)
- Skip option for test call (but discourage it)
- Mobile-responsive design
- Auto-save drafts every 30 seconds

### Task 3: Website Knowledge Base Scraping

Implement website scraping to auto-generate assistant knowledge base:

**File: `app/api/knowledge-base/scrape/route.ts`**

```typescript
// Endpoint: POST /api/knowledge-base/scrape
// Body: { url: string, assistantId: string }

// Implementation requirements:
// 1. Validate URL format and accessibility
// 2. Use a web scraping library (cheerio + node-fetch, or Puppeteer for JS-heavy sites)
// 3. Extract:
//    - Business name and contact info
//    - Services offered
//    - Hours of operation
//    - FAQ content
//    - About page content
//    - Pricing information (if public)
// 4. Clean and structure the content
// 5. Generate a condensed knowledge base suitable for AI context
// 6. Store in knowledge_bases table
// 7. Update assistant's system prompt to reference the knowledge base

// Scraping strategy:
// - Start with homepage
// - Follow links to: /about, /services, /faq, /contact, /hours, /pricing
// - Limit to 10 pages max
// - Timeout: 30 seconds total
// - Handle common CMS structures (WordPress, Squarespace, Wix)

// Output format for knowledge base:
/*
BUSINESS INFORMATION:
- Name: [extracted]
- Address: [extracted]
- Phone: [extracted]
- Hours: [extracted]

SERVICES:
- [Service 1]: [description]
- [Service 2]: [description]

FREQUENTLY ASKED QUESTIONS:
Q: [question]
A: [answer]

ADDITIONAL CONTEXT:
[any other relevant business info]
*/
```

**File: `lib/scraper.ts`**

Create a utility module for web scraping with these functions:
- `scrapeWebsite(url: string): Promise<ScrapedContent>`
- `extractBusinessInfo(html: string): BusinessInfo`
- `extractFAQs(html: string): FAQ[]`
- `extractServices(html: string): Service[]`
- `generateKnowledgeBase(scraped: ScrapedContent): string`

### Task 4: Browser Test Calls (Vapi Web SDK)

Implement browser-based test calls for instant feedback:

**File: `components/test-call/TestCallModal.tsx`**

```typescript
// Requirements:
// 1. Use Vapi Web SDK (@vapi-ai/web)
// 2. Request microphone permission with clear UI
// 3. Show real-time transcript during call
// 4. Show call duration
// 5. Allow user to end call anytime
// 6. After call: show full transcript, allow replay, allow edits to assistant

// UI States:
// - Idle: "Test Your AI Receptionist" button
// - Requesting permission: Microphone permission prompt
// - Connecting: "Connecting..." spinner
// - Active call: 
//   - Green "talking" indicator
//   - Real-time transcript (scrolling)
//   - Duration timer
//   - Red "End Call" button
// - Call ended:
//   - Full transcript
//   - "Call Again" button
//   - "Edit Assistant" button
//   - "Sounds Good, Continue" button

// Important: 
// - Use the assistant's actual Vapi ID for the test
// - Don't consume user's call quota for test calls (flag in Vapi metadata)
// - Handle errors gracefully (no mic, network issues, Vapi errors)
```

**File: `app/api/vapi/web-call-token/route.ts`**

Create an endpoint to generate temporary Vapi web call tokens:
- Validate user is authenticated
- Validate user owns the assistant
- Generate Vapi web call token
- Return token to client

### Task 5: Industry-Specific Templates

Create pre-built templates for target industries:

**File: `lib/templates/dental.ts`**

```typescript
export const dentalTemplate = {
  industry: 'dental',
  name: 'Dental Practice Receptionist',
  description: 'Optimized for dental offices - handles appointment scheduling, insurance questions, and emergency triage.',
  
  systemPrompt: `You are a friendly and professional AI receptionist for {business_name}, a dental practice.

Your primary responsibilities:
1. Answer calls warmly and professionally
2. Schedule, reschedule, or cancel dental appointments
3. Answer common questions about services, insurance, and office hours
4. Take messages for urgent matters
5. Transfer to a human for emergencies or complex issues

Office Information:
{knowledge_base}

Guidelines:
- Always confirm the caller's name and phone number
- For new patients, collect: name, phone, email, insurance provider, reason for visit
- For appointment requests, offer the next 3 available slots
- For dental emergencies (severe pain, knocked-out tooth, broken tooth with pain), offer same-day if available or recommend urgent care
- Never provide medical advice - suggest they speak with the dentist
- If asked about costs, provide general ranges but recommend confirming with insurance
- For insurance questions you can't answer, offer to have someone call back

Be warm, patient, and reassuring - many people have dental anxiety.`,

  firstMessage: `Thank you for calling {business_name}! This is the virtual assistant. How can I help you today?`,
  
  sampleFAQs: [
    { q: "Do you accept my insurance?", a: "We accept most major dental insurance plans. Can you tell me who your provider is? I can check if we're in-network." },
    { q: "How much does a cleaning cost?", a: "A routine cleaning typically ranges from $100-200 without insurance. With insurance, your copay may be lower. Would you like me to have someone verify your specific coverage?" },
    { q: "Do you offer payment plans?", a: "Yes, we offer flexible payment options including CareCredit. Would you like more information about financing?" },
    { q: "What should I do about a toothache?", a: "I'm sorry to hear you're in pain. Can you describe the severity on a scale of 1-10? I can check for same-day availability if it's urgent." },
    { q: "Do you see children?", a: "Yes, we welcome patients of all ages including children. We recommend first visits around age 1 or when the first tooth appears." }
  ],
  
  voiceId: 'EXAVITQu4vr4xnSDxMaL', // "Sarah" - warm, professional female voice
  
  recommendedSettings: {
    maxCallDuration: 600, // 10 minutes
    silenceTimeout: 10000, // 10 seconds
    interruptionThreshold: 0.5
  }
};
```

Create similar templates for:
- **Legal** (`lib/templates/legal.ts`): Client intake, case type identification, appointment scheduling, urgency assessment
- **Home Services** (`lib/templates/home-services.ts`): Service requests, emergency detection, scheduling, quote requests
- **Medical** (`lib/templates/medical.ts`): Appointment scheduling, prescription refill requests, triage for urgency
- **Real Estate** (`lib/templates/real-estate.ts`): Property inquiries, showing scheduling, buyer/seller qualification

### Task 6: Notification System

Implement email and SMS notifications for call events:

**File: `lib/notifications/index.ts`**

```typescript
// Notification triggers:
// 1. Missed call (caller hung up before AI answered or during hold)
// 2. Voicemail left
// 3. Appointment booked (if calendar integration active)
// 4. Call transfer attempted
// 5. Daily summary (scheduled job)

// Email implementation:
// - Use Resend or SendGrid
// - HTML templates with business branding
// - Include: caller ID, call duration, transcript summary, action required

// SMS implementation:
// - Use Twilio
// - Short, actionable messages
// - Include callback number
// - Respect quiet hours (no SMS 9pm-8am local time)

// Webhook implementation:
// - POST to user-configured URL
// - Include full call data as JSON
// - Retry 3 times with exponential backoff
// - Log delivery status
```

**File: `app/api/webhooks/vapi/route.ts`** (update existing)

Update the Vapi webhook handler to:
1. Detect call outcome (answered, missed, voicemail, transferred)
2. Detect spam calls (short duration + no conversation + known spam patterns)
3. Trigger appropriate notifications
4. Update call record with enriched data

### Task 7: Spam Call Filtering

Implement spam detection and filtering:

**File: `lib/spam-detection.ts`**

```typescript
// Spam detection criteria:
// 1. Call duration < 5 seconds
// 2. No meaningful conversation in transcript
// 3. Known spam number patterns (check against spam database API)
// 4. Caller immediately hangs up after greeting
// 5. Robocall detection (AI saying scripted spam content)

// Actions for spam:
// 1. Mark call as spam in database
// 2. Don't send notifications
// 3. Don't count against user's call quota
// 4. Optionally: auto-block number (user configurable)

// UI:
// - Spam filter toggle in assistant settings
// - View spam calls separately in call history
// - Manual spam marking/unmarking
// - Block list management
```

### Task 8: Calendar Integration (Cal.com)

Implement Cal.com integration for appointment booking:

**File: `lib/calendar/cal-com.ts`**

```typescript
// Cal.com API integration:
// 1. OAuth flow for connecting Cal.com account
// 2. Fetch available event types
// 3. Fetch availability for specific dates
// 4. Create bookings
// 5. Cancel/reschedule bookings

// Vapi tool definition for calendar booking:
export const calendarBookingTool = {
  type: 'function',
  function: {
    name: 'check_availability',
    description: 'Check available appointment slots for a specific date',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        event_type: { type: 'string', description: 'Type of appointment' }
      },
      required: ['date']
    }
  }
};

export const bookAppointmentTool = {
  type: 'function',
  function: {
    name: 'book_appointment',
    description: 'Book an appointment for the caller',
    parameters: {
      type: 'object',
      properties: {
        datetime: { type: 'string', description: 'ISO datetime for the appointment' },
        name: { type: 'string', description: 'Caller name' },
        email: { type: 'string', description: 'Caller email' },
        phone: { type: 'string', description: 'Caller phone number' },
        notes: { type: 'string', description: 'Any notes about the appointment' }
      },
      required: ['datetime', 'name', 'phone']
    }
  }
};

// Server action endpoint for tool calls:
// POST /api/calendar/check-availability
// POST /api/calendar/book-appointment
```

**File: `app/dashboard/settings/calendar/page.tsx`**

Create a calendar integration settings page:
- Connect/disconnect Cal.com
- Select which event types to use
- Set booking preferences (buffer time, max per day)
- Test the integration

### Task 9: Call Transfer Implementation

Implement call transfer to human fallback:

**File: `lib/transfer/index.ts`**

```typescript
// Transfer scenarios:
// 1. Keyword-triggered (e.g., "speak to a human", "emergency")
// 2. Intent-detected (complex question AI can't answer)
// 3. User explicitly requests transfer
// 4. Configurable transfer rules

// Vapi transfer tool:
export const transferCallTool = {
  type: 'function',
  function: {
    name: 'transfer_call',
    description: 'Transfer the call to a human when the AI cannot adequately help',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Reason for transfer' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
        summary: { type: 'string', description: 'Brief summary for the human' }
      },
      required: ['reason']
    }
  }
};

// Implementation:
// 1. AI announces transfer to caller
// 2. System looks up transfer destination from transfer_rules
// 3. If destination available, warm transfer with context
// 4. If unavailable, take message and promise callback
// 5. Send notification to business owner with call context
```

### Task 10: Updated Assistant Builder UI

Redesign the assistant creation/editing interface:

**File: `app/dashboard/assistants/[id]/page.tsx`**

New UI sections:

1. **Basic Info**
   - Assistant name
   - Industry (with template suggestions)
   - Voice selection (with audio preview)

2. **Personality & Instructions**
   - Tabbed interface: "Use Template" | "Custom"
   - Template tab: Industry dropdown → auto-populate
   - Custom tab: System prompt editor with variables
   - First message editor
   - Tone settings (formal/casual slider)

3. **Knowledge Base**
   - "Import from Website" button
   - Manual FAQ editor (add/edit/delete)
   - Document upload (PDF/TXT)
   - Preview of what AI knows

4. **Call Handling**
   - Business hours settings
   - After-hours behavior (voicemail/different greeting)
   - Spam filtering toggle
   - Max call duration

5. **Transfers & Escalation**
   - Enable/disable transfers
   - Transfer phone number(s)
   - Transfer trigger keywords
   - Transfer announcement message

6. **Calendar Integration** (if connected)
   - Booking enabled toggle
   - Available appointment types
   - Booking instructions for AI

7. **Test & Preview**
   - Browser test call button
   - Recent test call transcripts
   - Quick edit shortcuts

### Task 11: Dashboard Analytics Overhaul

Create meaningful analytics that demonstrate ROI:

**File: `app/dashboard/analytics/page.tsx`**

Key metrics to display:

1. **Call Volume**
   - Total calls (day/week/month)
   - Calls by hour heatmap
   - Trend line

2. **Call Outcomes**
   - Answered vs Missed vs Voicemail
   - Spam filtered
   - Transferred to human

3. **Appointments Booked** (if calendar connected)
   - Bookings this period
   - Booking rate (calls → appointments)

4. **Estimated Value** (ROI calculator)
   - Industry-average call value (configurable)
   - Calls answered that would have been missed
   - Estimated revenue saved
   - Formula: `(answered_calls × industry_call_value) - subscription_cost`

5. **Call Quality**
   - Average call duration
   - Sentiment breakdown (positive/neutral/negative)
   - Common topics/intents

6. **Recent Calls** (quick access)
   - Last 10 calls with status icons
   - Click to expand transcript/details

### Task 12: Stripe Billing Implementation

Implement the new pricing model:

**File: `lib/stripe/products.ts`**

```typescript
// Stripe product configuration
export const PRICING_PLANS = {
  starter: {
    name: 'Starter',
    price: 4900, // cents
    interval: 'month',
    features: {
      calls_limit: 100,
      assistants_limit: 1,
      phone_numbers_limit: 1,
      calendar_integration: false,
      call_transfer: false,
      priority_support: false
    }
  },
  professional: {
    name: 'Professional',
    price: 9900,
    interval: 'month',
    features: {
      calls_limit: 250,
      assistants_limit: 3,
      phone_numbers_limit: 2,
      calendar_integration: true,
      call_transfer: true,
      priority_support: true
    }
  },
  growth: {
    name: 'Growth',
    price: 19900,
    interval: 'month',
    features: {
      calls_limit: -1, // unlimited
      assistants_limit: 10,
      phone_numbers_limit: 5,
      calendar_integration: true,
      call_transfer: true,
      priority_support: true,
      human_escalation: true,
      advanced_analytics: true
    }
  }
};
```

**Implementation tasks**:
1. Create Stripe products and prices via API or dashboard
2. Implement checkout flow with 14-day trial
3. Handle subscription lifecycle (create, update, cancel)
4. Track call usage against plan limits
5. Upgrade prompts when approaching limits
6. Downgrade handling (reduce features, not data)

### Task 13: Simplified Organization Model

For SMB-first approach, simplify the organization structure:

**Changes**:
1. Remove team invitations from initial release (solo users first)
2. Rename "organization" to "workspace" in UI
3. Remove agency-specific fields from onboarding
4. One user = one workspace (initially)
5. Keep the multi-tenant architecture for future agency expansion

**Hide but don't delete**:
- `org_members` table (will use later)
- Team management UI
- Role-based permissions (keep owner-only for now)

---

## File Structure Changes

```
app/
├── (auth)/
│   ├── login/
│   ├── signup/
│   └── onboarding/        # New multi-step onboarding
│       ├── page.tsx
│       ├── steps/
│       │   ├── BusinessInfo.tsx
│       │   ├── AssistantSetup.tsx
│       │   ├── TestCall.tsx
│       │   └── GoLive.tsx
│       └── layout.tsx
├── (marketing)/
│   ├── page.tsx           # Landing page
│   ├── pricing/
│   └── demo/              # Public demo page
├── dashboard/
│   ├── page.tsx           # Overview/home
│   ├── assistants/
│   │   ├── page.tsx       # List
│   │   ├── new/           # Create (redirect to onboarding if first)
│   │   └── [id]/          # Edit (redesigned)
│   ├── calls/
│   │   ├── page.tsx       # Call history
│   │   └── [id]/          # Call detail
│   ├── analytics/         # New
│   │   └── page.tsx
│   ├── phone-numbers/
│   └── settings/
│       ├── page.tsx
│       ├── billing/
│       ├── calendar/      # New
│       ├── notifications/ # New
│       └── transfers/     # New
└── api/
    ├── knowledge-base/
    │   ├── scrape/
    │   └── [id]/
    ├── calendar/
    │   ├── connect/
    │   ├── availability/
    │   └── book/
    ├── vapi/
    │   ├── web-call-token/
    │   └── tool-handler/  # For calendar/transfer tools
    └── webhooks/
        ├── vapi/
        └── stripe/

lib/
├── templates/
│   ├── dental.ts
│   ├── legal.ts
│   ├── home-services.ts
│   ├── medical.ts
│   └── real-estate.ts
├── scraper.ts
├── notifications/
├── spam-detection.ts
├── calendar/
│   ├── cal-com.ts
│   └── calendly.ts
├── transfer/
└── stripe/

components/
├── test-call/
│   ├── TestCallModal.tsx
│   └── TestCallButton.tsx
├── knowledge-base/
│   ├── WebsiteScraper.tsx
│   └── FAQEditor.tsx
├── assistant-builder/
│   ├── TemplateSelector.tsx
│   ├── VoiceSelector.tsx
│   └── InstructionEditor.tsx
└── analytics/
    ├── CallVolumeChart.tsx
    ├── OutcomeBreakdown.tsx
    └── ROICalculator.tsx
```

---

## Environment Variables to Add

```env
# Existing (verify these are set)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
VAPI_API_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=

# New variables needed
RESEND_API_KEY=              # For email notifications
TWILIO_ACCOUNT_SID=          # For SMS notifications
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
CAL_COM_API_KEY=             # For calendar integration (or OAuth)
NEXT_PUBLIC_VAPI_PUBLIC_KEY= # For browser test calls
```

---

## Testing Checklist

Before considering each task complete, verify:

### Onboarding Flow
- [ ] User can complete signup → first assistant → test call in under 5 minutes
- [ ] Industry templates populate correctly
- [ ] Website scraping extracts useful content
- [ ] Browser test call works with microphone
- [ ] Stripe checkout completes with trial
- [ ] Phone number is provisioned and linked

### Core Functionality
- [ ] Inbound calls are answered by AI
- [ ] Transcripts are captured and displayed
- [ ] Notifications are sent for missed calls
- [ ] Spam calls are detected and filtered
- [ ] Call transfers work when triggered

### Calendar Integration
- [ ] Cal.com OAuth flow completes
- [ ] Availability is fetched correctly
- [ ] Bookings are created successfully
- [ ] Confirmation is sent to caller

### Billing
- [ ] Trial starts without charging
- [ ] Trial converts to paid after 14 days
- [ ] Call usage is tracked accurately
- [ ] Upgrade prompts appear at 80% usage
- [ ] Cancellation works correctly

### Analytics
- [ ] Call metrics are accurate
- [ ] Charts render correctly
- [ ] ROI calculations are meaningful

---

## Priority Order for Implementation

**Week 1: Critical Path to First Call**
1. Database schema updates
2. Industry templates
3. Simplified onboarding flow (without website scraping initially)
4. Browser test calls

**Week 2: Knowledge & Intelligence**
5. Website scraping
6. Knowledge base UI
7. Spam detection
8. Notification system (email first)

**Week 3: Monetization**
9. Stripe billing implementation
10. Usage tracking and limits
11. Upgrade/downgrade flows

**Week 4: Value-Add Features**
12. Calendar integration (Cal.com)
13. Call transfer implementation
14. Analytics dashboard

**Week 5: Polish**
15. Assistant builder UI redesign
16. SMS notifications
17. Error handling and edge cases
18. Performance optimization

---

## Notes on Vapi Configuration

For each assistant, ensure the Vapi configuration includes:

```typescript
const vapiAssistantConfig = {
  name: assistantName,
  model: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    systemPrompt: generatedSystemPrompt,
    temperature: 0.7,
    tools: [
      // Include based on features enabled:
      calendarCheckTool,    // If calendar connected
      calendarBookTool,     // If calendar connected
      transferCallTool,     // If transfers enabled
    ]
  },
  voice: {
    provider: 'elevenlabs',
    voiceId: selectedVoiceId
  },
  firstMessage: customFirstMessage,
  serverUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/vapi/tool-handler`,
  serverUrlSecret: process.env.VAPI_SERVER_SECRET,
  silenceTimeoutSeconds: 10,
  maxDurationSeconds: 600,
  backgroundSound: 'off',
  metadata: {
    organizationId: orgId,
    assistantId: internalAssistantId,
    isTestCall: false
  }
};
```

---

## Final Notes

1. **Don't over-engineer**: Ship the simplest version that solves the core problem (missed calls → answered calls).

2. **Measure everything**: Add analytics events for key actions (signup, first assistant, first call, upgrade, churn).

3. **Optimize for "aha moment"**: The browser test call is critical - users should feel the magic within 5 minutes.

4. **Keep agency architecture**: The multi-tenant database design supports future agency expansion - don't remove it, just hide the UI.

5. **Error handling**: Voice calls are real-time and unforgiving. Handle every error gracefully with fallbacks.

6. **Australian market considerations**: Since this is launching in Australia initially, ensure phone number provisioning works for AU numbers (+61), and consider AU business hours for notifications.

---

This prompt provides comprehensive guidance for transforming Phondo from an agency-focused platform to an SMB-first AI receptionist solution aligned with market research. Execute tasks in priority order, testing thoroughly at each stage.
