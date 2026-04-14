/**
 * Outbound calling service — orchestrates Twilio outbound calls
 * with Gemini Live AI playing a caller persona.
 */

const crypto = require("crypto");
const { WebSocket } = require("ws");
const { Sentry } = require("../lib/sentry");
const { createGeminiSession } = require("./gemini-live");
const { getScenario, getScenarioForIndustry } = require("../lib/outbound-scenarios");
const { swapAssistant, restoreAssistant, getTestAssistantId } = require("../lib/outbound-fixtures");

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const OUTBOUND_CALLER_NUMBER = process.env.OUTBOUND_CALLER_NUMBER;

// Pending outbound calls — token → { resolve, reject, scenario, startedAt }
const pendingCalls = new Map();

// ── Token helpers ──

const TOKEN_TTL_MS = 300_000; // 5 minutes — Twilio trial accounts add delays before TwiML fetch

function generateOutboundToken(data, secret) {
  const payload = { ...data, exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret || INTERNAL_API_SECRET).update(payloadB64).digest("hex");
  return `${payloadB64}.${sig}`;
}

function verifyOutboundToken(token, secret) {
  if (!token) return null;
  try {
    const [payloadB64, sig] = token.split(".");
    if (!payloadB64 || !sig) return null;

    const expected = crypto.createHmac("sha256", secret || INTERNAL_API_SECRET).update(payloadB64).digest("hex");
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Caller prompt builder ──

function buildCallerPrompt(scenario) {
  return `You are role-playing as a caller in a phone conversation.

PERSONA: ${scenario.persona}

YOUR GOAL: ${scenario.prompt}

RULES:
- You are the CALLER, not the receptionist. Wait for the receptionist to greet you first, then respond.
- Stay in character throughout the entire call.
- Be natural — use occasional filler words, pauses, and conversational language like a real human caller.
- When your goal is accomplished (or clearly cannot be accomplished), end the call naturally by saying goodbye.
- Do NOT mention that you are an AI or that this is a test.
- Do NOT break character under any circumstances.
- Keep your responses concise — real callers don't give speeches.`;
}

// ── Twilio REST call creation ──

/**
 * @param {object} [options]
 * @param {string} [options.sendDigits] - DTMF digits to send after call connects (e.g., "wwwwwwww1" for trial bypass)
 */
async function twilioCreateCall(to, from, twimlUrl, statusCallbackUrl, options) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const params = new URLSearchParams({
    To: to,
    From: from,
    Url: twimlUrl,
    StatusCallback: statusCallbackUrl,
    StatusCallbackEvent: "completed",
    StatusCallbackMethod: "POST",
  });

  // Twilio trial accounts play "Press any key to execute this call" to the called party.
  // SendDigits sends DTMF after the call connects, dismissing the trial message.
  if (options?.sendDigits) {
    params.set("SendDigits", options.sendDigits);
  }

  const resp = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    const err = new Error(`Twilio call creation failed (${resp.status}): ${body}`);
    Sentry.captureException(err);
    throw err;
  }

  const data = await resp.json();
  return data.sid; // CallSid
}

async function twilioHangup(callSid) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  try {
    await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Status: "completed" }).toString(),
    });
  } catch (err) {
    console.warn("[Outbound] Hangup failed (non-fatal):", err.message);
  }
}

// ── Core: make a single outbound call ──

/**
 * Make a single outbound call.
 *
 * @param {object} config
 * @param {string} config.targetNumber - E.164 phone number to call
 * @param {string} [config.scenarioId] - Built-in scenario ID
 * @param {object} [config.scenario] - Custom scenario { name, persona, prompt, expectedOutcomes }
 * @param {string} [config.industry] - Industry for assistant swapping + scenario adaptation
 * @param {number} [config.maxDurationSeconds] - Auto-hangup (default 180)
 * @param {string} [config.voiceName] - Gemini voice (default "Puck" — different from inbound default)
 * @returns {Promise<object>} Call result
 */
