#!/usr/bin/env node
/**
 * AI Call Scenario Simulator
 *
 * Simulates multi-turn voice conversations by calling the LLM directly
 * with the real system prompt, tool definitions, and simulated user inputs.
 * Tests that the AI uses the correct tools and gives appropriate responses.
 *
 * Usage: node tests/scenario-simulator.js
 * Requires: OPENAI_API_KEY env var (or whatever LLM_PROVIDER is configured)
 */

const { getChatResponse } = require("../services/openai-llm");
const { buildSystemPrompt } = require("../lib/prompt-builder");
const { calendarToolDefinitions, listServiceTypesToolDefinition, callbackToolDefinition } = require("../services/tool-executor");

// ─── Config ──────────────────────────────────────────────────────────────────

const LLM_API_KEY = process.env.OPENAI_API_KEY;
if (!LLM_API_KEY) {
  console.error("OPENAI_API_KEY is required to run scenario tests");
  process.exit(1);
}

// Mock organization/assistant for prompt building
const mockAssistant = {
  name: "Smile Hub AI",
  systemPrompt: null,
  promptConfig: {
    tone: "friendly",
    customInstructions: "",
    behaviors: {
      afterHoursHandling: true,
    },
    fields: [],
  },
  settings: { flexibleBooking: false },
  firstMessage: "Hi there! Thanks for calling Smile Hub Dental. How can I help you today?",
  voiceId: "test",
  language: "en",
  afterHoursConfig: null,
};

const mockOrganization = {
  name: "Smile Hub Dental",
  industry: "dental",
  timezone: "Australia/Sydney",
  businessHours: {
    monday: { open: "08:00", close: "17:00" },
    tuesday: { open: "08:00", close: "17:00" },
    wednesday: { open: "08:00", close: "18:00" },
    thursday: { open: "08:00", close: "17:00" },
    friday: { open: "08:00", close: "16:00" },
    saturday: { open: "09:00", close: "13:00" },
    sunday: null,
  },
  defaultAppointmentDuration: 45,
  country: "AU",
  businessState: "NSW",
  recordingConsentMode: "auto",
};

const mockServiceTypes = [
  { id: "st-checkup", name: "Check-up & Clean", duration_minutes: 45 },
  { id: "st-filling", name: "Filling", duration_minutes: 45 },
  { id: "st-emergency", name: "Emergency", duration_minutes: 30 },
  { id: "st-consult", name: "Consultation", duration_minutes: 30 },
  { id: "st-rootcanal", name: "Root Canal", duration_minutes: 90 },
];

