"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ForwardingInstructions } from "./forwarding-instructions";
import { forwardingDestinations, resolveForwardingCountry } from "@/lib/country-config/forwarding";
import { formatPhoneNumber } from "@/lib/utils";
import type { PhoneNumber } from "@/types/phone-number";

interface ForwardingGuideSectionProps {
  phoneNumbers: PhoneNumber[];
  countryCode: string;
}

/**
 * SCRUM-536: the forwarding guide, permanently on /phone-numbers.
 *
 * Before this, the dial codes appeared exactly twice: once on the You're-Live
 * onboarding screen (unreachable afterwards) and once inside the "Add Number >
 * Use My Existing Number" wizard — a place nobody who already owns a number
 * would look. A customer who changed carrier, got a new handset, or wants to
 * turn forwarding OFF (holidays, cancellation) had nowhere to find the code.
 * The disable code matters as much as the enable code, and it only ever lived
 * inside that wizard.
 */
export function ForwardingGuideSection({ phoneNumbers, countryCode }: ForwardingGuideSectionProps) {
  // Hooks before any early return.
  const [selectedId, setSelectedId] = useState("");

  const destinations = forwardingDestinations(phoneNumbers, countryCode);
  if (destinations.length === 0) return null;

  const selected = destinations.find((d) => d.id === selectedId) ?? destinations[0];

  const labelFor = (n: PhoneNumber) => {
    // Per-number country from the number's own "+" prefix — the org-level
    // countryCode can silently be a defaulted "US" (SCRUM-528).
    const country = resolveForwardingCountry(n.phone_number, countryCode) ?? countryCode;
    const formatted = formatPhoneNumber(n.phone_number, country);
    return n.friendly_name ? `${n.friendly_name} (${formatted})` : formatted;
  };

  return (
    // scroll-mt keeps the heading clear of any sticky chrome when the
    // number card's "View Forwarding Instructions" item scrolls here.
    <div id="forwarding-guide" className="max-w-xl scroll-mt-20 space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Call forwarding</h2>
        <p className="text-sm text-muted-foreground">
          Point your existing business line at your AI receptionist, or switch it back off.
          Keep this page handy: you will need it again if you change carrier or phone.
        </p>
      </div>

      {destinations.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="forwarding-destination" className="text-xs font-medium text-muted-foreground">
            Forward to
          </Label>
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger id="forwarding-destination">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {labelFor(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <ForwardingInstructions destinationPhone={selected.phone_number} countryCode={countryCode} />
    </div>
  );
}