async function makeOutboundCall(config) {
  const {
    targetNumber,
    scenarioId,
    scenario: customScenario,
    industry,
    maxDurationSeconds = 180,
    voiceName = "Puck",
    trialMode = true, // Twilio trial accounts need DTMF to dismiss "press any key" message
  } = config;

  if (!targetNumber) throw new Error("targetNumber is required");
  if (!OUTBOUND_CALLER_NUMBER) throw new Error("OUTBOUND_CALLER_NUMBER env var not set — buy a dedicated outbound number");

  // Resolve scenario
  let scenario;
  if (scenarioId) {
    scenario = industry
      ? getScenarioForIndustry(scenarioId, industry)
      : getScenario(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  } else if (customScenario) {
    scenario = {
      id: "custom",
      name: customScenario.name || "Custom scenario",
      persona: customScenario.persona || "A caller",
      prompt: customScenario.prompt,
      expectedOutcomes: customScenario.expectedOutcomes || [],
    };
  } else {
    throw new Error("Either scenarioId or scenario is required");
  }

  // Assistant swap if industry specified
  let previousAssistantId = null;
  if (industry) {
    const testAssistantId = getTestAssistantId(industry);
    previousAssistantId = await swapAssistant(targetNumber, testAssistantId);
    if (previousAssistantId === null) {
      throw new Error(`Phone number ${targetNumber} not found or inactive — cannot swap assistant`);
    }
    // Small delay for DB propagation
    await new Promise((r) => setTimeout(r, 500));
  }

  let callToken = null;

  try {
    // Generate call token
    callToken = generateOutboundToken({
      scenarioId: scenario.id,
      targetNumber,
      industry: industry || null,
      voiceName,
    }, INTERNAL_API_SECRET);

    // Create a promise that resolves when the call ends
    const resultPromise = new Promise((resolve, reject) => {
      // Trial accounts add ~5 min delay before outbound TwiML is fetched
      const setupBufferSeconds = trialMode ? 330 : 30;
      const timeoutMs = (maxDurationSeconds + setupBufferSeconds) * 1000;
      const timeout = setTimeout(() => {
        pendingCalls.delete(callToken);
        reject(new Error(`Call timed out after ${maxDurationSeconds + setupBufferSeconds}s`));
      }, timeoutMs);

      pendingCalls.set(callToken, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
        scenario,
        voiceName,
        maxDurationSeconds,
        startedAt: Date.now(),
      });
    });

    // Initiate the Twilio call
    const twimlUrl = `${PUBLIC_URL}/outbound/twiml/${encodeURIComponent(callToken)}`;
    const statusUrl = `${PUBLIC_URL}/outbound/status/${encodeURIComponent(callToken)}`;

    let callSid;
    try {
      callSid = await twilioCreateCall(targetNumber, OUTBOUND_CALLER_NUMBER, twimlUrl, statusUrl, {
        // 'w' = 0.5s pause. 8x = 4s wait for trial message to play, then press 1.
        sendDigits: trialMode ? "wwwwwwww1" : undefined,
      });
    } catch (twilioErr) {
      // Clean up pending call entry + timeout to prevent leak and unhandled rejection
      const leaked = pendingCalls.get(callToken);
      if (leaked) {
        leaked.reject(twilioErr); // clears the timeout via the wrapped reject
        pendingCalls.delete(callToken);
      }
      throw twilioErr;
    }

    console.log(`[Outbound] Call initiated: ${callSid} → ${targetNumber} (scenario=${scenario.id}, industry=${industry || "default"})`);

    // Store callSid in pending call for hangup
    const pending = pendingCalls.get(callToken);
    if (pending) pending.callSid = callSid;

    // Wait for call to complete
    const result = await resultPromise;
    return result;

  } finally {
    // Always restore assistant, even if call fails
    if (previousAssistantId !== null) {
      try {
        await restoreAssistant(targetNumber, previousAssistantId);
      } catch (restoreErr) {
        console.error("[Outbound] CRITICAL: Failed to restore assistant:", restoreErr.message);
        Sentry.captureException(restoreErr);
      }
    }
  }
}

// ── Suite runner ──

/**
 * Run multiple scenarios sequentially.
 *
 * @param {object} config
 * @param {string} config.targetNumber
 * @param {object[]} config.scenarios - Array of { scenarioId?, scenario?, industry? }
 * @param {number} [config.delayBetweenCallsMs] - Delay between calls (default 15000 for free tier)
 * @param {string} [config.rateLimitMode] - "free" (default) or "paid"
 * @param {number} [config.maxDurationSeconds] - Per-call max duration (default 180)
 * @param {string} [config.voiceName] - Gemini voice for outbound caller
 * @returns {Promise<object>}
 */
