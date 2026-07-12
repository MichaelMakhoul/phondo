"use strict";

const { SENTRY_REASONS, setReasonTag } = require("../sentry-reasons");

/**
 * Kill-switch route handlers extracted from server.js (SCRUM-287).
 *
 * Purpose: make the AI-disabled paths unit-testable. server.js is a
 * 4000-line Express monolith with handlers attached via `app.post()`;
 * the previous SCRUM-273 contract tests exercise the Sentry shim
 * directly but cannot prove that the handlers actually CALL Sentry on
 * the right error path. A regression that drops a
 * `try { Sentry.withScope(...) } catch (...)` block would not be
 * caught by contract tests alone.
 *
 * Design: pure functions taking `(req, res, opts)` where `opts.deps`
 * is a dependency-injection object. server.js wires the real deps;
 * tests wire mocks. Provider-specific bits (action URLs, recording
 * callback paths, Sentry `provider` tag) are passed in too, so the
 * same code services both /twiml (Twilio) and /texml (Telnyx).
 *
 * Behaviour MUST be byte-identical to the inline server.js version —
 * the SCRUM-273 contract tests + existing answer-mode-sentry tests
 * lock the alert-line shape in place, and this extraction is checked
 * against them. Do not "improve" the Sentry tag/extras shape here
 * without also updating the contract tests in lockstep.
 * (SCRUM-212 deliberately changed the voicemail <Record> TwiML — added
 * recordingStatusCallback attributes — with the tests updated in
 * lockstep. The Sentry shapes remain untouched.)
 */

/**
 * Build the voicemail TwiML/TeXML body. Same shape for both providers
 * except the recording-action URL differs:
 *   - Twilio: /twiml/ai-disabled-recording-done
 *   - Telnyx: /texml/recording-done (legacy callback path)
 *
 * SCRUM-212: when `recordingStatusCallbackUrl` is provided (Twilio only),
 * the <Record> carries the same recordingStatusCallback attributes as the
 * ring-first <Connect> — Twilio POSTs the finished recording to the
 * Next.js webhook, which downloads the audio into Supabase storage, the
 * same pipeline AI-answered calls use. Without it the audio stays on
 * Twilio and the dashboard's raw-URL fallback gets a 401 in the browser.
 */
function buildVoicemailResponse({ businessName, pollyVoice, recordActionUrl, escapeXml, publicUrl, recordingStatusCallbackUrl }) {
  const greeting = businessName
    ? `Thank you for calling ${escapeXml(businessName)}. We are unable to take your call right now. Please leave a message after the beep and we will get back to you as soon as possible.`
    : `Thank you for calling. We are unable to take your call right now. Please leave a message after the beep and we will get back to you as soon as possible.`;
  const statusCallbackAttrs = recordingStatusCallbackUrl
    ? ` recordingStatusCallback="${escapeXml(recordingStatusCallbackUrl)}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed failed absent"`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}">${greeting}</Say>
  <Record maxLength="120" playBeep="true" action="${escapeXml(publicUrl + recordActionUrl)}"${statusCallbackAttrs} />
  <Say voice="${pollyVoice}">Thank you for your message. Goodbye.</Say>
