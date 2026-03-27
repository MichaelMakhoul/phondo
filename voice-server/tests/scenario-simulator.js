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
  {
    name: "1. Basic appointment booking — should use book_appointment (not schedule_callback)",
    turns: [
      { role: "user", content: "I'd like to book a check-up and clean please.",
        expectNoTool: "schedule_callback" },
      { role: "user", content: "Tomorrow would be great.",
        expectTool: "check_availability" },  // AI already knows today's date from turn 1
      { role: "user", content: "The 11:15 AM slot please." },
      { role: "user", content: "My name is John Smith and you can use the number I'm calling from.",
        expectTool: "book_appointment",
        expectNoTool: "schedule_callback" },
    ],
  },
  {
    name: "2. Transfer request — should offer callback, NOT book an appointment",
    turns: [
      { role: "user", content: "Can I speak to Dr. Wilson please?",
        expectNoTool: "book_appointment",
        expectNotContains: "system automatically assigns",
        expectMaxLength: 200 },
    ],
  },
  {
    name: "3. Opening hours inquiry — short concise response",
    turns: [
      { role: "user", content: "What are your opening hours?",
        expectNotContains: ["**", "##", "- Monday"],
        expectMaxLength: 300 },
    ],
  },
  {
    name: "4. Emergency toothache — should recommend emergency appointment",
    turns: [
      { role: "user", content: "I have a really bad toothache, it's killing me.",
        expectContains: "emergency" },
    ],
  },
  {
    name: "5. Callback request — should use schedule_callback (not book_appointment)",
    turns: [
      { role: "user", content: "Can you have someone call me back about my bill? My name is Sarah Jones.",
        expectTool: "schedule_callback",
        expectNoTool: "book_appointment" },
    ],
  },
  {
    name: "6. Caller uses 'same number' — should NOT ask for phone again",
    turns: [
      { role: "user", content: "I want to book a filling." },
      { role: "user", content: "Today if possible." },  // AI already checked availability for today in turn 1
      { role: "user", content: "11:15 AM." },
      { role: "user", content: "Jane Doe, and use the number I'm calling from.",
        expectTool: "book_appointment",
        expectNotContains: "what is your phone" },
    ],
  },
  {
    name: "7. Goodbye response — should be concise (under 100 chars)",
    turns: [
      { role: "user", content: "Hi, what services do you offer?" },
      { role: "user", content: "Thanks, that's all I needed. Bye!",
        expectMaxLength: 150 },
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