async function runOutboundSuite(config) {
  const {
    targetNumber,
    scenarios,
    delayBetweenCallsMs = 15000,
    rateLimitMode = "free",
    maxDurationSeconds = 180,
    voiceName = "Puck",
  } = config;

  if (!targetNumber) throw new Error("targetNumber is required");
  if (!scenarios || scenarios.length === 0) throw new Error("scenarios array is required");

  const suiteStartedAt = Date.now();

  const effectiveDelay = rateLimitMode === "free"
    ? Math.max(delayBetweenCallsMs, 15000)
    : delayBetweenCallsMs;

  const estimatedMinutes = Math.ceil((scenarios.length * (maxDurationSeconds + effectiveDelay / 1000)) / 60);
  console.log(`[Outbound] Suite started: ${scenarios.length} scenarios, delay=${effectiveDelay}ms, estimated max ~${estimatedMinutes}min`);

  const results = [];
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const scenarioLabel = s.scenarioId || s.scenario?.name || `scenario-${i}`;
    console.log(`[Outbound] Running ${i + 1}/${scenarios.length}: ${scenarioLabel}`);

    try {
      const result = await makeOutboundCall({
        targetNumber,
        scenarioId: s.scenarioId,
        scenario: s.scenario,
        industry: s.industry,
        maxDurationSeconds,
        voiceName: s.voiceName || voiceName,
      });
      results.push(result);
      completed++;
    } catch (err) {
      console.error(`[Outbound] Scenario failed (${scenarioLabel}):`, err.message);

      // Retry once on 429 (Gemini rate limit)
      if (rateLimitMode === "free" && err.message.includes("429")) {
        console.log("[Outbound] Rate limited — waiting 60s and retrying...");
        await new Promise((r) => setTimeout(r, 60000));
        try {
          const retryResult = await makeOutboundCall({
            targetNumber,
            scenarioId: s.scenarioId,
            scenario: s.scenario,
            industry: s.industry,
            maxDurationSeconds,
            voiceName: s.voiceName || voiceName,
          });
          results.push(retryResult);
          completed++;
          // Continue to delay below
        } catch (retryErr) {
          results.push({
            status: "failed",
            scenario: { id: s.scenarioId || "custom", name: scenarioLabel, industry: s.industry },
            error: retryErr.message,
            expectedOutcomes: s.scenario?.expectedOutcomes || [],
          });
          failed++;
        }
      } else {
        results.push({
          status: "failed",
          scenario: { id: s.scenarioId || "custom", name: scenarioLabel, industry: s.industry },
          error: err.message,
          expectedOutcomes: s.scenario?.expectedOutcomes || [],
        });
        failed++;
      }
    }

    // Delay between calls (skip after last)
    if (i < scenarios.length - 1) {
      console.log(`[Outbound] Waiting ${effectiveDelay}ms before next call...`);
      await new Promise((r) => setTimeout(r, effectiveDelay));
    }
  }

  const totalDuration = results.reduce((sum, r) => sum + (r.call?.duration || 0), 0);

  return {
    results,
    summary: {
      total: scenarios.length,
      completed,
      failed,
      totalDuration,
      wallClockSeconds: Math.round((Date.now() - suiteStartedAt) / 1000),
    },
  };
}

// ── WebSocket handler for outbound calls ──

/**
 * Handle an outbound WebSocket connection from Twilio.
 * Creates a Gemini Live session with the caller persona and wires audio.
 *
 * @param {WebSocket} twilioWs - The Twilio Media Stream WebSocket
 * @param {object} tokenData - Verified token payload
 */
/**
 * Handle an outbound WebSocket connection from Twilio.
 * IMPORTANT: tokenData must have `_token` set to the raw token string
 * for pendingCalls Map lookup. The caller (server.js) must attach it:
 *   tokenData._token = rawTokenString;
 *
 * @param {WebSocket} twilioWs
 * @param {object} tokenData - Verified token payload with `_token` attached
 */
