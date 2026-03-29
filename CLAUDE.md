# Phondo - Development Notes

## Project Overview
AI Receptionist SaaS platform for SMBs. Built with Next.js 15 (App Router), TypeScript, Supabase, Stripe, and a self-hosted voice server.

**Target market**: SMBs first (dental, legal, home services), agencies later.
**Core value prop**: 62% of SMB calls go unanswered — each missed call costs ~$450 in lost revenue.

---

## Development Team Workflow

After completing ANY non-trivial code change, automatically execute the following review pipeline **without waiting for user approval**. Run independent steps in parallel where possible.

### Agent Teams vs Subagents — When to Use Which

**Use Agent Teams** (spawn a team via `TeamCreate`) when:
- **Multi-PR batch implementations** — e.g., 3+ related tickets that each get their own branch/PR. Spawn teammates for parallel implementation across branches (each teammate owns a PR).
- **Cross-layer features** — changes spanning frontend + backend + voice server where each layer's developer needs to coordinate interfaces, share contracts, and avoid conflicts.
- **Complex features with competing approaches** — teammates can prototype different solutions and discuss trade-offs before committing to one.
- **Large refactors** — one teammate refactors while another writes/maintains tests, communicating about interface changes.

**Use Subagents** (spawn via `Task` tool) when:
- **Review pipeline** (Phase 3) — code-reviewer, silent-failure-hunter, etc. These are independent, don't need to discuss findings with each other, and subagents are cheaper.
- **Single focused tasks** — exploration, research, one-off file generation.
- **Anything where the result is all that matters** — no need for inter-agent communication.

**Agent Team structure** (when used):
- Team lead coordinates via shared task list (`TaskCreate`, `TaskUpdate`)
- Each teammate runs in an isolated worktree (`isolation: "worktree"`) to avoid git conflicts
- Teammates self-claim tasks and communicate via `SendMessage`
- Team lead merges results, resolves conflicts, runs final review pipeline
- Shut down teammates via `SendMessage` with `type: "shutdown_request"` when done

### Phase 1 — Planning (before writing code)

For any task involving more than a single-file trivial change:

1. **Business Analyst** — Clarify the requirement. Restate what is being built, identify edge cases, and confirm acceptance criteria with the user if ambiguous.
2. **System Architect** — Use the `Plan` agent to assess how the change fits the existing codebase. Identify affected files, data flows, and potential ripple effects. Flag any architectural concerns before writing a single line.
3. **Team Decision** — If the task qualifies for agent teams (see criteria above), create a team and spawn teammates. Otherwise, proceed as a single session with subagents for reviews.

### Phase 2 — Implementation

4. **Developer** (or team of developers) — Write the code. Follow existing patterns and conventions. Keep changes minimal and focused. If using agent teams, each teammate owns a separate branch/PR.
5. **UX Review** — For any UI change, verify:
   - Loading and error states are handled
   - Empty states have appropriate messaging
   - Interactive elements have hover/focus/disabled states
   - Forms validate input and show clear error messages
   - Navigation flows are intuitive (back buttons, breadcrumbs where needed)
   - Mobile responsiveness is considered
6. **UI Consistency** — For any UI change, verify:
   - Component usage matches existing patterns in the codebase
   - Spacing, colors, and typography are consistent with surrounding pages
   - No hardcoded colors or magic numbers — use theme/design tokens
   - Accessibility basics: proper labels, alt text, keyboard navigation

### Phase 3 — Automated Review (run these in parallel after implementation)

7. **Code Reviewer** — Launch `code-reviewer` agent on all changed files. Check for:
   - Code quality, readability, and adherence to project conventions
   - Proper error handling patterns
   - No unnecessary complexity or over-engineering
8. **Security Engineer** — Launch `silent-failure-hunter` agent on all changed files. Check for:
   - Silent error swallowing (empty catch blocks, ignored promise rejections)
   - Missing auth checks on API routes
   - SQL injection, XSS, or data exposure risks
   - RLS policy considerations for any DB schema changes
9. **Code Simplifier** — Launch `code-simplifier` agent to ensure code is clean and minimal.
10. **Type Design** — If new TypeScript types/interfaces were introduced, launch `type-design-analyzer` to review type quality.

