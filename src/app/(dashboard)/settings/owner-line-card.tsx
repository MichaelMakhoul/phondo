"use client";

import { useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Smartphone } from "lucide-react";
import type { SupportedCountry } from "@/lib/phone/normalize";
import { formatPhoneNumber } from "@/lib/utils";
// Client component: only dependency-free modules (line-form imports just
// pin-rules and the phone normaliser), never ../pin (Node crypto).
import {
  PIN_CONFIRM_ONLY_MESSAGE,
  PIN_RULE_TEXT,
  buildSaveBody,
  phoneExampleFor,
  serverErrorMessage,
  validateOwnerLineForm,
  type OwnerLineErrors,
} from "@/lib/owner-assistant/line-form";

export interface OwnerLineInitial {
  configured: boolean;
  phoneE164: string | null;
  pinLength: number | null;
  enabled: boolean;
}

interface OwnerLineCardProps {
  country: SupportedCountry;
  /** The org's Phondo number (E.164) for the save-as-a-contact hint; null until one is provisioned. */
  phondoNumber: string | null;
  initial: OwnerLineInitial;
}

const EXAMPLE_ASKS = ["What's on tomorrow?", "Any messages?", "Move the 2pm to Thursday."];

const NETWORK_ERROR = "Couldn't reach Phondo. Check your connection and try again.";

/** Only the message: the request body holds the PIN and must never reach a log. */
function logRequestFailure(action: string, err: unknown) {
  console.error(`[OwnerLineCard] ${action} request failed:`, err instanceof Error ? err.message : "non-Error thrown");
}

/**
 * Settings → "Your assistant line" (SCRUM-585, spec §6). Registers the mobile
 * the owner rings from and a 4–8 digit PIN. The PIN is write-only: the server
 * stores a hash and this card never shows it again. Validation lives in
 * @/lib/owner-assistant/line-form so it can be unit-tested.
 *
 * The PIN inputs deliberately have no maxLength: a browser would silently cut a
 * pasted 9+ digit PIN down to a valid-looking 8-digit one the owner never
 * chose. The value is kept whole and validateOwnerLineForm rejects it with the
 * format error on Save.
 */
