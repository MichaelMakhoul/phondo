# Recording Storage + Transcript Cleanup + Supported Languages Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix call recording playback (SCRUM-207), normalise multilingual transcripts via post-call cleanup (SCRUM-208), and make the Supported Languages setting actually feed the pipeline (SCRUM-209). All changes must work for BOTH Telnyx (primary) and Twilio (fallback/future).

**Architecture:**
- **Recordings:** Voice server triggers recording via TwiML/TeXML `record="record-from-answer"`. Provider (Twilio or Telnyx) POSTs a completion webhook to a new Next.js route. The route downloads the audio, uploads it to a private Supabase Storage bucket `call-recordings`, and updates the `calls` row with the storage path. Dashboard generates short-lived signed URLs on demand.
- **Cleaned transcript:** `post-call-analysis.js` is extended to produce a normalised `cleaned_transcript` (same structure as raw: array of `{role, text, original?, language?}`) by passing the raw transcript + supported languages to GPT-4.1-nano. Saved as `calls.cleaned_transcript JSONB`. Dashboard adds a Raw/Cleaned toggle.
- **Supported Languages:** `prompt-builder.js` adds an "expected caller languages" hint; `post-call-analysis.js` receives `supportedLanguages` and uses it as a recovery hint when cleaning up bad STT.

**Tech Stack:** Node.js voice-server, Next.js 15 App Router, Supabase Postgres + Storage, OpenAI gpt-4.1-nano, Twilio/Telnyx REST.

---

## File Structure

**New files:**
- `supabase/migrations/00120_cleaned_transcript.sql` — add `cleaned_transcript JSONB` column
- `supabase/migrations/00121_call_recordings_storage.sql` — bucket + RLS + `recording_storage_path` column
- `src/lib/call-recordings/download-and-store.ts` — shared download→upload→DB-update helper
- `src/lib/call-recordings/signed-url.ts` — helper to generate signed URLs for playback
- `src/app/api/webhooks/twilio-recording-done/route.ts` — Twilio recording-completed webhook
- `src/app/api/webhooks/telnyx-recording-done/route.ts` — Telnyx recording-completed webhook
- `src/app/api/v1/calls/[id]/recording-url/route.ts` — dashboard-side signed URL endpoint (authorised)

**Modified files:**
- `voice-server/services/post-call-analysis.js` — accept `supportedLanguages`, emit `cleaned_transcript`
- `voice-server/lib/call-logger.js` — persist `cleanedTranscript`
- `voice-server/lib/prompt-builder.js` — add "expected caller languages" hint
- `voice-server/server.js` — point recording callback URLs at the new Next.js webhooks instead of the voice-server's current handler; add `record="record-from-answer"` to the Telnyx TeXML `<Connect>`; pass `supportedLanguages` through to `analyzeCallTranscript`
- `src/app/(dashboard)/calls/[id]/call-detail.tsx` — use signed URL for playback; add Raw/Cleaned transcript toggle
- `src/app/(dashboard)/assistants/[id]/page.tsx` (or whichever file renders the Supported Languages control) — update tooltip copy
- `docs/test-scenarios.md` — add Sections 17, 18, 19

---

## Task 1: DB migration — `cleaned_transcript` column

**Files:**
- Create: `supabase/migrations/00120_cleaned_transcript.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00120_cleaned_transcript.sql
-- Adds cleaned_transcript JSONB for post-call analysis STT-normalised output (SCRUM-208).
-- Structure: { turns: [{ role: 'user'|'assistant', text: string, original?: string, language?: string }] }
-- Nullable because cleanup is best-effort and older calls predate this column.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS cleaned_transcript JSONB;

COMMENT ON COLUMN calls.cleaned_transcript IS
  'STT-normalised transcript produced by post-call analysis. Nullable. Structure: { turns: [{role, text, original?, language?}] }.';
```

- [ ] **Step 2: Apply migration**

```bash
# Via Supabase MCP:
#   mcp__supabase-phondo__apply_migration name=00120_cleaned_transcript query="..."
# Or local psql against remote (preferred for CI parity):
#   psql "$SUPABASE_DB_URL" -f supabase/migrations/00120_cleaned_transcript.sql
```

Expected: `ALTER TABLE` succeeds. Verify with `\d calls` that `cleaned_transcript | jsonb | | |` appears.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00120_cleaned_transcript.sql
git commit -m "feat(SCRUM-208): add cleaned_transcript column to calls"
```

---

## Task 2: DB migration — recording storage bucket + column

**Files:**
- Create: `supabase/migrations/00121_call_recordings_storage.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00121_call_recordings_storage.sql
-- Supabase Storage bucket for call recordings + new column on calls (SCRUM-207).

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS recording_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS recording_sid TEXT;

COMMENT ON COLUMN calls.recording_storage_path IS
  'Path within the call-recordings bucket, e.g. "<org_id>/<call_id>.mp3". NULL until recording is fetched from the provider.';

COMMENT ON COLUMN calls.recording_sid IS
  'Provider recording identifier (Twilio RecordingSid or Telnyx recording_id). Stored for idempotency when webhooks retry.';