</Response>`;
}

/**
 * Resolve the recordingStatusCallback URL for a voicemail <Record>.
 * Telnyx always gets null — the Next.js recording webhook validates
 * Twilio signatures, so a Telnyx POST would be rejected with a 403
 * (Telnyx voicemail storage is tracked separately in SCRUM-212).
 * Twilio without APP_PUBLIC_URL degrades to the legacy raw-URL flow.
 */
function voicemailStatusCallbackUrl({ isTwilio, deps, logTag }) {
  if (!isTwilio) return null;
  if (!deps.recordingStatusCallbackUrl) {
    console.warn(`${logTag} APP_PUBLIC_URL not set — voicemail recording stays on Twilio; dashboard playback of this message will 401 (SCRUM-212)`);
    return null;
  }
  return deps.recordingStatusCallbackUrl;
}

/**
 * Handle the AI-disabled branch of /twiml or /texml.
 *
 * Returns `true` if a response was sent (caller must NOT continue).
 * Returns `false` if the kill switch is OFF and the caller should
 * continue with the normal AI-answer flow (ring-first, then AI).
 *
 * Mirrors the inline logic at server.js:280-394 (twilio) and
 * server.js:511-603 (telnyx) verbatim. The `provider` parameter
 * selects between the two action URLs and Sentry tags.
 */
async function handleAiDisabledBranch(req, res, opts) {
  const {
    called,
    from,
    reqCallSid,
    phoneRecord,
    provider, // "twilio" | "telnyx"
    deps,
  } = opts;
  const {
    Sentry,
    isAiEnabled,
    getPhoneNumberContext,
    createCallRecord,
    completeCallRecord,
    maskPhone,
    escapeXml,
    buildFallbackDisclosureSay,
    getPollyVoice,
    publicUrl,
    e164Regex,
  } = deps;

  const isTwilio = provider === "twilio";
  const logTag = isTwilio ? "[TwiML]" : "[TeXML]";
  const fallbackStatusPath = isTwilio
    ? "/twiml/ai-disabled-fallback-status"
    : "/texml/ai-disabled-fallback-status";
  const recordingDonePath = isTwilio
    ? "/twiml/ai-disabled-recording-done"
    : "/texml/recording-done";

  // For Telnyx, outbound rules require a Telnyx-owned callerId; the
  // inbound `from` is rejected. Use the called (org's Telnyx) number
  // so the dial is accepted.
  const fallbackCallerId = isTwilio ? from : called;

  try {
    const aiEnabled = await isAiEnabled(called, phoneRecord, { callSid: reqCallSid });
    if (aiEnabled) return false; // AI should answer — caller continues

    const callSid = reqCallSid || `ai_disabled_${Date.now()}`;
    const rawFallback =
      phoneRecord && typeof phoneRecord.fallback_forward_number === "string"
        ? phoneRecord.fallback_forward_number.trim()
        : "";
    // Defense-in-depth: re-validate at the voice-server before dialing.
    // The API + DB CHECK already enforce this; this guards against any
    // future writer that bypasses both (cron, manual SQL).
    const fallback = e164Regex.test(rawFallback) ? rawFallback : "";

    // Log call so owner sees it in dashboard. Leave outcome=null when we
    // are about to dial a fallback — it will be finalised in the action
    // callback once we know whether the dial completed. Writing an
    // optimistic "transferred" here would corrupt analytics if the
    // fallback is unreachable.
    let ctx = null;
    try {
      ctx = await getPhoneNumberContext(called, phoneRecord, { callSid });
      if (ctx) {
        const callId = await createCallRecord({
          orgId: ctx.organizationId,
          assistantId: ctx.assistantId,
          phoneNumberId: ctx.phoneNumberId,
          callerPhone: from,
          callSid,
        });
        if (callId && !fallback) {
          // No fallback configured → completing as voicemail right now is
          // correct; the recording will overwrite duration when it lands.
          await completeCallRecord(callId, {
            status: "completed",
            durationSeconds: 0,
            outcome: "voicemail",
          });
        }
        // When fallback IS configured, leave the call record open. The
        // /<twiml|texml>/ai-disabled-fallback-status callback will finalise it.
      }
    } catch (logErr) {
      console.warn(`${logTag} Failed to log AI-disabled call (non-fatal):`, logErr.message);
      // Page on this — a regression in createCallRecord / completeCallRecord
      // would silently break the dashboard for every paused-AI call.
      try {
        Sentry.withScope((scope) => {
          scope.setTag("service", "voice-server");
          setReasonTag(scope, SENTRY_REASONS.LOG_FAILED);
          scope.setLevel("warning");
          scope.setExtras({
            calledMasked: maskPhone(called),
            callSid,
            orgId: ctx?.organizationId,
            provider,
          });
          Sentry.captureException(logErr);
        });
      } catch (sentryErr) {
        console.error(`${logTag} Sentry capture failed (suppressed):`, sentryErr.message);
      }
    }

    if (fallback) {
      console.log(
        `${logTag} AI disabled for ${called} — forwarding to fallback ${maskPhone(fallback)} (callSid=${callSid})`,
      );
      // action callback lets us (a) update the call record with the real
      // DialCallStatus + DialCallDuration, and (b) fall through to
      // voicemail if the fallback was unreachable rather than dropping
      // the caller. Mirrors the existing /<provider>/ring-first-fallback flow.
      const disclosureSay = buildFallbackDisclosureSay({
        phoneRecord,
        callerPhone: from,
        escapeXml,
        callSid,
      });
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
${disclosureSay}  <Dial callerId="${escapeXml(fallbackCallerId)}" timeout="30" action="${escapeXml(publicUrl + fallbackStatusPath)}">
    ${escapeXml(fallback)}
  </Dial>
</Response>`);
      return true;
    }

    // Preserve the pre-refactor log strings byte-for-byte so external
    // Loki dashboards / runbooks that grep for these survive the
    // extraction. Twilio carries (callSid=...) AND the "TwiML" word;
    // Telnyx carries neither — that asymmetry was the original code's
    // behaviour and we keep it deliberately.
    if (isTwilio) {
      console.log(`${logTag} AI disabled for ${called} — returning voicemail TwiML (callSid=${callSid})`);
    } else {
      console.log(`${logTag} AI disabled for ${called} — returning voicemail TeXML`);
    }
    const businessName = typeof ctx?.organizationName === "string" ? ctx.organizationName : null;
    const pollyVoice = getPollyVoice(phoneRecord?.organizations?.country);
    res.type("text/xml").send(
      buildVoicemailResponse({
        businessName,
        pollyVoice,
        recordActionUrl: recordingDonePath,
        escapeXml,
        publicUrl,
        recordingStatusCallbackUrl: voicemailStatusCallbackUrl({ isTwilio, deps, logTag }),
      }),
    );
    return true;
  } catch (err) {
    // Fail-open: if anything in the kill-switch handler throws, let AI
    // answer. This is the outermost net — `isAiEnabled` already
    // captures its own DB failures, but any synchronous defect in the
    // surrounding code (XML escaping, response building, etc.) would
    // otherwise silently route the caller to AI despite a paused AI
    // setting. Page on it explicitly.
    console.error(`${logTag} kill-switch handler threw (fail-open):`, err.message);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.FAIL_OPEN);
        scope.setLevel("error");
        scope.setExtras({
          calledMasked: maskPhone(called),
          callSid: reqCallSid,
          provider,
          stage: "killswitch-handler",
        });
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error(`${logTag} Sentry capture failed (suppressed):`, sentryErr.message);
    }
    return false; // fall through to AI-first
  }
}

