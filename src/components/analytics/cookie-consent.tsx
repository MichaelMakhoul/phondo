"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { getStoredConsent, setConsent } from "@/lib/analytics";

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (getStoredConsent() === null) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    /* SCRUM-570: on mobile this is a slim full-width bar pinned to the viewport
       bottom edge — the old floating card (bottom-4, stacked buttons) covered
       the /demo CTA zone on first paint for ads visitors. Desktop keeps the
       floating-card treatment via md: variants. Layout only: the consent
       semantics (default DENIED until Accept) are unchanged. */
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 p-3 shadow-lg backdrop-blur md:bottom-4 md:left-auto md:right-4 md:max-w-lg md:rounded-lg md:border md:p-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs text-muted-foreground md:text-sm">
          We use analytics cookies to understand how you use our product and
          improve your experience.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setConsent(false);
              setVisible(false);
            }}
          >
            Decline
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setConsent(true);
              setVisible(false);
            }}
          >
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