export function OwnerLineCard({ country, phondoNumber, initial }: OwnerLineCardProps) {
  const [configured, setConfigured] = useState(initial.configured);
  const [phone, setPhone] = useState(initial.phoneE164 ?? "");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [enabled, setEnabled] = useState(initial.enabled);
  // What the server holds, so a toggle that has not been saved yet says so.
  const [savedEnabled, setSavedEnabled] = useState(initial.enabled);
  const [pinLength, setPinLength] = useState(initial.pinLength);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [errors, setErrors] = useState<OwnerLineErrors>({});
  const { toast } = useToast();

  const busy = saving || removing;
  const phoneExample = phoneExampleFor(country);
  const pinHint =
    configured && pinLength
      ? `A ${pinLength}-digit PIN is set. It's never shown; enter a new one to reset it.`
      : "You can key it in or say it when you call.";

  const handleSave = async () => {
    const found = validateOwnerLineForm({ phone, pin, pinConfirm }, { country, configured });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/v1/owner-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSaveBody({ phone, pin, enabled })),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast({
          variant: "destructive",
          title: "Error",
          description: serverErrorMessage(data, "Failed to save settings. Please try again."),
        });
        return;
      }
      const pinChanged = pin.length > 0;
      const nowEnabled: boolean = data?.enabled ?? enabled;
      setConfigured(true);
      setPhone(data?.phoneE164 ?? phone);
      setPinLength(data?.pinLength ?? pinLength);
      setEnabled(nowEnabled);
      setSavedEnabled(nowEnabled);
      setPin("");
      setPinConfirm("");
      toast({
        title: "Assistant line saved",
        description: pinChanged
          ? "Your PIN is set. It's never shown again — reset it here if you forget it."
          : "Your assistant line has been updated.",
      });
    } catch (err) {
      logRequestFailure("save", err);
      toast({ variant: "destructive", title: "Error", description: NETWORK_ERROR });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch("/api/v1/owner-access", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast({
          variant: "destructive",
          title: "Error",
          description: serverErrorMessage(data, "Failed to remove the assistant line. Please try again."),
        });
        return;
      }
      setConfigured(false);
      setPhone("");
      setPin("");
      setPinConfirm("");
      setPinLength(null);
      setEnabled(true);
      setSavedEnabled(true);
      setErrors({});
      setRemoveOpen(false);
      toast({
        title: "Assistant line removed",
        description: "Calls from your mobile now reach the receptionist like any other caller.",
      });
    } catch (err) {
      logRequestFailure("remove", err);
      toast({ variant: "destructive", title: "Error", description: NETWORK_ERROR });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5" />
          Your assistant line
        </CardTitle>
        <CardDescription>
          Ring your own Phondo number from this mobile, enter your PIN, and your receptionist becomes your assistant.
          Customers who call never see this step.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!configured && (
          <p className="text-sm">
            <span className="font-medium">Not set up yet.</span>{" "}
            <span className="text-muted-foreground">
              Add the mobile you&apos;ll ring from and choose a PIN to turn it on.
            </span>
          </p>
        )}

        <div className="rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">Things you can ask</p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {EXAMPLE_ASKS.map((ask) => (
              <li key={ask}>&ldquo;{ask}&rdquo;</li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <Label htmlFor="owner-line-phone">Your mobile number</Label>
          <Input
            id="owner-line-phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setErrors((prev) => ({ ...prev, phone: undefined }));
            }}
            placeholder={phoneExample}
            className={errors.phone ? "border-destructive" : ""}
            aria-invalid={Boolean(errors.phone)}
            aria-describedby="owner-line-phone-message"
            disabled={busy}
          />
          <p
            id="owner-line-phone-message"
            className={errors.phone ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {errors.phone ??
              "Only calls from this number get the PIN prompt. Everyone else reaches the receptionist as usual."}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="owner-line-pin">{configured ? "New PIN" : "PIN"}</Label>
            <Input
              id="owner-line-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setErrors((prev) => ({ ...prev, pin: undefined, pinConfirm: undefined }));
              }}
              placeholder={configured ? "Leave blank to keep your current PIN" : PIN_RULE_TEXT}
              className={errors.pin ? "border-destructive" : ""}
              aria-invalid={Boolean(errors.pin)}
              aria-describedby="owner-line-pin-message"
              disabled={busy}
            />
            <p
              id="owner-line-pin-message"
              className={errors.pin ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {errors.pin ?? pinHint}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="owner-line-pin-confirm">Confirm PIN</Label>
            <Input
              id="owner-line-pin-confirm"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              value={pinConfirm}
              onChange={(e) => {
                setPinConfirm(e.target.value);
                setErrors((prev) => ({
                  ...prev,
                  pinConfirm: undefined,
                  // "Confirm without a PIN" is shown on the PIN field but cured from here.
                  pin: prev.pin === PIN_CONFIRM_ONLY_MESSAGE ? undefined : prev.pin,
                }));
              }}
              placeholder={configured ? "Only if you entered a new PIN" : "Enter it again"}
              className={errors.pinConfirm ? "border-destructive" : ""}
              aria-invalid={Boolean(errors.pinConfirm)}
              aria-describedby={errors.pinConfirm ? "owner-line-pin-confirm-message" : undefined}
              disabled={busy}
            />
            {errors.pinConfirm && (
              <p id="owner-line-pin-confirm-message" className="text-xs text-destructive">
                {errors.pinConfirm}
              </p>
            )}
          </div>
        </div>

        {configured && (
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="owner-line-enabled" className="font-medium">
                {enabled ? "Assistant line is on" : "Assistant line is paused"}
              </Label>
              <p id="owner-line-enabled-help" className="text-xs text-muted-foreground">
                Paused keeps your number and PIN but skips the PIN prompt until you turn it back on.
              </p>
              {enabled !== savedEnabled && (
                <p className="text-xs font-medium">Not applied yet — click Save changes.</p>
              )}
            </div>
            <Switch
              id="owner-line-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-describedby="owner-line-enabled-help"
              disabled={busy}
            />
          </div>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Calls to your assistant follow your call-recording setting, like every other call.</p>
          {phondoNumber && (
            <p>
              Save <span className="font-medium text-foreground">{formatPhoneNumber(phondoNumber, country)}</span> as a
              contact so your phone&apos;s call screening doesn&apos;t answer it.
            </p>
          )}
          <p>
            It only works from the mobile above. After too many wrong PINs the line locks and we email you — saving a
            new PIN unlocks it.
          </p>
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {configured && (
            <Dialog
              open={removeOpen}
              onOpenChange={(open) => {
                // A removal in flight can't be dismissed: the outcome would arrive unseen.
                if (!removing) setRemoveOpen(open);
              }}
            >
              <DialogTrigger asChild>
                <Button variant="outline" disabled={busy}>Remove assistant line</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Remove your assistant line?</DialogTitle>
                  <DialogDescription>
                    Your registered mobile and PIN are deleted. Calls from your mobile will reach the receptionist
                    like any other caller. You can set it up again any time.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setRemoveOpen(false)} disabled={removing}>Cancel</Button>
                  <Button variant="destructive" onClick={handleRemove} disabled={removing}>
                    {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Remove
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
          <Button className="sm:ml-auto" onClick={handleSave} disabled={busy}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {configured ? "Save changes" : "Set up assistant line"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
