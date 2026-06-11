import { after } from "next/server";

/**
 * Run a non-critical side effect AFTER the HTTP response is sent.
 *
 * Bare fire-and-forget (`promise.catch(...)`) is unsafe on Vercel: the function
 * instance is frozen once the response is flushed, so an unawaited promise can
 * be silently dropped before it runs (SCRUM-410 — this is how the flagship
 * missed-call text-back and customer webhooks could vanish intermittently).
 * `after()` keeps the invocation alive until the callback settles.
 *
 * Falls back to a guarded background promise when called outside a request
 * scope (e.g. unit tests, or any future non-request caller), so library code
 * that uses this stays testable and never throws.
 *
 * Pass a `work` function that does its own error handling; this wrapper only
 * guarantees the work is scheduled and that a rejection can never escape.
 */
export function runAfterResponse(work: () => Promise<unknown>): void {
  try {
    after(work);
  } catch {
    // Not in a request scope — best-effort background execution.
    void Promise.resolve().then(work).catch(() => {});
  }
}
