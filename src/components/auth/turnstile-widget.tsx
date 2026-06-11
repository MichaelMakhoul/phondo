"use client";

// SCRUM-436: minimal Cloudflare Turnstile wrapper (no third-party React dep).
// Renders nothing when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, so the auth
// forms behave exactly as before until CAPTCHA is rolled out.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils/cn";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  // Cloudflare types render() as string | undefined (undefined on invalid
  // container), and reset()/remove() THROW on stale widget ids — hence the
  // truthy guards and try/catch below.
  render: (el: HTMLElement, opts: Record<string, unknown>) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        // Clear the cached promise so a remount can retry the load.
        scriptPromise = null;
        reject(new Error("Failed to load the Turnstile script"));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Tokens are single-use — call after every auth attempt (success or failure). */
  reset: () => void;
}

interface TurnstileWidgetProps {
  /** Receives the fresh token, or null when it expires/errors/resets. */
  onToken: (token: string | null) => void;
  /**
   * Fired when the widget terminally fails (script blocked by an adblocker/
   * firewall, render threw, or a challenge error). Callers should stop showing
   * "please wait" and let the submit reach Supabase, whose server-side
   * captcha_failed rejection is the real control.
   */
  onError?: () => void;
  className?: string;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ onToken, onError, className }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    // Keep the latest callbacks without re-rendering the widget on each render.
    const onTokenRef = useRef(onToken);
    onTokenRef.current = onToken;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    useImperativeHandle(ref, () => ({
      reset() {
        if (widgetIdRef.current) {
          try {
            window.turnstile?.reset(widgetIdRef.current);
          } catch {
            // reset() throws on a stale id (widget torn down internally). The
            // token is nulled below either way; a page handler must never have
            // its control flow broken by this (it would strand isLoading=true).
          }
        }
        onTokenRef.current(null);
      },
    }));

    useEffect(() => {
      if (!TURNSTILE_SITE_KEY) return;
      let cancelled = false;

      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          widgetIdRef.current =
            window.turnstile.render(containerRef.current, {
              sitekey: TURNSTILE_SITE_KEY,
              theme: "auto",
              callback: (token: string) => onTokenRef.current(token),
              "expired-callback": () => onTokenRef.current(null),
              "error-callback": () => {
                onTokenRef.current(null);
                onErrorRef.current?.();
              },
            }) ?? null;
        })
        .catch(() => {
          // Script blocked or render threw. Report it so the pages can skip
          // their "please wait for the security check" gate — otherwise the
          // user is soft-locked on a wait that will never end. The submit then
          // proceeds without a token and Supabase's captcha_failed rejection
          // (the real, server-side control) is surfaced with clear guidance.
          if (!cancelled) onErrorRef.current?.();
        });

      return () => {
        cancelled = true;
        if (widgetIdRef.current) {
          try {
            window.turnstile?.remove(widgetIdRef.current);
          } catch {
            // remove() throws on an already-removed id; never break React's
            // unmount path over widget teardown.
          }
          widgetIdRef.current = null;
        }
      };
    }, []);

    if (!TURNSTILE_SITE_KEY) return null;
    // Reserve the managed widget's ~65px height so the submit button doesn't
    // jump when the challenge renders ~1s after page load.
    return <div ref={containerRef} className={cn("min-h-[65px]", className)} />;
  }
);
