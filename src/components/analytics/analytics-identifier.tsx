"use client";

import { useEffect, useRef } from "react";
import { identifyUser } from "@/lib/analytics";
import type { UserIdentityParams } from "@/lib/analytics/user-properties";

export function AnalyticsIdentifier(props: UserIdentityParams) {
  const identified = useRef(false);

  useEffect(() => {
    if (identified.current) return;
    identified.current = true;
    identifyUser(props).catch(() => {
      // Swallowed — identifyUser already logs internally
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
