/**
 * SCRUM-341: concurrency caps for the PAID /ws/test Gemini Live path.
 *
 * Each test/demo session is a billable Gemini Live call, so concurrent sessions
 * are bounded three ways: globally, per-IP, and per-token (single-use jti).
 * The voice server is a single long-running process (one Fly machine), so an
 * in-memory store is authoritative here — no distributed store needed (unlike
 * the serverless Next.js routes, which use Postgres/Upstash).
 *
 * Extracted from server.js so the reserve/release accounting is unit-testable.
 */

/**
 * Resolve the true client IP for per-IP capping.
 * Fly.io sets `Fly-Client-IP` to the edge-observed client IP and overwrites any
 * client-supplied value, so it is the authoritative, untaintable source in
 * production. The `x-forwarded-for` fallback is best-effort for local / non-Fly
 * runs only (caps aren't security-critical there) — note that on Fly this
 * branch is never reached, so its hop-ordering doesn't matter in production.
 */
function getTestClientIp(req) {
  const flyIp = req.headers["fly-client-ip"];
  if (flyIp) return flyIp;
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",").pop().trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/**
 * Create an in-memory concurrency-cap tracker.
 * @param {{maxGlobal:number, maxPerIp:number}} opts
 */
function createTestSessionCaps({ maxGlobal, maxPerIp }) {
  const activeJtis = new Set(); // jti currently running a session (single-use)
  const byIp = new Map(); // ip -> active session count
  let globalCount = 0;

  /**
   * Try to reserve a session slot. Pure synchronous check-and-reserve (no await),
   * which is what makes it race-free on Node's single-threaded loop.
   * @returns {{ok:true}} on success (slot reserved), or {{ok:false, reason}}.
   */
  function tryReserve(jti, ip) {
    if (globalCount >= maxGlobal) return { ok: false, reason: "global" };
    const ipCount = byIp.get(ip) || 0;
    if (ipCount >= maxPerIp) return { ok: false, reason: "per-ip" };
    if (jti && activeJtis.has(jti)) return { ok: false, reason: "jti-reuse" };

    if (jti) activeJtis.add(jti);
    byIp.set(ip, ipCount + 1);
    globalCount += 1;
    return { ok: true };
  }

  /**
   * Release a previously-reserved slot. NOT idempotent — the caller must guard
   * against double-release (a per-connection boolean). Floors prevent underflow
   * if a stray release ever slips through.
   */
  function release(jti, ip) {
    if (jti) activeJtis.delete(jti);
    const remaining = (byIp.get(ip) || 1) - 1;
    if (remaining <= 0) byIp.delete(ip);
    else byIp.set(ip, remaining);
    globalCount = Math.max(0, globalCount - 1);
  }

  function stats() {
    return { global: globalCount, ips: byIp.size, jtis: activeJtis.size };
  }

  return { tryReserve, release, stats };
}

module.exports = { getTestClientIp, createTestSessionCaps };
