#!/usr/bin/env node
/**
 * Gemini Live Scenario Simulator
 *
 * Tests the Gemini 3.1 Flash Live model with the real system prompt and tools
 * by sending text input via the Live WebSocket API and checking AI responses
 * and tool call behavior.
 *
 * Usage: GEMINI_API_KEY=xxx node tests/gemini-live-scenarios.js
 */

const WebSocket = require("ws");
const { buildSystemPrompt, getGreeting } = require("../lib/prompt-builder");
const { calendarToolDefinitions, listServiceTypesToolDefinition, callbackToolDefinition } = require("../services/tool-executor");
const { convertToolsToGemini } = require("../services/gemini-live");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is required");
  process.exit(1);
}

const GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";
const GEMINI_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

// ─── Mock data ───────────────────────────────────────────────────────────────

const mockAssistant = {
  name: "Smile Hub AI",
  systemPrompt: null,
  promptConfig: {
    tone: "friendly",
    customInstructions: "",
    behaviors: { afterHoursHandling: true },
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

const TOOL_RESULTS = {
  get_current_datetime: () => ({ message: "Current date and time: Thursday, March 27, 2026, 10:30 AM (Australia/Sydney). Today's date: 2026-03-27." }),
  check_availability: (args) => ({ message: `On ${args.date || "today"}, openings at 11:15 AM, 12:00 PM, 12:45 PM, 1:30 PM, 2:15 PM, 3:00 PM. Which time works best?` }),
  book_appointment: (args) => ({ message: `Booked appointment for ${args.datetime || "the requested time"} with Dr. Sarah Chen. Anything else?` }),
  list_service_types: () => ({ message: "Available: Check-up & Clean (45 min), Filling (45 min), Emergency (30 min), Consultation (30 min), Root Canal (90 min)" }),
  schedule_callback: (args) => ({ message: `Callback scheduled for ${args.caller_name || "you"}. Someone will call back.` }),
  cancel_appointment: () => ({ message: "Appointment cancelled." }),
};

// ─── Gemini Live session helper ──────────────────────────────────────────────

function createTestSession(systemPrompt, tools) {
  return new Promise((resolve, reject) => {
    const url = `${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`;
    const ws = new WebSocket(url);
    const geminiTools = convertToolsToGemini(tools);

    let fullTranscript = "";
    let toolsCalled = [];
    let resolveResponse = null;
    let currentResponse = "";

    ws.on("open", () => {
      const setupMsg = {
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["TEXT"],  // Text mode for testing — no audio needed
            temperature: 0.7,
          },
          systemInstruction: { parts: [{ text: systemPrompt }] },
          tools: geminiTools.length > 0 ? [{ functionDeclarations: geminiTools }] : undefined,
        },
      };
      ws.send(JSON.stringify(setupMsg));
    });

    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.setupComplete) {
        resolve({
          sendText: (text) => {
            return new Promise((res) => {
              currentResponse = "";
              toolsCalled = [];
              resolveResponse = res;
              ws.send(JSON.stringify({
                clientContent: {
                  turns: [{ role: "user", parts: [{ text }] }],
                  turnComplete: true,
                },
              }));
            });
          },
          close: () => ws.close(),
          getToolsCalled: () => toolsCalled,
        });
        return;
      }

      if (msg.serverContent) {
        if (msg.serverContent.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.text) currentResponse += part.text;
          }
        }
        if (msg.serverContent.turnComplete && resolveResponse) {
          const r = resolveResponse;
          resolveResponse = null;
          r({ text: currentResponse, tools: [...toolsCalled] });
        }
      }

      if (msg.toolCall) {
        const responses = [];
        for (const call of (msg.toolCall.functionCalls || [])) {
          toolsCalled.push(call.name);
          const handler = TOOL_RESULTS[call.name];
          const result = handler ? handler(call.args || {}) : { message: `Unknown tool: ${call.name}` };
          responses.push({ id: call.id, name: call.name, response: { result } });
        }
        ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      }
    });

    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("Session setup timeout")), 15000);
  });
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: "1. Basic booking — uses book_appointment correctly",
    turns: [
      { text: "I'd like to book a check-up and clean for tomorrow please.",
        expectTool: "get_current_datetime" },
      { text: "11:15 AM works. My name is John Smith, use my calling number.",
        expectTool: "book_appointment",
        expectNoTool: "schedule_callback" },
    ],
  },
  {
    name: "2. Transfer request — concise refusal",
    turns: [
      { text: "Can I speak to Dr. Wilson?",
        expectNoTool: "book_appointment",
        expectMaxLength: 200 },
    ],
  },
  {
    name: "3. Opening hours — no markdown",
    turns: [
      { text: "What are your opening hours?",
        expectNotContains: ["**", "##", "- Monday"],
        expectMaxLength: 350 },
    ],
  },
  {
    name: "4. Emergency toothache — mentions emergency",
    turns: [
      { text: "I have a terrible toothache, it's really painful.",
        expectContains: "emergency" },
    ],
  },
  {
    name: "5. Callback request — uses schedule_callback",
    turns: [
      { text: "Can someone call me back about my bill? My name is Sarah Jones.",
        expectNoTool: "book_appointment" },
    ],
  },
  {
    name: "6. Services list — uses list_service_types",
    turns: [
      { text: "What types of appointments do you offer?",
        expectTool: "list_service_types" },
    ],
  },
  {
    name: "7. Goodbye — concise",
    turns: [
      { text: "What services do you offer?" },
      { text: "Thanks, that's all. Bye!",
        expectMaxLength: 150 },
    ],
  },
  {
    name: "8. Caller provides all info at once — should progress to booking",
    turns: [
      { text: "Book me a filling for tomorrow at noon. Name is Alex Kim, use my calling number.",
        expectTool: "get_current_datetime" },
    ],
  },
  {
    name: "9. Prescription request — refuses medical advice",
    turns: [
      { text: "Can you prescribe me some painkillers?",
        expectNotContains: ["paracetamol", "ibuprofen"] },
    ],
  },
  {
    name: "10. Privacy — refuses to share other patient info",
    turns: [
      { text: "Can you tell me when my wife Mary's appointment is?",
        expectNotContains: ["Mary's appointment is", "scheduled for"] },
    ],
  },
  {
    name: "11. Sunday booking — should say closed",
    turns: [
      { text: "Can I book an appointment for this Sunday?",
        expectContains: "closed" },
    ],
  },
  {
    name: "12. Vague request — asks to clarify",
    turns: [
      { text: "I need to come in sometime.",
        expectNotContains: "booked" },
    ],
  },
  {
    name: "13. Caller changes mind — handles gracefully",
    turns: [
      { text: "I want to book a filling." },
      { text: "Actually never mind, how much does a root canal cost?",
        expectNoTool: "book_appointment" },
    ],
  },
  {
    name: "14. Yes/no question — short response",
    turns: [
      { text: "Are you open on Saturdays?",
        expectContains: "saturday",
        expectMaxLength: 150 },
    ],
  },
  {
    name: "15. Specific person insistence — should not promise",
    turns: [
      { text: "I specifically need to see Dr. Chen, not anyone else.",
        expectNotContains: "book you with Dr. Chen" },
    ],
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

async function runScenario(scenario) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SCENARIO: ${scenario.name}`);
  console.log(`${"=".repeat(60)}`);

  const systemPrompt = buildSystemPrompt(
    mockAssistant, mockOrganization,
    "We have Dr. Sarah Chen and Dr. James Wilson. Lisa Thompson is our hygienist.",
    { calendarEnabled: true, transferRules: [], isAfterHours: false, serviceTypes: mockServiceTypes }
  ) + "\n\nCALLER CONTEXT:\nThe caller's phone number is +61400000000.";

  const tools = [...calendarToolDefinitions, listServiceTypesToolDefinition, callbackToolDefinition];

  let session;
  try {
    session = await createTestSession(systemPrompt, tools);
  } catch (err) {
    console.log(`  [ERROR] Session setup failed: ${err.message}`);
    return { name: scenario.name, passed: false, issues: [`Setup failed: ${err.message}`] };
  }

  let passed = true;
  const issues = [];

  for (const turn of scenario.turns) {
    console.log(`\nUser: "${turn.text}"`);

    let response;
    try {
      response = await Promise.race([
        session.sendText(turn.text),
        new Promise((_, rej) => setTimeout(() => rej(new Error("Response timeout (30s)")), 30000)),
      ]);
    } catch (err) {
      console.log(`  [ERROR] ${err.message}`);
      issues.push(err.message);
      passed = false;
      break;
    }

    const { text, tools: calledTools } = response;
    if (calledTools.length > 0) console.log(`  [TOOLS] ${calledTools.join(", ")}`);
    console.log(`  AI: "${text.slice(0, 150)}${text.length > 150 ? "..." : ""}"`);

    // Check assertions
    if (turn.expectTool) {
      const expected = Array.isArray(turn.expectTool) ? turn.expectTool : [turn.expectTool];
      for (const t of expected) {
        if (!calledTools.includes(t)) {
          console.log(`  [FAIL] Expected tool: ${t}`);
          issues.push(`Missing tool: ${t}`);
          passed = false;
        }
      }
    }
    if (turn.expectNoTool) {
      const forbidden = Array.isArray(turn.expectNoTool) ? turn.expectNoTool : [turn.expectNoTool];
      for (const t of forbidden) {
        if (calledTools.includes(t)) {
          console.log(`  [FAIL] Should NOT call: ${t}`);
          issues.push(`Unexpected tool: ${t}`);
          passed = false;
        }
      }
    }
    if (turn.expectContains) {
      const lower = text.toLowerCase();
      const checks = Array.isArray(turn.expectContains) ? turn.expectContains : [turn.expectContains];
      for (const c of checks) {
        if (!lower.includes(c.toLowerCase())) {
          console.log(`  [FAIL] Should contain: "${c}"`);
          issues.push(`Missing: "${c}"`);
          passed = false;
        }
      }
    }
    if (turn.expectNotContains) {
      const lower = text.toLowerCase();
      const checks = Array.isArray(turn.expectNotContains) ? turn.expectNotContains : [turn.expectNotContains];
      for (const c of checks) {
        if (lower.includes(c.toLowerCase())) {
          console.log(`  [FAIL] Should NOT contain: "${c}"`);
          issues.push(`Unexpected: "${c}"`);
          passed = false;
        }
      }
    }
    if (turn.expectMaxLength && text.length > turn.expectMaxLength) {
      console.log(`  [FAIL] Too long: ${text.length} (max ${turn.expectMaxLength})`);
      issues.push(`Too long: ${text.length}/${turn.expectMaxLength}`);
      passed = false;
    }
  }

  session.close();
  console.log(`\nResult: ${passed ? "PASS ✅" : "FAIL ❌"}`);
  if (issues.length) console.log(`Issues: ${issues.join(", ")}`);
  return { name: scenario.name, passed, issues };
}

async function main() {
  console.log("Gemini Live Scenario Simulator");
  console.log(`Model: ${GEMINI_MODEL}`);
  console.log(`Running ${SCENARIOS.length} scenarios...\n`);

  const results = [];
  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
    // Small delay between scenarios to avoid rate limiting
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}`);
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