/**
 * Update the open call record created when the kill-switch handler
 * detected ai_enabled=false. Called from the
 * /<twiml|texml>/ai-disabled-fallback-status webhook once Twilio /
 * Telnyx reports the dial outcome.
 *
 * Mirrors server.js:913-971 verbatim. The `provider` parameter
 * tags Sentry events so on-call can distinguish which carrier
 * tripped.
 */
async function finaliseFallbackDial(callSid, dialStatus, durationSeconds, provider, deps) {
  const { Sentry, supabase, completeCallRecord } = deps;
  // Find the open call record created when /<twiml|texml> first
  // detected ai_enabled=false. We used `vapi_call_id = sh_${callSid}`
  // in createCallRecord, so we look it up by that key. Failing
  // silently here would lose the audit trail.
  const { data: callRow, error: findErr } = await supabase
    .from("calls")
    .select("id, organization_id")
    .eq("vapi_call_id", `sh_${callSid}`)
    .maybeSingle();
  if (findErr) {
    console.error(`[FallbackStatus] Lookup failed for callSid=${callSid}:`, findErr.message);
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.FALLBACK_FINALISE_FAILED);
        scope.setLevel("warning");
        scope.setExtras({
          callSid,
          dialStatus,
          durationSeconds,
          stage: "lookup",
          provider,
        });
        Sentry.captureException(findErr);
      });
    } catch (sentryErr) {
      console.error("[FallbackStatus] Sentry capture failed (suppressed):", sentryErr.message);
    }
    return;
  }
  if (!callRow) {
    console.warn(
      `[FallbackStatus] No call record for callSid=${callSid} — kill-switch path may have skipped createCallRecord`,
    );
    return;
  }
  try {
    await completeCallRecord(callRow.id, {
      status: "completed",
      durationSeconds,
      outcome: dialStatus === "completed" ? "transferred" : "voicemail",
      answeredBy: dialStatus === "completed" ? "owner" : undefined,
    });
  } catch (err) {
    console.error(
      `[FallbackStatus] completeCallRecord failed for callSid=${callSid}:`,
      err.message,
    );
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.FALLBACK_FINALISE_FAILED);
        scope.setLevel("warning");
        scope.setExtras({
          callSid,
          dialStatus,
          durationSeconds,
          stage: "complete",
          callId: callRow.id,
          orgId: callRow.organization_id,
          provider,
        });
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error("[FallbackStatus] Sentry capture failed (suppressed):", sentryErr.message);
    }
  }
}

/**
 * Handle /twiml/ai-disabled-fallback-status or /texml/ai-disabled-fallback-status.
 *
 * Signature validation lives in the route wiring (server.js) — this
 * handler runs after the request is known to be from the right carrier.
 *
 * Mirrors server.js:973-1033 (Twilio) and server.js:1035-1089 (Telnyx).
 */
