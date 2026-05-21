import { after } from "next/server";

/**
 * Direct Grafana Cloud Loki HTTP push for the Next.js app (SCRUM-323).
 *
 * Vercel "Drains" (the platform log-forwarding feature) require a Pro plan
 * and this project is on Hobby, so `pageSentry`'s structured `[ALERT:*]`
 * lines never reach Loki via a drain. Instead we push them straight to
 * Loki's HTTP API from the request path — works on any plan and keeps the
 * data AU-resident in Grafana Cloud (matching the voice-server's posture).
 *
 * Contract: this is a best-effort, fire-and-forget side channel. It must
 * NEVER throw and NEVER block the caller (same rule as the pageSentry Sentry
 * shim). It is dormant unless all three `LOKI_*` env vars are set, so it is a
 * no-op in dev/CI and until the owner configures the credentials in Vercel.
 */

const PUSH_TIMEOUT_MS = 3000;

interface LokiConfig {
  url: string;
  /** Pre-encoded `base64(username:token)` for the Basic auth header. */
  auth: string;
}

/**
 * Loki stream labels. Deliberately a small CLOSED set — labels are indexed,
 * so high-cardinality values (callSid, orgId, …) must stay in the log LINE,
 * never here. Parity with the voice-server's `{fly_app_name, level}` scheme.
 */
export type LokiLabels = { service_name: string; level: "warning" | "error" };

/**
 * Resolve Loki credentials from the environment. Returns null (→ no-op) unless
 * the push URL, username (Grafana Cloud instance/user ID) and API token are
 * ALL present, mirroring the Sentry `enabled: !!DSN` enable-by-env pattern.
 */
function lokiConfig(): LokiConfig | null {
  const url = process.env.LOKI_PUSH_URL;
  const username = process.env.LOKI_USERNAME;
  const token = process.env.LOKI_API_TOKEN;
  // Dormant unless ALL three are set. A partial config (e.g. URL + username
  // but no token) stays silently dormant — deliberately UNLIKE the keep-alive
  // cron's XOR-as-failure stance, because the [ALERT] line is already on the
  // console regardless, so a missed push degrades alert routing, not the
  // record itself. Activation is verified by watching for the line in Grafana.
  if (!url || !username || !token) return null;
  return {
    url,
    auth: Buffer.from(`${username}:${token}`).toString("base64"),
  };
}

/**
 * POST a single log line to Loki as a one-entry stream. Never rejects — all
 * failures (non-2xx, network, timeout/abort) are swallowed to a console
 * breadcrumb so on-call still has a local trail when ingestion is down.
 */
async function postToLoki(
  cfg: LokiConfig,
  line: string,
  labels: LokiLabels,
): Promise<void> {
  // Loki wants the timestamp as a nanosecond string; ms × 1e6 = ns.
  const body = JSON.stringify({
    streams: [{ stream: labels, values: [[`${Date.now()}000000`, line]] }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${cfg.auth}`,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // Include the (truncated) body — Loki puts the reason here (bad token,
      // "entry out of order", invalid label), which makes first-time
      // activation debugging far quicker. The body never contains our token.
      const detail = await res.text().catch(() => "");
      console.error(
        `[loki-push] non-2xx (${res.status}) — alert line not ingested: ${detail.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(
      "[loki-push] push failed (continuing):",
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ship a structured `[ALERT]` line to Loki. Synchronous + fire-and-forget.
 *
 * Prefers Next's `after()` so the request isn't blocked but the push still
 * survives past the response on Vercel (a bare unawaited fetch can be frozen
 * when the function suspends). Outside a request scope (scripts, tests)
 * `after()` throws — we fall back to an unawaited call, which `postToLoki`
 * keeps safe by never rejecting.
 */
export function pushToLoki(line: string, labels: LokiLabels): void {
  const cfg = lokiConfig();
  if (!cfg) return;

  const task = () => postToLoki(cfg, line, labels);
  try {
    after(task);
  } catch {
    void task();
  }
}
