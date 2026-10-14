/**
 * In-memory store for sessions waiting on transfer dial callbacks.
 * When Twilio's <Dial> finishes (answered, no-answer, busy, failed),
 * the action URL retrieves the saved state to either complete the call
 * or reconnect the caller back to the AI.
 */

const { completeCallRecord, notifyCallCompleted } = require("./call-logger");
const { analyzeCallTranscript } = require("../services/post-call-analysis");
const { maybeEmitUnhappyCall } = require("./unhappy-call");

const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const pendingTransfers = new Map();
const TRANSFER_TTL_MS = 180_000; // 25s ring per destination × up to 5 destinations + buffer

/**
 * Save session state while the transfer dial is in progress.
 * Keyed by Twilio CallSid — only one transfer can be active per call.
 *
 * @param {string} callSid
 * @param {object} sessionState
 */
function saveForTransfer(callSid, sessionState) {
  // callSid is stamped into the entry so finishTransferredCall can report
  // it (unhappy-call paging, SCRUM-192) regardless of which caller —
  // status webhook or TTL sweep — hands the entry over.
  pendingTransfers.set(callSid, { ...sessionState, callSid, savedAt: Date.now() });
}

/**
 * Get a pending transfer entry if it exists and hasn't expired.
 * Does NOT remove the entry — use consumeTransfer() for that.
 *
 * @param {string} callSid
 * @returns {object|null}
 */
function getTransfer(callSid) {
  const entry = pendingTransfers.get(callSid);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > TRANSFER_TTL_MS) {
    pendingTransfers.delete(callSid);
    return null;
  }
  return entry;
}

/**
 * Get and remove a pending transfer entry.
 *
 * @param {string} callSid
 * @returns {object|null}
 */
function consumeTransfer(callSid) {
  const entry = getTransfer(callSid);
  if (entry) pendingTransfers.delete(callSid);
  return entry;
}

/**
 * Complete a transferred call's record — runs post-call analysis,
 * updates the DB, and notifies the Next.js app.
 * Used after a successful transfer (target answered) or on TTL expiry.
 *
 * @param {object} savedState - The saved session state from pendingTransfers
 * @param {string} outcome - The transfer outcome (e.g. "answered", "unknown_timeout")
 */
async function finishTransferredCall(savedState, outcome) {
  const transcript = savedState.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
    .join("\n");

  const durationSeconds = Math.round((Date.now() - savedState.startedAt) / 1000);

  // SCRUM-587: the owner fields saved at the hand-off (server.js). Owner
  // sessions have no transfer tool, so callType is null on every call that
  // gets here today; ownerAuth is what matters — a customer call that tripped
  // the PIN lockout and was then transferred must still reach
  // calls.metadata.owner_auth, or PR B never emails the owner.
  const isOwnerCall = savedState.callType === "owner";
  const ownerAuth = typeof savedState.ownerAuth === "string" ? savedState.ownerAuth : null;

  // Run post-call analysis (never on an owner call — same rule as cleanupSession)
  let analysis = null;
  if (!isOwnerCall && transcript && durationSeconds > 5) {
    try {
      analysis = await analyzeCallTranscript(transcript, { language: savedState.language });
    } catch (err) {
      console.error("[PendingTransfer] Post-call analysis failed:", err);
    }
  }

  // SCRUM-192: transfer-terminated calls are disproportionately the
  // unhappiest in the system (dead-ended dials, TTL expiries) — they must
  // page like every other completion path.
  maybeEmitUnhappyCall(analysis, {
    callSid: savedState.callSid,
    organizationId: savedState.organizationId,
    durationSeconds,
    transferOutcome: outcome,
  });

  // Update transfer attempt outcome
  const transferAttempt = savedState.transferAttempt
    ? { ...savedState.transferAttempt, outcome }
    : { outcome };

  // Complete call record (retry up to 2 times on failure)
  let recordWritten = false;
  if (savedState.callRecordId) {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await completeCallRecord(savedState.callRecordId, {
          status: "completed",
          durationSeconds,
          transcript,
          summary: analysis?.summary || null,
          callerName: analysis?.callerName || null,
          collectedData: analysis?.collectedData || null,
          successEvaluation: analysis?.successEvaluation || null,
          recordingDisclosurePlayed: false,
          recordingDisclosureFailed: false,
          transferAttempt,
          // SCRUM-587: written BEFORE notifyCallCompleted (below) — PR B reads
          // call_type / owner_auth from the row.
          callType: isOwnerCall ? "owner" : null,
          ownerAuth,
        });
        recordWritten = true;
        break;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          console.warn(`[PendingTransfer] completeCallRecord failed, retrying (${attempt + 1}/${MAX_RETRIES}):`, err.message);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        console.error("[PendingTransfer] Failed to complete call record after retries — record stuck in-progress:", {
          callRecordId: savedState.callRecordId,
          organizationId: savedState.organizationId,
          error: err.message,
        });
      }
    }
  }

  // Notify Next.js app
  if (isOwnerCall && !recordWritten) {
    // SCRUM-587: same rule as cleanupSession — without call_type="owner" in
    // the row PR B would process the owner's call as a customer's. Page (ids only).
    console.error(`[ALERT:error] [OwnerCall] owner call record not written — call-completed webhook skipped (callSid=${savedState.callSid}, callId=${savedState.callRecordId}, org=${savedState.organizationId})`);
  } else if (INTERNAL_API_URL && INTERNAL_API_SECRET && savedState.organizationId) {
    try {
      await notifyCallCompleted(INTERNAL_API_URL, INTERNAL_API_SECRET, {
        callId: savedState.callRecordId,
        organizationId: savedState.organizationId,
        assistantId: savedState.assistantId,
        callerPhone: savedState.callerPhone,
        status: "completed",
        durationSeconds,
        transcript,
        endedReason: "transferred",
        summary: analysis?.summary || undefined,
        callerName: analysis?.callerName || undefined,
        collectedData: analysis?.collectedData || undefined,
        successEvaluation: analysis?.successEvaluation || undefined,
        unansweredQuestions: analysis?.unansweredQuestions || undefined,
        // SCRUM-587: informational (PR B reads the row) — absent unless set.
        callType: isOwnerCall ? "owner" : undefined,
        ownerAuth: ownerAuth || undefined,
      });
    } catch (err) {
      console.error("[PendingTransfer] Failed to notify call completed:", err);
    }
  }
}

// Clean up expired entries every 30s.
// On expiry, complete orphaned call records to prevent them staying in-progress forever.
setInterval(() => {
  const now = Date.now();
  for (const [callSid, entry] of pendingTransfers) {
    if (now - entry.savedAt > TRANSFER_TTL_MS) {
      console.warn(`[PendingTransfer] TTL expired for callSid=${callSid} — completing as unknown_timeout`);
      pendingTransfers.delete(callSid);
      finishTransferredCall(entry, "unknown_timeout").catch((err) => {
        console.error("[PendingTransfer] TTL cleanup failed:", err);
      });
    }
  }
}, 30_000).unref();

module.exports = {
  saveForTransfer,
  getTransfer,
  consumeTransfer,
  finishTransferredCall,
};