-- Create bucket (private — never public).
INSERT INTO storage.buckets (id, name, public)
VALUES ('call-recordings', 'call-recordings', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: org members can SELECT (for dashboard signed URL issuance via service role),
-- but we default to service-role-only to keep writes centralised.
-- Reads from the dashboard flow through a Next.js route that uses the service role to
-- generate a signed URL after verifying org_members — no direct client access needed.

-- Block all anon/authenticated access; service role bypasses RLS by design.
CREATE POLICY "call-recordings deny all"
  ON storage.objects
  FOR ALL
  TO authenticated, anon
  USING (bucket_id <> 'call-recordings')
  WITH CHECK (bucket_id <> 'call-recordings');
```

- [ ] **Step 2: Apply migration**

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/00121_call_recordings_storage.sql
```

Expected: `ALTER TABLE`, `INSERT 0 1` (or `INSERT 0 0` on retry), `CREATE POLICY`. Verify bucket exists:

```bash
psql "$SUPABASE_DB_URL" -c "SELECT id, public FROM storage.buckets WHERE id = 'call-recordings';"
# Expect: call-recordings | f
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00121_call_recordings_storage.sql
git commit -m "feat(SCRUM-207): add call-recordings bucket and storage path column"
```

---

## Task 3: Shared helper — download provider recording → Supabase Storage → DB

**Files:**
- Create: `src/lib/call-recordings/download-and-store.ts`

- [ ] **Step 1: Write the helper**

```typescript
// src/lib/call-recordings/download-and-store.ts
import { createClient } from "@supabase/supabase-js";

type Provider = "twilio" | "telnyx";

interface DownloadAndStoreParams {
  provider: Provider;
  recordingUrl: string;   // signed or authenticated provider URL
  recordingSid: string;   // Twilio RecordingSid or Telnyx recording id
  callSid: string;        // Twilio CallSid or Telnyx call_control_id
}

interface DownloadAndStoreResult {
  ok: boolean;
  callId?: string;
  storagePath?: string;
  error?: string;
}

const BUCKET = "call-recordings";

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function fetchRecording(provider: Provider, url: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = {};
  if (provider === "twilio") {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID/AUTH_TOKEN not set");
    headers.Authorization = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  } else {
    const key = process.env.TELNYX_API_KEY;
    if (!key) throw new Error("TELNYX_API_KEY not set");
    headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Provider ${provider} returned ${res.status} fetching recording`);
  }
  return await res.arrayBuffer();
}

