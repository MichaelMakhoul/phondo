"use strict";

// SCRUM-596: the owner assistant in the dashboard. The org's owner talks to the
// phone line's owner assistant in the browser (/ws/test). Their dashboard login,
// checked by Next.js before it signs a mode:"owner" token, stands in for the PIN.
// These helpers keep server.js's /ws/test owner branch down to wiring.

const { buildOwnerPrompt, buildOwnerGreeting } = require("./owner-prompt");

const OWNER_WEB_TIMEZONE_FALLBACK = "Australia/Sydney";

/**
 * Whether a verified /ws/test token is the owner's (Next.js signs mode "owner"
 * only for the org's owner, with the owner assistant's UI switched on).
 * @param {any} tokenData
 * @returns {boolean}
 */
function isOwnerWebToken(tokenData) {
  return Boolean(tokenData) && typeof tokenData === "object" && tokenData.mode === "owner";
}

/**
 * The session's call id (logs, and calls.vapi_call_id via createCallRecord):
 * its token's id, safe characters only.
 * @param {unknown} jti
 * @returns {string}
 */
function ownerWebCallSid(jti) {
  const safe = typeof jti === "string" ? jti.replace(/[^A-Za-z0-9-]/g, "").slice(0, 36) : "";
  return `web_owner_${safe || `t${Date.now()}`}`;
}

/**
 * The phone line's owner prompt and greeting, dated in the org's timezone. A
 * missing zone is Sydney, and a malformed one falls back the same way, as on
 * the phone line (server.js's owner prompt).
 * @param {{ organization: { name?: string, timezone?: string }, serviceTypes?: any[], ownerFirstName?: string|null, now?: Date }} o
 * @returns {{ systemPrompt: string, greeting: string }}
 */
function buildOwnerWebPrompt({ organization, serviceTypes = [], ownerFirstName = null, now = new Date() }) {
  let timezone = (organization && organization.timezone) || OWNER_WEB_TIMEZONE_FALLBACK;
  let todayStr;
  try {
    todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  } catch {
    console.warn(`[OwnerWeb] org timezone ${JSON.stringify(String(timezone)).slice(0, 60)} is not a valid IANA zone — using ${OWNER_WEB_TIMEZONE_FALLBACK}`);
    timezone = OWNER_WEB_TIMEZONE_FALLBACK;
    todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
  }
  return {
    systemPrompt: buildOwnerPrompt({
      orgName: (organization && organization.name) || "",
      ownerFirstName,
      timezone,
      todayStr,
      serviceTypes,
      practitioners: [],
      signedInOnWeb: true,
    }),
    greeting: buildOwnerGreeting(ownerFirstName),
  };
}

/**
 * One browser owner session per org at a time: a second tab is refused. The
 * voice server is one long-running process, so in-memory is authoritative (as
 * for the /ws/test caps).
 * @returns {{ tryOpen(orgId: string): boolean, close(orgId: string): void }}
 */
function createOwnerWebSessions() {
  /** @type {Set<string>} */
  const open = new Set();
  return {
    tryOpen(orgId) {
      if (open.has(orgId)) return false;
      open.add(orgId);
      return true;
    },
    close(orgId) {
      open.delete(orgId);
    },
  };
}

/**
 * The phone line's owner post-call (server.js cleanupSession), for a browser
 * session:
 * - wait for owner tool calls still running;
 * - summarise them from the tool log (no OpenAI analysis);
 * - redact as the org asks;
 * - write the owner row, with one retry (Next.js tells an owner call from a
 *   customer one by this row);
 * - then send the call-completed webhook.
 * If the row isn't written, page instead of sending the webhook: without
 * call_type "owner", Next.js would treat the owner's session as a customer call.
 * @param {any} session
 * @param {{ transcript: string, durationSeconds: number }} call
 * @param {{
 *   settleOwnerToolRuns: (s: any) => Promise<void>,
 *   buildOwnerCallSummary: (audit: any[]) => string,
 *   detectAndRedact: (text: string) => { piiFound: boolean, redacted: string },
 *   completeCallRecord: (id: string, fields: object) => Promise<void>,
 *   notifyCallCompleted: (url: string, secret: string, payload: object) => Promise<void>,
 *   internalApiUrl?: string,
 *   internalApiSecret?: string,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {Promise<{ recordWritten: boolean }>}
 */
async function finishOwnerWebSession(session, { transcript, durationSeconds }, deps) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await deps.settleOwnerToolRuns(session);
  if (!session.callRecordId) {
    console.warn(`[OwnerWeb] no call record for ${session.callSid} — nothing to complete, call-completed webhook skipped (org=${session.organizationId})`);
    return { recordWritten: false };
  }

  let summary = deps.buildOwnerCallSummary(session.toolCallAudit || []);
  let storedTranscript = transcript;
  let piiRedacted = false;
  if (session.piiRedactionEnabled) {
    const t = deps.detectAndRedact(storedTranscript);
    if (t.piiFound) {
      storedTranscript = t.redacted;
      piiRedacted = true;
    }
    const s = deps.detectAndRedact(summary);
    if (s.piiFound) {
      summary = s.redacted;
      piiRedacted = true;
    }
  }

  let recordWritten = false;
  for (let attempt = 1; !recordWritten && attempt <= 2; attempt++) {
    if (attempt > 1) await sleep(1000);
    try {
      await deps.completeCallRecord(session.callRecordId, {
        status: "completed",
        durationSeconds,
        transcript: storedTranscript,
        summary,
        callerName: session.ownerFirstName || "Owner",
        actionTaken: "owner_call",
        callType: "owner",
        ownerAuth: "verified",
        channel: "web",
        piiRedacted,
      });
      recordWritten = true;
    } catch (err) {
      console.error("[OwnerWeb] Failed to complete call record:", err);
    }
  }
  if (!recordWritten) {
    console.error(`[ALERT:error] [OwnerWeb] owner web session record not written — call-completed webhook skipped (callSid=${session.callSid}, callId=${session.callRecordId}, org=${session.organizationId})`);
    return { recordWritten };
  }

  if (deps.internalApiUrl && deps.internalApiSecret) {
    deps
      .notifyCallCompleted(deps.internalApiUrl, deps.internalApiSecret, {
        callId: session.callRecordId,
        organizationId: session.organizationId,
        assistantId: session.assistantId,
        callerPhone: null,
        status: "completed",
        durationSeconds,
        transcript: storedTranscript,
        endedReason: "web-session-ended",
        callType: "owner",
        ownerAuth: "verified",
      })
      .catch((err) => console.error("[OwnerWeb] Failed to notify call completed:", err));
  }
  return { recordWritten };
}

module.exports = {
  isOwnerWebToken,
  ownerWebCallSid,
  buildOwnerWebPrompt,
  createOwnerWebSessions,
  finishOwnerWebSession,
};
