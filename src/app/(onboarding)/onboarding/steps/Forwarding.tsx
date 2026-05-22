"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { getCountryConfig } from "@/lib/country-config";
import { parsePhoneToE164, type SupportedCountry } from "@/lib/phone/normalize";
import { PhoneForwarded, ShieldAlert } from "lucide-react";

interface ForwardingProps {
  data: {
    transferNumber: string;
    fallbackForwardNumber: string;
  };
  countryCode: string;
  onChange: (updates: Partial<{ transferNumber: string; fallbackForwardNumber: string }>) => void;
}

/**
 * Onboarding Phase 2 (SCRUM-284) — capture where calls go when the AI can't
 * handle them. Two destinations:
 *   - Mid-call transfer: caller asks for a human during a call.
 *   - Emergency fallback: the AI is paused (kill switch) — calls forward here.
 * Both are optional; the wizard allows skipping. The transfer number becomes a
 * transfer_rule on continue; the fallback is applied to the phone number once
 * it's provisioned at Go Live (see onboarding/page.tsx handleNext/handleComplete).
 */
export function Forwarding({ data, countryCode, onChange }: ForwardingProps) {
  const config = getCountryConfig(countryCode);
  const placeholder = config?.phone.placeholder || "+1 (555) 123-4567";
  const country: SupportedCountry = countryCode === "US" ? "US" : "AU";

  const sameAsTransfer =
    data.fallbackForwardNumber.trim() !== "" &&
    data.fallbackForwardNumber.trim() === data.transferNumber.trim();

  const transferInvalid =
    data.transferNumber.trim() !== "" && !parsePhoneToE164(data.transferNumber, country);
  const fallbackInvalid =
    data.fallbackForwardNumber.trim() !== "" && !parsePhoneToE164(data.fallbackForwardNumber, country);

  const handleSameToggle = (checked: boolean) => {
    onChange({ fallbackForwardNumber: checked ? data.transferNumber : "" });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Forwarding</h2>
        <p className="text-muted-foreground">
          Where should calls go when the AI can&apos;t handle them? Both are optional — you can set
          these up any time later from Settings.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Mid-call transfer */}
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <PhoneForwarded className="h-5 w-5 text-primary" />
            <Label htmlFor="transferNumber" className="text-base font-medium">
              Mid-call transfer
            </Label>
          </div>
          <p className="text-sm text-muted-foreground">
            When a caller asks to speak to a person mid-call (e.g. &quot;can I talk to someone?&quot;),
            the AI connects them to this number.
          </p>
          <Input
            id="transferNumber"
            type="tel"
            inputMode="tel"
            placeholder={placeholder}
            value={data.transferNumber}
            onChange={(e) => {
              const next = e.target.value;
              onChange(
                sameAsTransfer
                  ? { transferNumber: next, fallbackForwardNumber: next }
                  : { transferNumber: next }
              );
            }}
            className={transferInvalid ? "border-destructive" : ""}
            aria-invalid={transferInvalid}
          />
          {transferInvalid && (
            <p className="text-xs text-destructive">
              Enter a valid {country} number in international format (e.g. {country === "US" ? "+14155551234" : "+61412345678"}).
            </p>
          )}
        </div>

        {/* Emergency fallback */}
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            <Label htmlFor="fallbackForwardNumber" className="text-base font-medium">
              Emergency fallback
            </Label>
          </div>
          <p className="text-sm text-muted-foreground">
            If you pause the AI (kill switch), incoming calls forward straight to this number instead.
          </p>
          <div className="flex items-center gap-2">
            <Checkbox
              id="sameAsTransfer"
              checked={sameAsTransfer}
              onCheckedChange={(c) => handleSameToggle(c === true)}
              disabled={!data.transferNumber.trim()}
            />
            <Label htmlFor="sameAsTransfer" className="text-sm font-normal text-muted-foreground">
              Use the same as mid-call transfer
            </Label>
          </div>
          <Input
            id="fallbackForwardNumber"
            type="tel"
            inputMode="tel"
            placeholder={placeholder}
            value={data.fallbackForwardNumber}
            onChange={(e) => onChange({ fallbackForwardNumber: e.target.value })}
            disabled={sameAsTransfer}
            className={fallbackInvalid ? "border-destructive" : ""}
            aria-invalid={fallbackInvalid}
          />
          {fallbackInvalid && (
            <p className="text-xs text-destructive">
              Enter a valid {country} number in international format (e.g. {country === "US" ? "+14155551234" : "+61412345678"}).
            </p>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Leave both blank to skip for now — your AI will take a message when it can&apos;t help, and
        you can add forwarding later from Settings.
      </p>
    </div>
  );
}