export async function downloadAndStoreRecording(
  params: DownloadAndStoreParams,
): Promise<DownloadAndStoreResult> {
  const { provider, recordingUrl, recordingSid, callSid } = params;
  const supabase = getServiceClient();

  // Look up the call row to get org + call id. Voice server prefixes Twilio
  // CallSids with "sh_" in vapi_call_id. Telnyx call_control_ids are saved
  // the same way (prefix "sh_") when we extend voice-server/server.js.
  const vapiCallId = `sh_${callSid}`;
  const { data: call, error: lookupErr } = await supabase
    .from("calls")
    .select("id, organization_id, recording_sid, recording_storage_path")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle();

  if (lookupErr) {
    return { ok: false, error: `Call lookup failed: ${lookupErr.message}` };
  }
  if (!call) {
    return { ok: false, error: `No call row for vapi_call_id=${vapiCallId}` };
  }

  // Idempotency: if we already stored this recording, do nothing.
  if (call.recording_sid === recordingSid && call.recording_storage_path) {
    return { ok: true, callId: call.id, storagePath: call.recording_storage_path };
  }

  // Download from provider.
  let audio: ArrayBuffer;
  try {
    audio = await fetchRecording(provider, recordingUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Download failed: ${msg}` };
  }

  // Upload to Supabase Storage.
  const storagePath = `${call.organization_id}/${call.id}.mp3`;
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, audio, {
      contentType: "audio/mpeg",
      upsert: true,
    });
  if (uploadErr) {
    return { ok: false, error: `Upload failed: ${uploadErr.message}` };
  }

  // Update call row — clear legacy recording_url so dashboard stops showing the broken link.
  const { error: updateErr } = await supabase
    .from("calls")
    .update({
      recording_storage_path: storagePath,
      recording_sid: recordingSid,
      recording_url: null,
    })
    .eq("id", call.id);
  if (updateErr) {
    return { ok: false, error: `DB update failed: ${updateErr.message}` };
  }

  return { ok: true, callId: call.id, storagePath };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/call-recordings/download-and-store.ts
git commit -m "feat(SCRUM-207): shared helper to store provider recordings in Supabase"
```

---

## Task 4: Signed URL helper

**Files:**
- Create: `src/lib/call-recordings/signed-url.ts`

- [ ] **Step 1: Write it**

```typescript
// src/lib/call-recordings/signed-url.ts
import { createClient } from "@supabase/supabase-js";

const BUCKET = "call-recordings";
const DEFAULT_EXPIRY_SECONDS = 60 * 10; // 10 minutes — enough for page load + playback

export async function createRecordingSignedUrl(
  storagePath: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string | null> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/call-recordings/signed-url.ts
git commit -m "feat(SCRUM-207): signed URL helper for call recording playback"
```

---

## Task 5: Twilio recording-done webhook (Next.js)

**Files:**
- Create: `src/app/api/webhooks/twilio-recording-done/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// src/app/api/webhooks/twilio-recording-done/route.ts
import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { downloadAndStoreRecording } from "@/lib/call-recordings/download-and-store";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-twilio-signature") || "";
  const url = new URL(req.url);
  // Twilio signature is computed over the FULL public URL (what Twilio POSTed to).
  // Use the value configured in voice-server when it registers the callback; fall back to req.url.
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL
    ? `${process.env.NEXT_PUBLIC_APP_URL}${url.pathname}${url.search}`
    : req.url;

  const bodyText = await req.text();
  const params = Object.fromEntries(new URLSearchParams(bodyText));

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[twilio-recording-done] TWILIO_AUTH_TOKEN not set");
    return new NextResponse("server not configured", { status: 500 });
  }

  const valid = twilio.validateRequest(authToken, signature, publicUrl, params);
  if (!valid) {
    console.warn("[twilio-recording-done] signature validation failed");
    return new NextResponse("forbidden", { status: 403 });
  }

  const { CallSid, RecordingUrl, RecordingSid, RecordingStatus } = params;
  if (RecordingStatus && RecordingStatus !== "completed") {
    // Only act on completed; ignore in-progress events.
    return NextResponse.json({ ok: true, ignored: RecordingStatus });
  }
  if (!CallSid || !RecordingUrl || !RecordingSid) {
    return new NextResponse("missing fields", { status: 400 });
  }
  if (!RecordingUrl.startsWith("https://api.twilio.com/")) {
    return new NextResponse("invalid recording url", { status: 400 });
  }

  const result = await downloadAndStoreRecording({
    provider: "twilio",
    recordingUrl: `${RecordingUrl}.mp3`,
    recordingSid: RecordingSid,
    callSid: CallSid,
  });

  if (!result.ok) {
    console.error("[twilio-recording-done] store failed:", result.error, { CallSid, RecordingSid });
    // Return 200 so Twilio doesn't spam retries for DB errors — we'll rely on alerts.
    return NextResponse.json({ ok: false, error: result.error });
  }

  return NextResponse.json({ ok: true, callId: result.callId });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/webhooks/twilio-recording-done/route.ts
git commit -m "feat(SCRUM-207): Twilio recording-done webhook → Supabase Storage"
```

---

## Task 6: Telnyx recording-done webhook (Next.js)

**Files:**
- Create: `src/app/api/webhooks/telnyx-recording-done/route.ts`

**Background:** Telnyx posts Call Control events via webhooks signed with ed25519. The payload for `call.recording.saved` includes `payload.recording_urls.mp3` (or `.wav`) and `payload.call_control_id`. Verify signature using the existing `TELNYX_PUBLIC_KEY` env var.

- [ ] **Step 1: Write the route**

```typescript
// src/app/api/webhooks/telnyx-recording-done/route.ts
import { NextRequest, NextResponse } from "next/server";
import nacl from "tweetnacl";
import { downloadAndStoreRecording } from "@/lib/call-recordings/download-and-store";

export const runtime = "nodejs";

function verifyTelnyxSignature(rawBody: string, signatureB64: string, timestamp: string): boolean {
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY;
  if (!publicKeyB64) return false;
  try {
    const msg = Buffer.from(`${timestamp}|${rawBody}`);
    const sig = Buffer.from(signatureB64, "base64");
    const key = Buffer.from(publicKeyB64, "base64");
    return nacl.sign.detached.verify(msg, sig, key);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("telnyx-signature-ed25519") || "";
  const timestamp = req.headers.get("telnyx-timestamp") || "";
  const rawBody = await req.text();

  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    console.warn("[telnyx-recording-done] signature validation failed");
    return new NextResponse("forbidden", { status: 403 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("bad json", { status: 400 });
  }

  const eventType = payload?.data?.event_type || payload?.data?.record_type;
  if (eventType !== "call.recording.saved") {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const p = payload?.data?.payload ?? {};
  const callControlId: string | undefined = p.call_control_id;
  const recordingId: string | undefined = p.recording_id || p.id;
  const mp3Url: string | undefined = p.recording_urls?.mp3 || p.public_recording_urls?.mp3;

  if (!callControlId || !recordingId || !mp3Url) {
    return new NextResponse("missing fields", { status: 400 });
  }

  const result = await downloadAndStoreRecording({
    provider: "telnyx",
    recordingUrl: mp3Url,
    recordingSid: recordingId,
    callSid: callControlId,
  });

  if (!result.ok) {
    console.error("[telnyx-recording-done] store failed:", result.error, { callControlId, recordingId });
    return NextResponse.json({ ok: false, error: result.error });
  }

  return NextResponse.json({ ok: true, callId: result.callId });
}
```

- [ ] **Step 2: Install tweetnacl if missing**

```bash
# Only if not already installed at the Next.js package level:
npm ls tweetnacl || npm install tweetnacl
```

Expected: installed or already present (voice-server already uses it for Telnyx signature).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/telnyx-recording-done/route.ts package.json package-lock.json
git commit -m "feat(SCRUM-207): Telnyx recording-saved webhook → Supabase Storage"
```

---

## Task 7: Voice server — swap Twilio recording callback to new Next.js route

**Context:** Currently `voice-server/server.js` sets `recordingStatusCallback="${PUBLIC_URL}/twiml/recording-status"` pointing at its own route which saves the raw Twilio URL. We want Twilio to post directly to Next.js so the download/store pipeline fires once, without going through the voice server.

**Files:**
- Modify: `voice-server/server.js` (around lines 699–703)
- Modify: `voice-server/.env.example` (add `APP_PUBLIC_URL`)

- [ ] **Step 1: Add env var to .env.example**

```
# Next.js app public URL (used so the voice server can tell Twilio/Telnyx where
# to POST recording-completed webhooks). Example: https://app.phondo.com
APP_PUBLIC_URL=
```

- [ ] **Step 2: Replace the callback URL in server.js**

Locate the ring-first AI-handoff block (currently around line 699–703) and change:

```javascript
const ringFirstRecordingMode = ringFirstPhoneRecord?.organizations?.recording_consent_mode || "auto";
const ringFirstShouldRecord = ringFirstRecordingMode !== "never";
const ringFirstConnectAttrs = ringFirstShouldRecord
  ? ` record="record-from-answer" recordingStatusCallback="${escapeXml(PUBLIC_URL + '/twiml/recording-status')}" recordingStatusCallbackMethod="POST"`
  : "";
```

to:

```javascript
const ringFirstRecordingMode = ringFirstPhoneRecord?.organizations?.recording_consent_mode || "auto";
const ringFirstShouldRecord = ringFirstRecordingMode !== "never";
const recordingCallbackBase = process.env.APP_PUBLIC_URL || PUBLIC_URL;
const ringFirstConnectAttrs = ringFirstShouldRecord
  ? ` record="record-from-answer" recordingStatusCallback="${escapeXml(recordingCallbackBase + '/api/webhooks/twilio-recording-done')}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"`
  : "";
```

Also find the primary `/twiml` handler (search `record="record-from-answer"` — there is a second occurrence in the non-ring-first path if it exists; apply the same change). If the main handler uses `<Connect>` without `record=`, add the same attributes.

- [ ] **Step 3: Keep the old `/twiml/recording-status` route as a no-op passthrough for safety**

Edit `/twiml/recording-status` handler to simply log and 200 — don't delete it yet; Twilio may still be configured to POST there for older provisioned numbers.

```javascript
app.post("/twiml/recording-status", async (req, res) => {
  if (!validateTwilioSignature(req)) {
    return res.status(403).send("Forbidden");
  }
  console.log("[Recording] Legacy callback hit — new flow is /api/webhooks/twilio-recording-done. Ignoring.", {
    CallSid: req.body.CallSid,
    RecordingSid: req.body.RecordingSid,
  });
  res.status(200).send("OK");
});
```

- [ ] **Step 4: Commit**

```bash
git add voice-server/server.js voice-server/.env.example
git commit -m "feat(SCRUM-207): route Twilio recordings to Next.js webhook"
```

---

## Task 8: Voice server — enable Telnyx recording + point at new webhook

**Context:** The Telnyx TeXML `/texml` handler currently uses bare `<Connect><Stream>` without a `record=` attribute. Telnyx TeXML is TwiML-compatible and supports `record="record-from-answer"` on `<Connect>`, but Telnyx does NOT post the recording callback via TeXML's `recordingStatusCallback` attribute — instead it uses Call Control webhooks configured at the **application** level. We will:

1. Add `record="record-from-answer"` so Telnyx starts recording when AI answers.
2. Rely on Telnyx Call Control Application's configured Webhook URL to receive `call.recording.saved` events. The webhook URL is set out-of-band (Telnyx portal or API) to `${APP_PUBLIC_URL}/api/webhooks/telnyx-recording-done`.

**Files:**
- Modify: `voice-server/server.js` — Telnyx TeXML default AI-answer response (around lines 455–466)

- [ ] **Step 1: Add record attribute to Telnyx TeXML**

Replace:

```javascript
res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
```

with:

```javascript
const telnyxRecordingMode = phoneRecord?.organizations?.recording_consent_mode || "auto";
const telnyxShouldRecord = telnyxRecordingMode !== "never";
const telnyxConnectAttrs = telnyxShouldRecord ? ` record="record-from-answer"` : "";

res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect${telnyxConnectAttrs}>
    <Stream url="${escapeXml(WS_URL)}">
      <Parameter name="auth_token" value="${escapeXml(token)}" />
    </Stream>
  </Connect>
</Response>`);
```

- [ ] **Step 2: Save Telnyx call_control_id as `sh_<id>` at call start**

Search `createCallRecord` calls for Telnyx path. The Telnyx TeXML event body uses `CallSid` (Telnyx mimics Twilio field names in TeXML), so the existing `sh_${callSid}` logic already works without changes. Verify by reading `voice-server/server.js` around the WebSocket `/ws/twilio` stream-start handler and confirming it does `createCallRecord({ ..., callSid: startPayload.start.callSid })` — the callSid here is the Telnyx call leg id from TeXML Stream params, which matches what the recording webhook's `call_control_id` will be.

If the two IDs do NOT match (TeXML `callSid` vs Call Control `call_control_id`), add a mapping: store both in metadata on call creation.

**Action:** Read `voice-server/server.js` stream-start handler. If `startPayload.start.callSid` does not equal Telnyx's `call_control_id`, store the Telnyx-provided id from the `client_state` or Stream start parameters into `metadata.telnyx_call_control_id` and change the Telnyx webhook lookup to match on that field instead.

If they do match (best case), no change needed.

- [ ] **Step 3: Document manual portal step**

Add to `voice-server/README.md` (or top of server.js as a comment):

```
# Telnyx recording webhook configuration (one-time)
# In the Telnyx portal → Call Control Application → Webhook URL, set:
#   https://<APP_PUBLIC_URL>/api/webhooks/telnyx-recording-done
# This is separate from the TeXML URL and receives call.recording.saved events.
```

- [ ] **Step 4: Commit**

```bash
git add voice-server/server.js voice-server/README.md
git commit -m "feat(SCRUM-207): enable Telnyx recording with record-from-answer"
```

---

## Task 9: Dashboard API — signed URL endpoint for recording playback

**Files:**
- Create: `src/app/api/v1/calls/[id]/recording-url/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// src/app/api/v1/calls/[id]/recording-url/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { createRecordingSignedUrl } from "@/lib/call-recordings/signed-url";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  // RLS on `calls` filters by organization_id via org_members, so this
  // single query simultaneously authorises and fetches.
  const { data: call, error } = await (supabase as any)
    .from("calls")
    .select("id, recording_storage_path")
    .eq("id", id)
    .maybeSingle();

  if (error) return new NextResponse("db error", { status: 500 });
  if (!call) return new NextResponse("not found", { status: 404 });
  if (!call.recording_storage_path) {
    return NextResponse.json({ url: null });
  }

  const url = await createRecordingSignedUrl(call.recording_storage_path);
  if (!url) return new NextResponse("sign failed", { status: 500 });

  return NextResponse.json({ url, expiresIn: 600 });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/v1/calls/[id]/recording-url/route.ts
git commit -m "feat(SCRUM-207): signed URL endpoint for recording playback"
```

---

## Task 10: Post-call analysis — accept supportedLanguages + emit cleaned_transcript

**Files:**
- Modify: `voice-server/services/post-call-analysis.js`

- [ ] **Step 1: Rewrite `analyzeCallTranscript` signature and prompt**

Replace the existing `ANALYSIS_PROMPT` and `analyzeCallTranscript` with:

```javascript
function buildAnalysisPrompt({ supportedLanguages }) {
  const languageHint = supportedLanguages && supportedLanguages.length > 0
    ? `\nThe caller is most likely speaking one of: ${supportedLanguages.join(", ")}. If the raw transcript contains tokens that look like a different language (e.g. Korean, Hindi, or Chinese characters when the caller probably spoke Arabic, French, or English), treat them as STT errors and recover the likely intended text.`
    : "";

  return `You are analyzing a phone call transcript between an AI receptionist and a caller.
The transcript may contain speech-to-text errors, especially misdetected languages.${languageHint}

You have TWO responsibilities.

1) Extract structured data (existing behaviour):
- caller_name: string or null
- caller_phone_reason: string or null
- appointment_requested: boolean
- summary: 1-2 sentence summary IN ENGLISH
- success_evaluation: "successful" | "partial" | "unsuccessful"
- collected_data: object or null
- unanswered_questions: array of strings in English, or null
- sentiment: "positive" | "neutral" | "negative"

2) Produce a cleaned transcript that normalises STT errors:
- cleaned_transcript: object { turns: [ { role: "user" | "assistant", text: string, original?: string, language?: string } ] }
- For each turn, keep the text in the language the caller/AI actually used (do NOT translate).
- If the raw turn contains obviously wrong characters (e.g., Korean or Chinese tokens inside an otherwise English utterance), replace them with the most likely intended English/Arabic/French text, and include the raw text under "original".
- Preserve turn order. Prefix speaker labels can be inferred from the raw transcript's "User:"/"Assistant:" markers.
- If the transcript is too garbled to confidently recover, return cleaned_transcript: null.

Return ONLY valid JSON with all fields above.`;
}

async function analyzeCallTranscript(transcript, options = {}) {
  const { supportedLanguages = [] } = options;

  if (!transcript || transcript.trim().length < 20) return null;
  if (!OPENAI_API_KEY) {
    console.error("[PostCallAnalysis] OPENAI_API_KEY not set");
    return null;
  }

  try {
    const messages = [
      { role: "system", content: buildAnalysisPrompt({ supportedLanguages }) },
      { role: "user", content: `Analyze this call transcript:\n\n${transcript.slice(0, 6000)}` },
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANALYSIS_MODEL,
        messages,
        max_tokens: 1200,     // raised from 500 — cleaned_transcript takes space
        temperature: 0.1,
        response_format: { type: "json_object" },
        stream: false,
      }),
    });

    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      console.error(`[PostCallAnalysis] OpenAI API error ${res.status}:`, text);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch (parseErr) {
      console.error("[PostCallAnalysis] Failed to parse JSON:", content.slice(0, 200));
      return null;
    }

    // Validate cleaned_transcript shape; drop if malformed.
    let cleanedTranscript = null;
    if (analysis.cleaned_transcript && Array.isArray(analysis.cleaned_transcript.turns)) {
      const turns = analysis.cleaned_transcript.turns.filter(
        (t) => t && typeof t.text === "string" && (t.role === "user" || t.role === "assistant"),
      );
      if (turns.length > 0) cleanedTranscript = { turns };
    }

    return {
      callerName: analysis.caller_name || null,
      callerPhoneReason: analysis.caller_phone_reason || null,
      appointmentRequested: !!analysis.appointment_requested,
      summary: analysis.summary || null,
      successEvaluation: analysis.success_evaluation || null,
      collectedData: analysis.collected_data || null,
      unansweredQuestions: Array.isArray(analysis.unanswered_questions) ? analysis.unanswered_questions : null,
      sentiment: ["positive", "neutral", "negative"].includes(analysis.sentiment) ? analysis.sentiment : null,
      cleanedTranscript,
    };
  } catch (err) {
    console.error("[PostCallAnalysis] Failed:", err.message);
    return null;
  }
}

module.exports = { analyzeCallTranscript };
```

(Keep the existing Sentry scope wrapping — omitted above for brevity. When editing, preserve those blocks around each `console.error`.)

- [ ] **Step 2: Find the callsite and pass supportedLanguages**

Search for `analyzeCallTranscript(` in voice-server. Likely in `server.js` or a wrap-up helper. Update to pass `{ supportedLanguages: ctx.multilingualEnabled ? ctx.supportedLanguages : [] }`.

- [ ] **Step 3: Commit**

```bash
git add voice-server/services/post-call-analysis.js voice-server/server.js
git commit -m "feat(SCRUM-208/209): cleaned_transcript + language hints in post-call analysis"
```

---

## Task 11: Call logger — persist cleanedTranscript

**Files:**
- Modify: `voice-server/lib/call-logger.js` (lines 46–107)

- [ ] **Step 1: Add cleanedTranscript to destructure + update payload**

In `completeCallRecord`, add `cleanedTranscript` to the destructured options and append:

```javascript
if (cleanedTranscript) updatePayload.cleaned_transcript = cleanedTranscript;
```

right after the `sentiment` assignment (around line 77).

- [ ] **Step 2: Update the caller**

Find where `completeCallRecord(...)` is invoked (search in voice-server). Add `cleanedTranscript: analysis?.cleanedTranscript ?? null` to the options object.

- [ ] **Step 3: Commit**

```bash
git add voice-server/lib/call-logger.js voice-server/server.js
git commit -m "feat(SCRUM-208): persist cleaned_transcript on call completion"
```

---

## Task 12: Prompt builder — "expected caller languages" hint

**Files:**
- Modify: `voice-server/lib/prompt-builder.js`

- [ ] **Step 1: Add a new hint line inside `buildBehaviorsSection`**

Just after the existing LANGUAGE line (around line 490–496), add:

```javascript
if (multilingualEnabled && supportedLanguages.length > 0) {
  lines.push(`- CALLER LANGUAGE HINT: The business expects callers to speak one of: ${supportedLanguages.join(", ")}. If transcribed input looks like a different language (e.g., unusual characters), assume STT misheard and ask the caller to repeat in one of the expected languages rather than answering nonsense.`);
}
```

- [ ] **Step 2: Mirror the change in the TypeScript source**

The JS port lives at `voice-server/lib/prompt-builder.js`. The source of truth is `src/lib/prompt-builder/` (TS). Find the matching function in TS and apply the same addition so they stay in sync.

Run: `grep -rn "LANGUAGE: You can respond in" src/lib/prompt-builder/` to locate the file, then apply the same hint line.

- [ ] **Step 3: Commit**

```bash
git add voice-server/lib/prompt-builder.js src/lib/prompt-builder/
git commit -m "feat(SCRUM-209): add expected-caller-language hint to system prompt"
```

---

## Task 13: Dashboard — signed URL playback + Raw/Cleaned transcript toggle

**Files:**
- Modify: `src/app/(dashboard)/calls/[id]/call-detail.tsx`

- [ ] **Step 1: Extend `Call` interface**

Around line 50–54, add:

```typescript
recording_storage_path: string | null;
cleaned_transcript: { turns: Array<{ role: "user" | "assistant"; text: string; original?: string; language?: string }> } | null;
```

And update the page-level query that loads the call to select these columns.

- [ ] **Step 2: Replace raw `<audio src={call.recording_url}>` with signed URL fetch**

Add a client-side effect that fetches the signed URL:

```tsx
const [recordingUrl, setRecordingUrl] = useState<string | null>(null);

useEffect(() => {
  if (!call.recording_storage_path) return;
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch(`/api/v1/calls/${call.id}/recording-url`);
      if (!res.ok) return;
      const json = await res.json();
      if (!cancelled && json.url) setRecordingUrl(json.url);
    } catch { /* silent — UI shows fallback below */ }
  })();
  return () => { cancelled = true; };
}, [call.id, call.recording_storage_path]);
```

Replace the audio block:

```tsx
{(call.recording_storage_path || call.recording_url) && (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <Mic className="h-5 w-5" />
        Recording
      </CardTitle>
    </CardHeader>
    <CardContent>
      {recordingUrl ? (
        <audio controls className="w-full" src={recordingUrl}>
          Your browser does not support the audio element.
        </audio>
      ) : call.recording_storage_path ? (
        <p className="text-sm text-muted-foreground">Loading recording…</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Legacy recording (stored with provider). Re-record this call to enable in-app playback.
        </p>
      )}
    </CardContent>
  </Card>
)}
```

- [ ] **Step 3: Add Raw/Cleaned toggle to transcript**

```tsx
const [transcriptMode, setTranscriptMode] = useState<"raw" | "cleaned">(
  call.cleaned_transcript ? "cleaned" : "raw"
);

// inside the Transcript card:
{call.cleaned_transcript && (
  <div className="mb-3 flex gap-2">
    <Button
      size="sm"
      variant={transcriptMode === "cleaned" ? "default" : "outline"}
      onClick={() => setTranscriptMode("cleaned")}
    >
      Cleaned
    </Button>
    <Button
      size="sm"
      variant={transcriptMode === "raw" ? "default" : "outline"}
      onClick={() => setTranscriptMode("raw")}
    >
      Raw
    </Button>
  </div>
)}

{transcriptMode === "cleaned" && call.cleaned_transcript ? (
  <ScrollArea className="h-[400px]">
    <div className="space-y-3 text-sm">
      {call.cleaned_transcript.turns.map((turn, i) => (
        <div key={i}>
          <span className="font-semibold">
            {turn.role === "user" ? "Caller" : "AI"}:
          </span>{" "}
          {turn.text}
          {turn.original && turn.original !== turn.text && (
            <div className="mt-1 text-xs text-muted-foreground">
              Original: {turn.original}
            </div>
          )}
        </div>
      ))}
    </div>
  </ScrollArea>
) : call.transcript ? (
  <ScrollArea className="h-[400px]">
    <pre className="whitespace-pre-wrap font-sans text-sm">{call.transcript}</pre>
  </ScrollArea>
) : (
  /* existing empty state */
)}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/\(dashboard\)/calls/\[id\]/call-detail.tsx
git commit -m "feat(SCRUM-207/208): signed URL playback + cleaned transcript toggle"
```

---

## Task 14: Update Supported Languages UI tooltip

**Files:**
- Modify: the assistant settings page that renders the "Supported Languages" multi-select.

- [ ] **Step 1: Locate the control**

```bash
grep -rn "Supported Languages" src/app src/components
```

- [ ] **Step 2: Update tooltip/help text**

Change the help text to:

```
Languages callers are likely to speak. Used for three things: (1) the AI adapts its responses to the caller's language, (2) the system prompt tells the AI to treat unexpected-language transcription as STT errors, and (3) post-call analysis uses the list to normalise mis-detected languages in the saved transcript.
```

- [ ] **Step 3: Commit**

```bash
git add <file>
git commit -m "docs(SCRUM-209): clarify what Supported Languages setting controls"
```

---

## Task 15: Smoke test — Section 17 (Recording Playback)

**Files:**
- Modify: `docs/test-scenarios.md`

- [ ] **Step 1: Append at end of file**

```markdown
---

## SECTION 17: Call Recording Playback (SCRUM-207)

Verifies recordings are captured by the provider, posted to the Next.js webhook, stored in Supabase Storage, and played back via signed URL in the dashboard.

### Scenario 17.1 — Telnyx Recording Round-Trip (Primary)
**Prerequisites:** Provisioned Telnyx number linked to an active assistant. Recording mode `auto` or `always` (NOT `never`). Call Control Application webhook URL set to `${APP_PUBLIC_URL}/api/webhooks/telnyx-recording-done`.

**Script:**
> Call the Telnyx number. Let the AI greet you. Have a ~30 second conversation. Hang up.

**Expected:**
- [ ] Voice server logs show TeXML `<Connect record="record-from-answer">`
- [ ] Within ~15 seconds of hang-up, Next.js logs show `[telnyx-recording-done]` webhook 200
- [ ] `calls.recording_storage_path` is populated for the new row
- [ ] Supabase Storage bucket `call-recordings` contains `<org_id>/<call_id>.mp3`
- [ ] Dashboard call detail page renders an audio player
- [ ] Play button works — audio plays without any auth prompt
- [ ] Signed URL has an `?token=...&expires=...` query string

### Scenario 17.2 — Twilio Recording Round-Trip (Fallback)
**Prerequisites:** Twilio number with voice-server `/twiml` configured as voice URL.

**Script:**
> Call the Twilio number. Have a short conversation. Hang up.

**Expected:**
- [ ] `[twilio-recording-done]` webhook 200 in Next.js logs
- [ ] Recording downloaded + uploaded to Supabase Storage
- [ ] Dashboard plays it via signed URL

### Scenario 17.3 — Recording Mode `never`
**Prerequisites:** Set org recording_consent_mode to `never`.

**Script:**
> Place a test call.

**Expected:**
- [ ] TeXML/TwiML does NOT include `record="record-from-answer"`
- [ ] No recording webhook fires
- [ ] `recording_storage_path` remains null
- [ ] Dashboard shows no Recording card

### Scenario 17.4 — Idempotent Webhook Retry
**Script:**
> Manually replay a recording-done webhook (curl with same signature/body).

**Expected:**
- [ ] Second call returns `{ ok: true }` without re-uploading
- [ ] Storage object unchanged (same size, timestamp)
- [ ] No duplicate DB update

### Scenario 17.5 — Legacy Call (Pre-SCRUM-207)
**Prerequisites:** Open an older call row that has `recording_url` set but no `recording_storage_path`.

**Expected:**
- [ ] Dashboard shows "Legacy recording (stored with provider)" message
- [ ] Does NOT attempt the broken provider URL
```

- [ ] **Step 2: Commit**

```bash
git add docs/test-scenarios.md
git commit -m "docs(SCRUM-207): add recording playback smoke tests"
```

---

## Task 16: Smoke test — Section 18 (Cleaned Transcript)

- [ ] **Step 1: Append Section 18**

```markdown
---

## SECTION 18: Cleaned Transcript (SCRUM-208)

Verifies that post-call analysis produces a usable `cleaned_transcript` that strips STT artifacts (e.g., Korean/Hindi/Chinese tokens when the caller spoke Arabic/French/English).

### Scenario 18.1 — English-Only Call, Clean STT
**Script:**
> Have a completely English conversation (30s+).

**Expected:**
- [ ] `calls.cleaned_transcript` populated
- [ ] Dashboard toggle shows Cleaned/Raw buttons
- [ ] Cleaned view ≈ raw view (no unexpected rewriting)
- [ ] No `original` field on turns (because nothing changed)

### Scenario 18.2 — Arabic Caller, STT Mis-Detection
**Prerequisites:** Assistant `supportedLanguages` = ["en", "ar"].
**Script:**
> Speak a few sentences in Arabic (e.g., "مرحبا، أريد حجز موعد غدا")

**Expected:**
- [ ] Raw transcript may contain garbled Korean/Hindi characters
- [ ] Cleaned transcript shows the intended Arabic text
- [ ] `original` field retains the garbled STT output for comparison
- [ ] AI analysis summary is still sensible English

### Scenario 18.3 — Mixed English + French
**Prerequisites:** supportedLanguages = ["en", "fr"].
**Script:**
> Greet in English, then switch to French mid-call.

**Expected:**
- [ ] Cleaned turns preserve the language each turn was actually spoken in
- [ ] No forced translation
- [ ] `language` field populated on each turn when detectable

### Scenario 18.4 — Very Short Call (<20 chars transcript)
**Script:**
> Pick up, say "wrong number", hang up.

**Expected:**
- [ ] `cleaned_transcript` is null (analysis skipped for short calls)
- [ ] Dashboard falls back to Raw view automatically

### Scenario 18.5 — Severe STT Garbage (Can't Recover)
**Script:**
> Whisper or mumble unintelligibly for 20+ seconds.

**Expected:**
- [ ] Post-call analysis either returns `cleaned_transcript: null` or best-effort garbage
- [ ] No server crash, no pipeline failure
- [ ] Dashboard degrades gracefully
```

- [ ] **Step 2: Commit**

```bash
git add docs/test-scenarios.md
git commit -m "docs(SCRUM-208): add cleaned transcript smoke tests"
```

---

## Task 17: Smoke test — Section 19 (Supported Languages)

- [ ] **Step 1: Append Section 19**

```markdown
---

## SECTION 19: Supported Languages Setting (SCRUM-209)

Verifies the Supported Languages multi-select affects: (1) AI response language, (2) system prompt hint, (3) post-call cleanup.

### Scenario 19.1 — Setting Is Empty + Multilingual Off
**Prerequisites:** supportedLanguages = [], multilingualEnabled = false.
**Script:**
> Greet in Spanish: "Hola, necesito una cita"

**Expected:**
- [ ] AI responds in English, offers to take a message
- [ ] System prompt contains English-only directive
- [ ] Cleaned transcript shows no recovery hint influence

### Scenario 19.2 — Setting = [en, ar]
**Script:**
> Greet in Arabic.

**Expected:**
- [ ] AI responds in Arabic
- [ ] System prompt contains "CALLER LANGUAGE HINT: en, ar"
- [ ] Post-call cleanup prefers Arabic recovery for garbled turns

### Scenario 19.3 — Setting = [en, fr, es]
**Script:**
> Greet in French, then in Spanish, then in English.

**Expected:**
- [ ] AI follows each language switch
- [ ] Cleaned transcript turns have `language` set to fr/es/en respectively
- [ ] System prompt enumerates all three

### Scenario 19.4 — Tooltip Copy
**Action:** Open assistant settings → hover the Supported Languages help icon.

**Expected:**
- [ ] Tooltip mentions all three effects: AI responses, prompt hint, post-call cleanup
- [ ] Matches the copy checked in under SCRUM-209

### Scenario 19.5 — No Regression When Multilingual Enabled But Empty List
**Prerequisites:** multilingualEnabled = true, supportedLanguages = [].
**Script:**
> Call in any language.

**Expected:**
- [ ] AI auto-detects and responds (existing behaviour preserved)
- [ ] No CALLER LANGUAGE HINT line in prompt (nothing to hint about)
- [ ] Post-call analysis runs without the language hint and still produces cleaned output
```

- [ ] **Step 2: Commit**

```bash
git add docs/test-scenarios.md
git commit -m "docs(SCRUM-209): add Supported Languages smoke tests"
```

---

## Task 18: Final verification

- [ ] **Step 1: Run the review pipeline**

```bash
cd /Users/michaelmakhoul/projects/phondo
npm run lint
npx tsc --noEmit
npx vitest run
cd voice-server && npm test && cd ..
```

Expected: zero errors. Fix anything that breaks before merging.

- [ ] **Step 2: Deploy voice server to Fly**

```bash
cd voice-server
fly deploy
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat: recording storage, cleaned transcript, supported languages" --body "..."
```

Include SCRUM-207, SCRUM-208, SCRUM-209 references.

---

## Notes / Gotchas

- **Telnyx webhook config is manual.** The recording webhook URL is set in the Telnyx Call Control Application, not via code. Document this in the runbook (SCRUM-191) so nobody forgets when provisioning new apps.
- **Legacy `calls.recording_url`** stays readable but new rows set it to null. Do NOT drop the column — older rows need it for historical context.
- **Telnyx callControlId vs Twilio CallSid mapping:** Task 8 Step 2 must verify these match. If they don't, the webhook lookup fails silently and no recording gets stored. Test explicitly during smoke tests.
- **Cost:** Supabase Storage billing is per-GB-month. At ~1MB per 5-minute call and typical SMB volumes (≤100 calls/month/customer), this is fractions of a cent per account. Not a launch blocker.
- **Retention:** Add a separate ticket later (SCRUM-2xx) for auto-purging recordings older than N days per org plan tier.