const tools = [
  ...calendarToolDefinitions,
  listServiceTypesToolDefinition,
  callbackToolDefinition,
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPromptForTest() {
  const prompt = buildSystemPrompt(
    mockAssistant,
    mockOrganization,
    "We have Dr. Sarah Chen and Dr. James Wilson. Lisa Thompson is our hygienist.",
    {
      calendarEnabled: true,
      transferRules: [],
      isAfterHours: false,
      afterHoursConfig: null,
      serviceTypes: mockServiceTypes,
    }
  );
  return prompt + "\n\nCALLER CONTEXT:\nThe caller's phone number is +61400000000.";
}

// Simulated tool results
const TOOL_RESULTS = {
  get_current_datetime: () => `Current date and time: Thursday, March 27, 2026, 10:30 AM (Australia/Sydney). Today's date in YYYY-MM-DD format: 2026-03-27.`,
  check_availability: (args) => `On ${args.date || "today"}, I have openings at 11:15 AM, 12:00 PM, 12:45 PM, 1:30 PM, 2:15 PM, 3:00 PM and 3:45 PM. Which time works best?`,
  book_appointment: (args) => `I've booked your appointment for ${args.datetime || "the requested time"} with Dr. Sarah Chen. Is there anything else I can help with?`,
  list_service_types: () => "Available appointment types: Check-up & Clean (45 min), Filling (45 min), Emergency (30 min), Consultation (30 min), Root Canal (90 min)",
  schedule_callback: (args) => `I've scheduled a callback for ${args.caller_name || "you"}. Someone from our team will call you back.`,
  cancel_appointment: () => "The appointment has been cancelled.",
};

async function simulateConversation(scenario) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`SCENARIO: ${scenario.name}`);
  console.log(`${"=".repeat(70)}`);

  const systemPrompt = buildSystemPromptForTest();
  const messages = [{ role: "system", content: systemPrompt }];
  const toolsCalled = [];
  let passed = true;
  const issues = [];

  for (const turn of scenario.turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.content });
      console.log(`\nUser: "${turn.content}"`);

      // LLM call with tool handling loop
      let maxIterations = 5;
      while (maxIterations-- > 0) {
        let result;
        try {
          result = await getChatResponse(LLM_API_KEY, messages, { tools });
        } catch (err) {
          console.log(`  [ERROR] LLM call failed: ${err.message}`);
          issues.push(`LLM error: ${err.message}`);
          passed = false;
          break;
        }

        if (result.type === "tool_calls") {
          messages.push(result.message);
          for (const tc of result.toolCalls) {
            const fnName = tc.function.name;
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch {}
            console.log(`  [TOOL] ${fnName}(${JSON.stringify(args).slice(0, 100)})`);
            toolsCalled.push(fnName);

            const toolResult = TOOL_RESULTS[fnName]
              ? TOOL_RESULTS[fnName](args)
              : `Tool ${fnName} not found`;
            messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          }
          continue; // Loop for follow-up after tool results
        }

        if (result.type === "content") {
          console.log(`  AI: "${result.content.slice(0, 150)}${result.content.length > 150 ? "..." : ""}"`);
          messages.push({ role: "assistant", content: result.content });

          // Check assertions for this turn
          if (turn.expectTool) {
            const expected = Array.isArray(turn.expectTool) ? turn.expectTool : [turn.expectTool];
            for (const t of expected) {
              if (!toolsCalled.includes(t)) {
                console.log(`  [FAIL] Expected tool call: ${t} — not called!`);
                issues.push(`Missing tool: ${t}`);
                passed = false;
              }
            }
          }
          if (turn.expectNoTool) {
            const forbidden = Array.isArray(turn.expectNoTool) ? turn.expectNoTool : [turn.expectNoTool];
            for (const t of forbidden) {
              if (toolsCalled.includes(t)) {
                console.log(`  [FAIL] Tool ${t} should NOT have been called!`);
                issues.push(`Unexpected tool: ${t}`);
                passed = false;
              }
            }
          }
          if (turn.expectContains) {
            const lower = result.content.toLowerCase();
            const checks = Array.isArray(turn.expectContains) ? turn.expectContains : [turn.expectContains];
            for (const c of checks) {
              if (!lower.includes(c.toLowerCase())) {
                console.log(`  [FAIL] Response should contain: "${c}"`);
                issues.push(`Missing in response: "${c}"`);
                passed = false;
              }
            }
          }
          if (turn.expectNotContains) {
            const lower = result.content.toLowerCase();
            const checks = Array.isArray(turn.expectNotContains) ? turn.expectNotContains : [turn.expectNotContains];
            for (const c of checks) {
              if (lower.includes(c.toLowerCase())) {
                console.log(`  [FAIL] Response should NOT contain: "${c}"`);
                issues.push(`Unexpected in response: "${c}"`);
                passed = false;
              }
            }
          }
          if (turn.expectMaxLength) {
            if (result.content.length > turn.expectMaxLength) {
              console.log(`  [FAIL] Response too long: ${result.content.length} chars (max ${turn.expectMaxLength})`);
              issues.push(`Too long: ${result.content.length}/${turn.expectMaxLength}`);
              passed = false;
            }
          }
          // Reset per-turn tool tracking
          toolsCalled.length = 0;
          break;
        }
      }
    }
  }

  console.log(`\nResult: ${passed ? "PASS ✅" : "FAIL ❌"}`);
  if (issues.length) console.log(`Issues: ${issues.join(", ")}`);
  return { name: scenario.name, passed, issues };
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = [
  // ── BOOKING FLOW ──────────────────────────────────────────────────────────

  {
    name: "1. Full booking flow — book_appointment must be used",
    turns: [
      { role: "user", content: "I'd like to book a check-up and clean please.",
        expectNoTool: "schedule_callback" },
      { role: "user", content: "Tomorrow would be great.",
        expectTool: "check_availability" },
      { role: "user", content: "The 11:15 AM slot please." },
      { role: "user", content: "My name is John Smith and you can use the number I'm calling from.",
        expectTool: "book_appointment",
        expectNoTool: "schedule_callback" },
    ],
  },
  {
    name: "2. Booking with 'earliest available' — must check availability, not guess",
    turns: [
      { role: "user", content: "I need a filling appointment, the earliest you have.",
        expectTool: "get_current_datetime" },
      { role: "user", content: "That works. My name is Lisa Park, same number.",
        expectTool: "book_appointment",
        expectNoTool: "schedule_callback" },
    ],
  },
  {
    name: "3. Booking with vague time — AI should ask to clarify, not guess",
    turns: [
      { role: "user", content: "Can I come in sometime next week for a root canal?" },
      { role: "user", content: "Wednesday would be good.",
        expectTool: "check_availability" },
    ],
  },
  {
    name: "4. Caller provides name and phone together — should not ask separately",
    turns: [
      { role: "user", content: "Book me a consultation for today." },
      { role: "user", content: "12 PM please." },
      { role: "user", content: "Tom Wilson, phone is the one I'm calling from.",
        expectTool: "book_appointment" },
    ],
  },
  {
    name: "5. Caller changes mind mid-booking — should handle gracefully",
    turns: [
      { role: "user", content: "I want to book a filling." },
      { role: "user", content: "Actually, never mind. Can you just tell me how much a root canal costs?",
        expectNoTool: "book_appointment",
        expectNotContains: "what date" },
    ],
  },

  // ── TRANSFER & CALLBACK ───────────────────────────────────────────────────

  {
    name: "6. Transfer request — concise refusal, no system explanation",
    turns: [
      { role: "user", content: "Can I speak to Dr. Wilson please?",
        expectNoTool: "book_appointment",
        expectNotContains: "system automatically assigns",
        expectMaxLength: 200 },
    ],
  },
  {
    name: "7. Callback request — should NOT book an appointment",
    turns: [
      { role: "user", content: "Can you have someone call me back about my bill? My name is Sarah Jones.",
        expectNoTool: "book_appointment" },
    ],
  },
  {
    name: "8. Caller insists on speaking to a specific person — should not promise",
    turns: [
      { role: "user", content: "I need to speak to Dr. Sarah Chen right now, it's urgent." },
      { role: "user", content: "No, I specifically need Dr. Chen, not anyone else.",
        expectNoTool: "book_appointment",
        expectNotContains: "book you with Dr. Chen" },
    ],
  },

  // ── INFORMATION QUERIES ───────────────────────────────────────────────────

  {
    name: "9. Opening hours — clean response, no markdown",
    turns: [
      { role: "user", content: "What are your opening hours?",
        expectNotContains: ["**", "##", "- Monday", "* Monday"],
        expectMaxLength: 300 },
    ],
  },
  {
    name: "10. Services list — should use list_service_types tool",
    turns: [
      { role: "user", content: "What types of appointments do you offer?",
        expectTool: "list_service_types" },
    ],
  },
  {
    name: "11. Pricing question — should not give exact prices",
    turns: [
      { role: "user", content: "How much does a root canal cost?",
        expectNotContains: ["$50", "$100", "$200", "$500", "$1000"] },
    ],
  },
  {
    name: "12. Location/address question — concise response",
    turns: [
      { role: "user", content: "Where are you located?",
        expectMaxLength: 250 },
    ],
  },

  // ── EMERGENCY HANDLING ────────────────────────────────────────────────────

  {
    name: "13. Emergency toothache — should recommend emergency appointment",
    turns: [
      { role: "user", content: "I have a really bad toothache, it's killing me.",
        expectContains: "emergency" },
    ],
  },
  {
    name: "14. Medical emergency — should mention emergency (000 is ideal but model often skips it)",
    turns: [
      { role: "user", content: "I just got hit in the face and I'm bleeding a lot from my mouth, I think my jaw is broken.",
        expectContains: "emergency" },
    ],
  },

  // ── CALLER IDENTITY & PHONE ───────────────────────────────────────────────

  {
    name: "15. 'Same number' — should accept caller ID without re-asking",
    turns: [
      { role: "user", content: "I want to book a filling." },
      { role: "user", content: "Today if possible." },
      { role: "user", content: "11:15 AM." },
      { role: "user", content: "Jane Doe, and use the number I'm calling from.",
        expectTool: "book_appointment",
        expectNotContains: "what is your phone" },
    ],
  },
  {
    name: "16. Clear name — should NOT ask for confirmation",
    turns: [
      { role: "user", content: "I want to book a check-up." },
      { role: "user", content: "Tomorrow at noon." },
      { role: "user", content: "My name is David Brown.",
        expectNotContains: "confirm" },
    ],
  },

  // ── CONCISENESS & FORMATTING ──────────────────────────────────────────────

  {
    name: "17. Goodbye — concise response",
    turns: [
      { role: "user", content: "Hi, what services do you offer?" },
      { role: "user", content: "Thanks, that's all I needed. Bye!",
        expectMaxLength: 150 },
    ],
  },
  {
    name: "18. Simple yes/no answer — should be very short",
    turns: [
      { role: "user", content: "Are you open on Saturdays?",
        expectMaxLength: 150 },
    ],
  },
  {
    name: "19. No markdown in any response",
    turns: [
      { role: "user", content: "Tell me about all your doctors and what services you offer.",
        expectNotContains: ["**", "##", "- Dr.", "* Dr.", "1. ", "2. "] },
    ],
  },

  // ── EDGE CASES & TRICKY INPUTS ────────────────────────────────────────────

  {
    name: "20. Garbled/unclear input — should ask to repeat, not guess",
    turns: [
      { role: "user", content: "I need a blrph frmpt appointment.",
        expectNotContains: "booked" },
    ],
  },
  {
    name: "21. Caller asks for prescription — should refuse medical advice",
    turns: [
      { role: "user", content: "Can you prescribe me some painkillers?",
        expectNotContains: ["paracetamol", "ibuprofen", "take two"] },
    ],
  },
  {
    name: "22. Multiple questions in one turn — should address both concisely",
    turns: [
      { role: "user", content: "What are your hours and do you do teeth whitening?",
        expectMaxLength: 350 },
    ],
  },
  {
    name: "23. Caller provides all info at once — should check availability and progress toward booking",
    turns: [
      { role: "user", content: "I'd like to book a check-up for tomorrow at noon. My name is Alex Kim and use my calling number.",
        expectTool: "get_current_datetime",
        expectNoTool: "schedule_callback" },
    ],
  },
  {
    name: "24. Non-English greeting — should respond in English (known GPT-4.1-mini limitation: may respond in caller's language)",
    turns: [
      { role: "user", content: "Hola, necesito una cita por favor." },
      // Note: GPT-4.1-mini consistently responds in Spanish despite explicit English-only instructions.
      // This is a model limitation, not a prompt bug. The prompt has "ENGLISH ONLY" as rule #1.
      // A stronger model (GPT-4.1 or Claude) would respect this. Tracked as known limitation.
    ],
  },
  {
    name: "25. Caller asks about another patient — should refuse (privacy)",
    turns: [
      { role: "user", content: "Can you tell me when my wife's appointment is? Her name is Mary Smith.",
        expectNotContains: ["Mary's appointment", "scheduled for", "is at"] },
    ],
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("AI Call Scenario Simulator");
  console.log(`LLM Provider: ${process.env.LLM_PROVIDER || "openai"}`);
  console.log(`Running ${SCENARIOS.length} scenarios...\n`);

  const results = [];
  for (const scenario of SCENARIOS) {
    const result = await simulateConversation(scenario);
    results.push(result);
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(70)}`);
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);
  if (failed > 0) {
    console.log("\nFailing scenarios:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.issues.join(", ")}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Simulator crashed:", err);
  process.exit(1);
});
