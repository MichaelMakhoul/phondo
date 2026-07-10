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
import { Copy, Check, PhoneCall, Smartphone } from "lucide-react";
import { getCarriersForCountry } from "@/lib/country-config";
import { formatPhoneNumber } from "@/lib/utils";
import {
  buildForwardingCodes,
  resolveForwardingCountry,
  telHref,
  FORWARDING_MODE_LABELS,
  type ForwardingMode,
} from "@/lib/country-config/forwarding";
import { DialCodeQr } from "./dial-code-qr";

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
 * The carrier is deliberately NOT defaulted. "Other" carries the codes most
 * networks share, but Vodafone AU documents the double-star form (`**21*`)
 * where that shared set uses `*21*`. A Vodafone customer who never opened the
 * picker would be handed a code their network rejects and — with no verify step
 * on this screen — would not find out until a caller went unanswered.
 */
export function ForwardingInstructions({
  destinationPhone,
  countryCode,
  className,
}: ForwardingInstructionsProps) {
  const { toast } = useToast();
  const [carrierId, setCarrierId] = useState("");
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // The number's own calling code beats the passed country, which both call
  // sites default to "US". Showing an Australian number Verizon's codes would
  // be silently, confidently wrong.
  const country = resolveForwardingCountry(destinationPhone, countryCode);
  const carriers = country ? getCarriersForCountry(country) : [];
  const carrier = carriers.find((c) => c.id === carrierId);

  // No country means no dialing rules we can vouch for. Show nothing rather
  // than another country's codes.
  if (!country || carriers.length === 0 || !destinationPhone) return null;

  const formattedDestination = formatPhoneNumber(destinationPhone, country);

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

  /**
   * One dial code. The `tel:` link pre-fills the handset's dialer; it does not
   * place the call, and no phone auto-sends an MMI code from a link. It is
   * hidden above the mobile breakpoint because tapping it on a laptop would
   * dial the laptop, not the phone being forwarded.
   */
  const renderCodeRow = (label: string, code: string, subdued = false) => {
    const href = telHref(code);
    return (
      <div className="space-y-1.5">
        {/* SCRUM-529: on a desktop the Dial button can't exist — the QR is
            how the code reaches the handset without hand-transcription. */}
        {!subdued && (
          <div className="hidden items-center gap-3 sm:flex">
            <DialCodeQr code={code} className="h-24 w-24 shrink-0 rounded border" />
            <p className="text-xs text-muted-foreground">
              Scan with the phone you want forwarded — the dialer opens with this code
              entered, then press call.
            </p>
          </div>
        )}
        <Label
          className={`text-xs font-medium ${subdued ? "text-muted-foreground/80" : "text-muted-foreground"}`}
        >
          {label}
        </Label>
        <div className="flex items-center gap-2">
          <code
            className={`flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono ${
              subdued ? "text-xs text-muted-foreground" : "text-sm"
            }`}
          >
            {code}
          </code>
          {href && (
            <Button
              asChild
              variant={subdued ? "ghost" : "default"}
              size="sm"
              className="h-8 shrink-0 sm:hidden"
            >
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
    if (!carrier) return null;
    const codes = buildForwardingCodes(carrier, mode, destinationPhone, country);
    // Unreachable while `country` is non-null and the destination is E.164, but
    // the code we would otherwise print is one that silently dials nowhere.
    if (!codes) return null;
    const { enable, disable, note } = codes;
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{FORWARDING_MODE_LABELS[mode].blurb}</p>

        {/* The destination is buried inside the code string. Show it plainly so
            the owner can check where calls will land before dialing anything. */}
        <p className="text-xs text-muted-foreground">
          Forwards calls to{" "}
          <span className="font-medium text-foreground">{formattedDestination}</span>
        </p>

        {renderCodeRow("On the phone you want forwarded, dial:", enable)}

        {mode === "unconditional" && (
          <div className="rounded-md bg-blue-50 p-3 text-xs text-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
            <p className="font-medium">Before you forward every call</p>
            <p className="mt-1">
              When a caller asks for a person, your AI transfers them back to this same
              phone, which forwards straight back to the AI. Either choose &quot;
              {FORWARDING_MODE_LABELS.conditional.title}&quot; instead, or set a different
              transfer destination in Settings first.
            </p>
          </div>
        )}

        {/* Kept visible — an owner evaluating us wants to see the way out before
            they commit — but subordinated, so a hurried one does not dial it. */}
        <div className="rounded-md border border-dashed p-3">
          {renderCodeRow("Need to undo this later? Dial:", disable, true)}
        </div>

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
          <p className="text-xs text-muted-foreground">
            Codes differ by network, so pick yours. Not sure? Choose &quot;Other&quot; for the
            codes most carriers share.
          </p>
        </div>

        {!carrier ? (
          <p className="rounded-md bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground">
            Choose your carrier above to see your forwarding code.
          </p>
        ) : (
          <>
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

            {/* The Dial button exists only on a handset. On a laptop the code has
                to reach the phone somehow, and saying so beats a Copy button that
                quietly copies to the wrong device. */}
            <div className="flex gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                Dial the code on the phone you are forwarding, not on this computer. If that
                line runs through a hosted phone system or VoIP provider, set forwarding in
                their portal instead.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
