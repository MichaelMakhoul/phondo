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
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-lg rounded-lg border bg-background p-4 shadow-lg md:left-auto md:right-4">
      <p className="text-sm text-muted-foreground">
        We use analytics cookies to understand how you use our product and
        improve your experience.
      </p>
      <div className="mt-3 flex gap-2">
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
  );
}