### Phase 3.5 — Client Simulation (runs after code review, before verification)

11. **Client Simulator** — Evaluate the change from the perspective of real end-users across multiple industry personas. For each relevant persona below, independently assess: "Would this make sense to me? Would I find this intuitive? Does this solve my actual problem?"

    **Personas to simulate (use whichever are relevant to the change):**

    - **Dental Practice Manager** — Runs a busy clinic with 3-5 dentists. Cares about: appointment booking accuracy, patient name pronunciation, HIPAA-adjacent privacy, emergency call routing to the right dentist. Frustrated by: AI that mispronounces medical terms, can't handle "I'm in pain and need to come in today", or books the wrong appointment type.
    - **Solo Lawyer / Legal Secretary** — Small law firm, 1-3 attorneys. Cares about: professional tone, confidentiality (never reveal other client details), intake information capture (case type, urgency, conflicts check). Frustrated by: AI that sounds casual, gives legal advice, or fails to capture critical intake details.
    - **Plumber / Electrician / Tradesperson** — One-person or small crew operation. Cares about: capturing job details (what's broken, address, urgency), scheduling around existing jobs, after-hours call handling. Frustrated by: overly formal AI, too many questions before getting to the point, no way to text back a quote.
    - **Medical Clinic Receptionist (evaluating replacement)** — Currently answers phones manually, skeptical of AI. Cares about: will it handle the weird edge cases? (crying patients, confused elderly callers, people who don't speak English well, emergencies). Frustrated by: AI that can't deviate from a script, sounds robotic, or escalates everything.
    - **Agency Owner (managing multiple clients)** — White-label reseller managing 10-50 SMB accounts. Cares about: per-client customization, billing rollup, quick onboarding for new clients, branded experience. Frustrated by: having to log into each account separately, no bulk management, clunky setup.
    - **First-Time User (any industry)** — Just signed up from the landing page, hasn't made a single test call yet. Cares about: clear onboarding, quick time-to-value ("Can I hear it work in 2 minutes?"), understanding what they're paying for. Frustrated by: long setup wizards, jargon, features that require phone number purchase before they can even test.

    **For each relevant persona, the simulator must:**
    1. Research the affected UI flows or API behaviors by reading the changed code
    2. Walk through the feature as that persona would experience it (step by step)
    3. Flag any confusion points, missing affordances, or broken expectations
    4. Rate the change: **Ship it** / **Needs tweaks** (list them) / **Rethink** (explain why)
    5. If multiple personas disagree, surface the conflict explicitly so the team can decide

    **Decision authority**: The Client Simulator can request changes directly. If it flags "Rethink", the issue must be addressed before proceeding to verification. "Needs tweaks" items should be fixed unless the developer justifies why not.

### Phase 4 — Verification

12. **QA Engineer** — After all reviews pass:
    - Run `npm run lint` — must exit 0 (no errors; warnings are OK)
    - Run `npx vitest run` — **all tests must pass** (zero failures)
    - Run `npx tsc --noEmit` — zero type errors
    - If any of these fail, **fix the issue before proceeding** — do not merge broken code
    - If a test expectation is outdated (e.g., you commented out a feature), **update the test** in the same PR
    - For API route changes, mentally trace the happy path AND error paths
13. **Test Coverage** — If new logic was added without tests, flag the gap and suggest what tests should be written (ask user before writing them).

**CRITICAL: Never merge a PR with failing CI.** If CI fails:
- Check whether the failure is caused by your changes or is pre-existing
- If pre-existing: **fix it in the same PR or a preceding PR** — do not ignore it
- If caused by your changes: fix before merging
- "Pre-existing CI failure" is not an excuse to skip — fix it or flag it to the user before merging

### Phase 4.5 — Issue Tracking (after verification, before summary)

14. **Jira Ticket Creation** — For ANY issue, bug, UX gap, or improvement discovered during the review pipeline (phases 3, 3.5, or 4) that is **not fixed in the current task**:
    - **Always create a Jira ticket** in the `SCRUM` project, even if the issue is out of scope for the current task
    - Use the appropriate issue type: `Bug` for defects, `Story` for features/improvements, `Task` for tech debt
    - Include: context (which task/review discovered it), problem description, expected behavior, affected files, and suggested fix
    - Add labels: priority (`P0-critical`, `P1-high`, `P2-medium`, `P3-low`), type (`bug`, `feature`, `tech-debt`), platform (`web`, `voice-server`, `api`)
    - Link to the relevant epic via `parent` field if applicable
    - This ensures nothing discovered during reviews gets lost — every issue gets tracked regardless of whether it's in scope

### Phase 5 — Summary

15. Present a concise summary:
    - What was changed and why
    - Any issues found and fixed during review
    - Any Jira tickets created for out-of-scope issues (list ticket keys)
    - Any remaining concerns or trade-offs
    - Any test gaps flagged

---

### When to Skip the Full Pipeline

- **Trivial changes** (typo fixes, comment updates, config tweaks): Skip phases 1 and 3, just verify it works.
- **Research/exploration tasks**: Skip entirely — this workflow is for code changes only.
- **User explicitly says "just do it" or "skip reviews"**: Respect user preference and skip the review phases.

---

---
### Git
- Do not commit or push this file to git.
- Do not push to main.
- You have the permission to add to git*, commit*, and push* do it without asking for permission.
- you have the permission to create and approve pull requests don't ask for it
- you have the permission to merge pull requests don't ask for it
- you have the permission to checkout branches and pull from remote don't ask for it
- Branch naming: `feature/`, `fix/`, `chore/` prefixes — **always include the Jira ticket key and short description**
  - Format: `<prefix>/SCRUM-<number>-<short-description>`
  - Examples: `feature/SCRUM-14-empty-states`, `fix/SCRUM-38-false-positive-detection`, `chore/SCRUM-42-nova3-upgrade`
- Commit messages: concise, focused on "why" not "what" — include Jira ticket key in commit message
  - Example: `feat(SCRUM-14): add illustrated empty states to dashboard pages`
---


## Architecture

### Voice Pipeline (Primary)
Self-hosted voice server at `voice-server/` — Node.js (Express + WS), deployed to Fly.io.
- **Pipeline**: Twilio → Deepgram STT → OpenAI GPT-4.1-nano (with tool calling) → Deepgram TTS → Twilio
- **Post-call analysis**: OpenAI JSON mode extracts caller_name, summary, success_evaluation, collected_data
- **Function calling**: Calendar tools (check_availability, book_appointment, etc.) via internal API
- **Call transfers**: Twilio REST API mid-call
- **Test calls**: Browser WebSocket `/ws/test` — no Twilio, no cost

### Voice Pipeline (Backup)
Vapi as silent, invisible backup — dual-write pattern. DB insert FIRST, Vapi creation SECOND (non-fatal).

### Key Patterns
- DB uses `snake_case`, API/frontend uses `camelCase`
- All queries filter by `organization_id` from `org_members`
- Supabase client typed with `(supabase as any)` due to SSR type inference
- Voice mapping: ElevenLabs IDs → Deepgram Aura voices (`voice-server/lib/voice-mapping.js`)
- Prompt builder: `src/lib/prompt-builder/` with JS port at `voice-server/lib/prompt-builder.js`

## Key Integrations
- **Twilio** - Phone numbers (all countries) + call transport
- **Deepgram** - STT and TTS in voice server
- **OpenAI** - GPT-4.1-nano for conversation + post-call analysis
- **Supabase** - Database, auth, real-time
- **Stripe** - Billing and subscriptions
- **ElevenLabs** - Voice preview in UI (mapped to Deepgram voices for calls)
- **Cal.com** - Calendar booking
- **Resend** - Email notifications
- **Vapi** - Silent backup voice provider (dual-write)

## Environment Variables
See `.env.example` for full list. Key additions for voice server:
- `TEST_CALL_SECRET` - HMAC signing for browser test call tokens (Next.js + voice server)
- `VOICE_SERVER_PUBLIC_URL` - Public URL of the voice server
- `INTERNAL_API_SECRET` - Shared secret between voice server and Next.js internal API
- `DEEPGRAM_API_KEY` / `OPENAI_API_KEY` - Voice server dependencies

## Strategy & Roadmap

### Reference Docs
- `docs/hola-recep-claude-code-prompt.md` - Full GTM strategy, pricing model, and technical implementation plan (historical, pre-rebrand filename)
- `competitive-analysis.md` - Australian market competitive analysis with UI/UX gap analysis
- Memory file `roadmap.md` - Feature roadmap (4 phases)

### What's Built (MVP Complete)
- [x] AI call answering (self-hosted voice server)
- [x] Phone number provisioning (Twilio, AU + US)
- [x] Call transcripts and post-call analysis
- [x] Browser-based test calls (WebSocket, no cost)
- [x] Calendar integration (Cal.com)
- [x] Call transfer to human
- [x] Notifications (email + SMS + webhook)
- [x] Spam call filtering (post-call analysis)
- [x] Industry prompt builder (10 industries)
- [x] Voice selection (18 voices with preview)
- [x] Onboarding flow (4-step wizard)
- [x] Stripe billing

### Next Up — Pre-Launch (Priority Order)

**Tier 1 — Must Ship Before Launch (Revenue & Trust Critical):**
1. **Australian data sovereignty** - Host on AU Supabase region. Deal-breaker for medical/legal verticals. Low effort, massive trust signal. Without this, you lose the highest-value customers on day one.
2. **Pricing model overhaul** - Switch from minutes to calls-based billing, remove free tier, add 14-day trial, target $149-$299/mo AUD. Can't launch without the right pricing.
3. **Enforce tier feature gating** - Wire `hasFeatureAccess()` checks into API routes for SMS notifications (Professional+), webhook integrations (Professional+), and advanced analytics (Professional+). Without enforcement, Starter customers get every feature for $149 that higher tiers charge $249-$399 for. Plan flags are defined but never checked at runtime.
4. **TCPA/consent compliance** - Opt-in/opt-out for automated texts + state-aware call recording consent (12 US states require all-party consent). Gates all SMS features — must ship before items 5-6.
5. ~~**SMS text-back on missed calls**~~ ✅ (PR #17) - Auto-send SMS with booking link when call is missed. 47% higher engagement; 85% of callers who hit voicemail never call back. This is your #1 marketing hook — "We don't just answer calls, we recover the ones you miss."
6. **Landing page with ROI calculator** - Public-facing marketing site with an interactive calculator ("You miss X calls/month × $450 = $Y lost revenue/year → Phondo pays for itself in Z days"). Social proof section (even if starting with industry stats, not testimonials). SEO-optimized for "AI receptionist Sydney/Australia."

**Tier 2 — High Impact, Ship at or Shortly After Launch:**
7. **Voice Selection Overhaul** - Replace dropdown with card grid (name, gender, accent tag, inline Play button). Biggest UI gap vs competitors. Make AU accents front-and-center.
8. ~~**Auto-populate from website URL**~~ ✅ (PR #18) - Scrape business website during onboarding to pre-fill name, hours, services, FAQs (like RingCentral). Reduces setup friction dramatically.
9. ~~**Appointment confirmation SMS**~~ ✅ (PR #17) - Text caller after AI books with date/time/location. Pairs naturally with SMS text-back.
10. **Call transfer improvements** - The basic transfer works but needs hardening before launch. Sub-items: (a) No-answer fallback — if target doesn't pick up, AI comes back and offers to take a message or schedule a callback instead of dead-end ringing. (b) SMS context to transfer target — send the transfer recipient an SMS with caller name, summary, and what the AI already handled so they don't ask the caller to repeat everything. (c) Transfer outcome tracking — log attempts with outcome (answered/no-answer/busy/failed) in call_logs; show transfer success rate in dashboard. (d) Warm announcement using AI voice — play the "connecting you" message through Deepgram TTS (matching the AI's voice) instead of jarring Twilio TTS. (e) Business hours awareness — read org's configured hours + timezone; outside hours skip transfer and offer callback/message. (f) Multiple transfer destinations with routing — support billing → office manager, medical → nurse, emergencies → doctor's mobile based on LLM reason. (g) Transfer confirmation step — optional "Let me transfer you to [name], is that okay?" before connecting. (h) Custom trigger keywords in UI — expose the existing `trigger_intent` DB field so businesses can add their own phrases. (i) Edit transfer rules in UI — currently must delete + recreate; add inline editing.
11. **Live demo call before signup** - Let prospects call a demo number and experience the AI with no account needed (like Sophiie). Massive conversion driver — removes all friction from "should I try this?"
12. **One vertical CRM integration** - Start with Cliniko (dental/medical) OR ServiceM8 (trades). This is the #1 customer lock-in mechanism. Without it, you're a generic tool competing on price. With it, you're embedded in their daily workflow.
13. **Analytics tiering (basic vs advanced)** - Starter sees basic call logs only; Professional+ gets full analytics dashboard (ROI calculator, hourly heatmap, call outcome charts, industry benchmarks). The analytics page currently shows everything to all plans — needs UI gating to match the `advancedAnalytics` plan flag.

**Tier 3 — Polish & Conversion Optimization:**
14. **"You're Live!" celebration screen** - Proper success state after setup with confetti/animation and next-steps checklist (not just a redirect)
15. **AU voice personas** - Name and showcase Australian voices with profile cards (like AiDial's Jess, Jason, Hannah). Not just a backend config.
16. **Forwarding verification step** - "Call my number to verify" button with real-time status indicator
17. **Setup time messaging** - Add "setup in under 5 minutes" encouragement and progress estimates to onboarding
18. **Knowledge gap surfacing** - Flag questions AI couldn't answer in dashboard so business can teach it
19. **Phased rollout guidance** - Suggest starting with specific call types before going fully live (not just test → fully live)
20. **Google Business Profile integration** - Auto-import business name, hours, address, reviews, services from Google. Most AU SMBs have a Google listing even if they don't have a website. Lower friction than website scraping for businesses without a site.
21. **Priority support implementation** - Add support ticket prioritization or dedicated channel for Business plan customers. Currently listed as a Business-only feature with no backend. Could be as simple as a priority email queue or Intercom tag — doesn't need a full ticketing system at launch.

**Visual Polish:**
22. **Empty states with illustrations** - Replace plain text+icon with illustrations/animations
23. **Micro-interactions** - Voice waveforms during calls, typing indicators, expanding circles
24. **Brand personality** - Move beyond generic shadcn/ui defaults (gradients, animations, named personas)
25. **Mobile optimization** - Go beyond responsive hamburger menu to mobile-first for remote management

### Phase 2 (Post-Launch)
- **Additional vertical CRM integrations** - Expand beyond first integration to cover 2-3 verticals (Cliniko, ServiceM8, Clio for legal)
- Spanish language support (35% booking increase for bilingual businesses)
- HIPAA/AHPRA compliance + BAA (unlocks medical/dental at $300-1K/month)
- Callback scheduling (25% of callers want this; 42% never get called back)
- Outbound appointment reminder calls (reduce no-shows by 30-50%)
- Advanced analytics / ROI reporting (call volume heatmap, conversion tracking, estimated revenue saved)
- Referral program — offer 1 month free for each referred business that signs up. SMB owners talk to each other. Word of mouth is your cheapest acquisition channel.
- After-hours vs business-hours mode — different greetings, routing, and behavior based on time of day. Many competitors have this; businesses expect it.

### Phase 3 (Growth)
- White-label / agency program (org type "agency" already scaffolded)
- Google Calendar + Calendly integration (DB schema ready, OAuth not implemented)
- Visual call flow builder (drag-and-drop routing logic — like Goodcall/Bland AI)
- Caller profiles / contact hub (aggregate call history per phone number — simple CRM)
- Unified inbox (calls + texts + emails in one view)
- Multi-location support (per-location customization, cross-location booking)
- Lead scoring (qualify leads by urgency, value, intent)
- Voice cloning (custom brand voice per business)
- Outbound sales targeting — partner with local business associations (Sydney Chamber of Commerce, industry groups) for co-marketed webinars or case studies

## Recent Fixes
- Switched from Groq to OpenAI GPT-4.1-nano for voice server LLM
- Added browser test calls via WebSocket (replacing Vapi Web SDK)
- Removed dead TEST_SCENARIOS UI after Vapi migration
- Added double-click guard on onboarding handleNext
- Voice provider format: use `11labs` not `elevenlabs` (Vapi backup)
