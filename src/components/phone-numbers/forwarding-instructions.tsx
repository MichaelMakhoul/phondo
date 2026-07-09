"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { Copy, Check, PhoneCall } from "lucide-react";
import { getCarriersForCountry } from "@/lib/country-config";
import {
  buildForwardingCodes,
  telHref,
  FORWARDING_MODE_LABELS,
  type ForwardingMode,
} from "@/lib/country-config/forwarding";

interface ForwardingInstructionsProps {
  /** The Phondo number calls should land on, in E.164 ("+61285551234"). */
  destinationPhone: string;
  countryCode: string;
  className?: string;
}

/**
 * SCRUM-516: the carrier codes a business owner dials to point their existing
 * line at their AI receptionist.
 *
 * Shown on the "You're Live!" screen and in the phone-numbers forwarding
 * dialog. Until now the success screen said "redirect your existing line to
 * this number" and left the owner to work out how, which is the single step
 * between finishing setup and the product doing anything at all.
 *
 * The carrier defaults to "Other", whose codes are the ones most networks
 * share, so the card is useful before the owner touches the picker.
 */
export function ForwardingInstructions({
  destinationPhone,
  countryCode,
  className,
}: ForwardingInstructionsProps) {
  const { toast } = useToast();
  const carriers = getCarriersForCountry(countryCode);
  // "Other" carries the widely-shared codes, so it is the safest default.
  const fallbackCarrierId = carriers.find((c) => c.id === "other")?.id ?? carriers[0]?.id ?? "";
  const [carrierId, setCarrierId] = useState(fallbackCarrierId);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const carrier = carriers.find((c) => c.id === carrierId) ?? carriers[0];

  // A country with no carrier table would render an empty, confusing card.
  if (!carrier || !destinationPhone) return null;

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
      setTimeout(() => setCopiedText(null), 2000);
    } catch {
      toast({
        variant: "destructive",
        title: "Copy failed",
        description: "Please type the code into your dialer manually.",
      });
    }
  };

  const renderCodeRow = (label: string, code: string) => {
    const href = telHref(code);
    return (
      <div className="space-y-1.5">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
            {code}
          </code>
          {href && (
            <Button asChild variant="default" size="sm" className="h-8 shrink-0 sm:hidden">
              <a href={href} aria-label={`Dial ${code}`}>
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                Dial
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={`Copy ${code}`}
            onClick={() => handleCopy(code)}
          >
            {copiedText === code ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    );
  };

  const renderMode = (mode: ForwardingMode) => {
    const { enable, disable, note } = buildForwardingCodes(
      carrier,
      mode,
      destinationPhone,
      countryCode
    );
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{FORWARDING_MODE_LABELS[mode].blurb}</p>
        {renderCodeRow("To turn forwarding on, dial:", enable)}
        {renderCodeRow("To turn it off again later:", disable)}
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    );
  };

  return (
    <div className={className}>
      <div className="space-y-4 rounded-lg border p-4 text-left">
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">Send your existing line to your AI receptionist</h3>
          <p className="text-xs text-muted-foreground">
            Dial one short code from the phone you want forwarded. It takes a few seconds and
            you can undo it any time.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="forwarding-carrier" className="text-xs font-medium text-muted-foreground">
            Your phone carrier
          </Label>
          <Select value={carrierId} onValueChange={setCarrierId}>
            <SelectTrigger id="forwarding-carrier">
              <SelectValue placeholder="Select your carrier" />
            </SelectTrigger>
            <SelectContent>
              {carriers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs defaultValue="conditional">
          <TabsList className="w-full">
            <TabsTrigger value="conditional" className="flex-1">
              {FORWARDING_MODE_LABELS.conditional.title}
            </TabsTrigger>
            <TabsTrigger value="unconditional" className="flex-1">
              {FORWARDING_MODE_LABELS.unconditional.title}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="conditional" className="mt-3">
            {renderMode("conditional")}
          </TabsContent>
          <TabsContent value="unconditional" className="mt-3">
            {renderMode("unconditional")}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