function handleOutboundConnection(twilioWs, tokenData) {
  const pending = pendingCalls.get(tokenData._token);
  if (!pending) {
    console.error("[Outbound] No pending call for token");
    twilioWs.close(4004, "No pending call");
    return;
  }

  const { scenario, voiceName, maxDurationSeconds } = pending;
  let streamSid = null;
  let callSid = null;
  let geminiSession = null;
  let callStartedAt = null;
  let cleaningUp = false;

  // Transcript collection
  const transcript = []; // { role: "inbound"|"outbound", text }
  let pendingInboundTranscript = "";
  let pendingOutboundTranscript = "";

  // Max duration timer
  let maxDurationTimer = null;

  function cleanup(status, error) {
    if (cleaningUp) return;
    cleaningUp = true;

    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }

    if (geminiSession) {
      try { geminiSession.close(); } catch {}
      geminiSession = null;
    }

    // Flush remaining transcript
    if (pendingInboundTranscript.trim()) {
      transcript.push({ role: "inbound", text: pendingInboundTranscript.trim() });
    }
    if (pendingOutboundTranscript.trim()) {
      transcript.push({ role: "outbound", text: pendingOutboundTranscript.trim() });
    }

    const duration = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0;

    const result = {
      status: error ? "failed" : (status || "completed"),
      scenario: {
        id: scenario.id,
        name: scenario.name,
        industry: tokenData.industry || null,
      },
      call: {
        sid: callSid || pending.callSid,
        from: OUTBOUND_CALLER_NUMBER,
        to: tokenData.targetNumber,
        duration,
        startedAt: callStartedAt ? new Date(callStartedAt).toISOString() : null,
        endedAt: new Date().toISOString(),
      },
      transcript,
      expectedOutcomes: scenario.expectedOutcomes || [],
      ...(error && { error }),
    };

    // Remove from pending and resolve
    const token = tokenData._token;
    const p = pendingCalls.get(token);
    pendingCalls.delete(token);
    if (p) {
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    }
  }

  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "connected") {
      console.log("[Outbound] Twilio WebSocket connected");
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      callSid = msg.start?.callSid;
      callStartedAt = Date.now();

      console.log(`[Outbound] Stream started: callSid=${callSid}, streamSid=${streamSid}`);

      // Start max duration timer
      maxDurationTimer = setTimeout(() => {
        console.log(`[Outbound] Max duration (${maxDurationSeconds}s) reached — hanging up`);
        if (pending.callSid) twilioHangup(pending.callSid);
        cleanup("timeout");
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, "Max duration");
      }, maxDurationSeconds * 1000);

      // Create Gemini session with caller persona
      const callerPrompt = buildCallerPrompt(scenario);

      geminiSession = createGeminiSession(
        {
          systemPrompt: callerPrompt,
          tools: [], // Outbound caller has no tools — it's just talking
          voiceName: voiceName || "Puck",
        },
        {
          onAudio: (twilioBase64) => {
            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: twilioBase64 },
              }));
            }
          },
          onToolCall: async () => {
            // Outbound caller should never call tools
            return { message: "Tool calls not supported for outbound caller" };
          },
          onTranscriptIn: (text) => {
            // What the outbound AI HEARS = inbound AI speaking
            pendingInboundTranscript += text;
          },
          onTranscriptOut: (text) => {
            // What the outbound AI SAYS = outbound persona speaking
            pendingOutboundTranscript += text;
          },
          onInterrupted: () => {
            // Flush inbound transcript on interruption
            if (pendingInboundTranscript.trim()) {
              transcript.push({ role: "inbound", text: pendingInboundTranscript.trim() });
              pendingInboundTranscript = "";
            }
          },
          onTurnComplete: () => {
            // Flush both transcripts on turn complete
            if (pendingInboundTranscript.trim()) {
              transcript.push({ role: "inbound", text: pendingInboundTranscript.trim() });
              pendingInboundTranscript = "";
            }
            if (pendingOutboundTranscript.trim()) {
              transcript.push({ role: "outbound", text: pendingOutboundTranscript.trim() });
              pendingOutboundTranscript = "";
            }
          },
          onError: (err) => {
            console.error("[Outbound] Gemini session error:", err.message);
            Sentry.captureException(err);
            cleanup("failed", err.message);
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(4500, "Gemini error");
          },
          onClose: (code) => {
            console.log(`[Outbound] Gemini session closed (code=${code})`);
            cleanup("completed");
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, "Call ended");
          },
        }
      );
    }

    if (msg.event === "media" && geminiSession) {
      geminiSession.sendAudio(msg.media.payload);
    }

    if (msg.event === "stop") {
      console.log("[Outbound] Twilio stream stopped");
      cleanup("completed");
    }
  });

  twilioWs.on("close", () => {
    cleanup("completed");
  });

  twilioWs.on("error", (err) => {
    console.error("[Outbound] WebSocket error:", err.message);
    cleanup("failed", err.message);
  });
}

module.exports = {
  generateOutboundToken,
  verifyOutboundToken,
  buildCallerPrompt,
  makeOutboundCall,
  runOutboundSuite,
  handleOutboundConnection,
  pendingCalls,
};