async function handleAiDisabledFallbackStatus(req, res, opts) {
  const { provider, deps } = opts;
  const {
    Sentry,
    lookupPhoneNumber,
    getPhoneNumberContext,
    maskPhone,
    escapeXml,
    getPollyVoice,
    publicUrl,
  } = deps;

  const isTwilio = provider === "twilio";
  const logTag = isTwilio ? "[FallbackStatus]" : "[FallbackStatus][TeXML]";
  const recordingDonePath = isTwilio
    ? "/twiml/ai-disabled-recording-done"
    : "/texml/recording-done";

  const callSid = req.body.CallSid;
  const dialStatus = req.body.DialCallStatus;
  const durationSeconds = parseInt(req.body.DialCallDuration, 10) || 0;
  // Twilio sends `Called`; Telnyx sends both `Called` and `To` (older
  // payloads use `To`). Keep the same dual-key read as the inline
  // version.
  const called = isTwilio
    ? req.body.Called || ""
    : req.body.Called || req.body.To || "";

  console.log(`${logTag} callSid=${callSid} dialStatus=${dialStatus} duration=${durationSeconds}s`);

  await finaliseFallbackDial(callSid, dialStatus, durationSeconds, provider, deps);

  if (dialStatus === "completed") {
    // Owner picked up — provider handles teardown.
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
  }

  // Owner unreachable (no-answer / busy / failed / canceled). Don't drop the
  // caller — fall through to a brief apology + voicemail recording so the
  // business at least gets a message. The recording lands via the
  // provider-specific recording-done webhook.
  let businessName = null;
  let orgCountry = null;
  try {
    const phoneRecord = await lookupPhoneNumber(called, { callSid });
    const ctx = await getPhoneNumberContext(called, phoneRecord, { callSid });
    businessName = typeof ctx?.organizationName === "string" ? ctx.organizationName : null;
    orgCountry = phoneRecord?.organizations?.country || null;
  } catch (err) {
    // Preserve the pre-refactor warn-line wording per provider — the
    // Twilio variant says "for voicemail greeting", the Telnyx one
    // does not. Loki dashboards key on the exact string.
    if (isTwilio) {
      console.warn(`${logTag} Failed to load business name for voicemail greeting:`, err.message);
    } else {
      console.warn(`${logTag} Failed to load business name:`, err.message);
    }
    try {
      Sentry.withScope((scope) => {
        scope.setTag("service", "voice-server");
        setReasonTag(scope, SENTRY_REASONS.VOICEMAIL_GREETING_LOOKUP_FAILED);
        scope.setLevel("warning");
        scope.setExtras({ callSid, calledMasked: maskPhone(called), provider });
        Sentry.captureException(err);
      });
    } catch (sentryErr) {
      console.error(`${logTag} Sentry capture failed (suppressed):`, sentryErr.message);
    }
  }

  const pollyVoice = getPollyVoice(orgCountry);
  res.type("text/xml").send(
    buildVoicemailResponse({
      businessName,
      pollyVoice,
      recordActionUrl: recordingDonePath,
      escapeXml,
      publicUrl,
      recordingStatusCallbackUrl: voicemailStatusCallbackUrl({ isTwilio, deps, logTag }),
    }),
  );
}

/**
 * Handle /twiml/ai-disabled-recording-done — Twilio POSTs here when the
 * voicemail <Record> finishes (the verb's `action` callback, which must
 * return TwiML to end the call). Extracted from server.js for unit
 * testability (same rationale as SCRUM-287).
 *
 * SCRUM-212: the REAL storage work happens out-of-band — the <Record>'s
 * recordingStatusCallback POSTs to the Next.js webhook, which downloads
 * the audio into Supabase storage and nulls recording_url. This handler
 * only (1) writes the raw Twilio URL as a degraded fallback so the
 * message isn't lost if that pipeline fails — guarded with
 * `.is("recording_storage_path", null)` so it can never clobber a row
 * the pipeline already migrated (callback ordering is not guaranteed) —
 * and (2) speaks the goodbye. Signature validation lives in the route
 * wiring (server.js).
 */
async function handleVoicemailRecordingDone(req, res, opts) {
  const { deps } = opts;
  const { supabase, getPollyVoice } = deps;

  const recordingUrl = req.body.RecordingUrl;
  const callSid = req.body.CallSid;
  if (recordingUrl && callSid) {
    try {
      const { error } = await supabase
        .from("calls")
        .update({ recording_url: recordingUrl })
        .eq("vapi_call_id", `sh_${callSid}`)
        .is("recording_storage_path", null);
      if (error) {
        console.warn("[RecordingDone] Failed to save recording URL:", {
          callSid, code: error.code, message: error.message,
        });
      }
    } catch (err) {
      console.warn("[RecordingDone] Error saving recording (non-fatal):", err.message);
    }
  }

  // No phoneRecord in scope at this callback — Twilio only sends CallSid +
  // recording metadata. Fetching the org country would require an extra DB
  // roundtrip just for a 5-word hang-up acknowledgment; the AU/UK accent
  // was already delivered on the greeting + record-end "Thank you for your
  // message. Goodbye." Falls through to Polly.Joanna by design.
  const pollyVoice = getPollyVoice(null);
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${pollyVoice}">Thank you for your message. Goodbye.</Say>
  <Hangup/>
</Response>`);
}

module.exports = {
  handleAiDisabledBranch,
  handleAiDisabledFallbackStatus,
  handleVoicemailRecordingDone,
  finaliseFallbackDial,
  // Exported only for tests — internal helper.
  _test: { buildVoicemailResponse },
};
