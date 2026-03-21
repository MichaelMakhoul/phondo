"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { Phone, MoreVertical, Bot, PhoneForwarded, AlertCircle, Loader2 } from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";
import {
  getCountryConfig,
  formatInstructions,
  type CarrierInfo,
} from "@/lib/country-config";
import { trackAiToggleChanged } from "@/lib/analytics";

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  source_type: "purchased" | "forwarded";
  user_phone_number: string | null;
  forwarding_status: "pending_setup" | "active" | "paused" | null;
  carrier: string | null;
  assistants: { id: string; name: string } | null;
}

interface Assistant {
  id: string;
  name: string;
}

interface PhoneNumberCardProps {
  phoneNumber: PhoneNumber;
  countryCode: string;
  assistants?: Assistant[];
}

function findCarrierInfo(carrier: string | null, countryCode: string): CarrierInfo | null {
  if (!carrier) return null;
  const config = getCountryConfig(countryCode);
  return config.carriers.find((c: CarrierInfo) => c.id === carrier) || null;
}

export function PhoneNumberCard({ phoneNumber, countryCode, assistants = [] }: PhoneNumberCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [toggling, setToggling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingValue, setPendingValue] = useState<boolean>(true);
  const [assignOpen, setAssignOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [selectedAssistant, setSelectedAssistant] = useState<string>(phoneNumber.assistants?.id || "");
  const [assigning, setAssigning] = useState(false);
  const [releasing, setReleasing] = useState(false);

  async function handleAssign() {
    if (!selectedAssistant) return;
    setAssigning(true);
    try {
      const res = await fetch(`/api/v1/phone-numbers/${phoneNumber.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId: selectedAssistant }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to assign assistant");
      }
      toast({ title: "Assistant assigned", description: "Phone number updated successfully." });
      setAssignOpen(false);
      router.refresh();
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to assign assistant",
        variant: "destructive",
      });
    } finally {
      setAssigning(false);
    }
  }

  async function handleRelease() {
    setReleasing(true);
    try {
      const res = await fetch(`/api/v1/phone-numbers/${phoneNumber.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to release number");
      }
      toast({ title: "Number released", description: "The phone number has been released." });
      setReleaseOpen(false);
      router.refresh();
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to release number",
        variant: "destructive",
      });
    } finally {
      setReleasing(false);
    }
  }

  const isForwarded = phoneNumber.source_type === "forwarded";
  const aiEnabled = phoneNumber.ai_enabled;

  async function doToggle(newValue: boolean) {
    setToggling(true);
    try {
      const res = await fetch(`/api/v1/phone-numbers/${phoneNumber.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiEnabled: newValue }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update");
      }
      trackAiToggleChanged(newValue);
      toast({
        title: newValue ? "AI enabled" : "AI paused",
        description: newValue
          ? "AI will now answer calls on this number."
          : "AI will no longer answer calls on this number.",
      });
      router.refresh();
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to update phone number",
        variant: "destructive",
      });
    } finally {
      setToggling(false);
      setConfirmOpen(false);
    }
  }

  function handleToggle(checked: boolean) {
    setPendingValue(checked);
    // Purchased: toggling OFF needs confirmation (voicemail warning)
    // Forwarded: both ON and OFF need confirmation (carrier codes)
    if (isForwarded || !checked) {
      setConfirmOpen(true);
    } else {
      // Purchased + toggling ON → immediate, no dialog
      doToggle(true);
    }
  }

  // Build confirmation dialog content based on number type + direction
  const carrierInfo = isForwarded ? findCarrierInfo(phoneNumber.carrier, countryCode) : null;

  let dialogTitle: string;
  let dialogDescription: string;
  let dialCode: string | null = null;

  if (isForwarded && !pendingValue) {
    dialogTitle = "Pause AI for this number?";
    dialCode = carrierInfo?.instructions.conditional.disable ?? null;
    dialogDescription = dialCode
      ? "Step 1: Open your phone\u2019s dialer and dial the code below. Step 2: Click \u201CPause AI\u201D. Calls will ring your phone directly until you re-enable."
      : "To stop AI from answering, disable call forwarding on your phone through your carrier settings.";
  } else if (isForwarded && pendingValue) {
    dialogTitle = "Re-enable AI for this number?";
    const rawCode = carrierInfo?.instructions.conditional.enable ?? null;
    dialCode = rawCode ? formatInstructions(rawCode, phoneNumber.phone_number) : null;
    dialogDescription = dialCode
      ? "Step 1: Open your phone\u2019s dialer and dial the code below. Step 2: Click \u201CEnable AI\u201D."
      : "To resume AI answering, re-enable call forwarding on your phone through your carrier settings.";
  } else {
    dialogTitle = "Pause AI for this number?";
    dialogDescription =
      "Incoming calls will go to voicemail until you re-enable AI. Callers will be able to leave a message.";
  }

  const dialCodeLabel = carrierInfo && dialCode
    ? `${carrierInfo.name} ${pendingValue ? "enable" : "disable"} code`
    : pendingValue ? "Enable forwarding code" : "Disable forwarding code";

  const dialCodeHint = "Tap the code to open your dialer";

  return (
    <>
      <Card className={`card-hover${!aiEnabled ? " opacity-60" : ""}`}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                {isForwarded ? (
                  <PhoneForwarded className="h-5 w-5 text-primary" />
                ) : (
                  <Phone className="h-5 w-5 text-primary" />
                )}
              </div>
              <div>
                <CardTitle className="text-lg">
                  {formatPhoneNumber(phoneNumber.phone_number, countryCode)}
                </CardTitle>
                <CardDescription className="text-xs">
                  {phoneNumber.friendly_name || "Phone Number"}
                </CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <span className="text-xs text-muted-foreground">AI</span>
                <Switch
                  checked={aiEnabled}
                  onCheckedChange={handleToggle}
                  disabled={toggling}
                  aria-label={aiEnabled ? "Pause AI" : "Enable AI"}
                />
              </label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Phone number options">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                    Assign Assistant
                  </DropdownMenuItem>
                  {isForwarded && (
                    <DropdownMenuItem>View Forwarding Instructions</DropdownMenuItem>
                  )}
                  <DropdownMenuItem className="text-destructive" onClick={() => setReleaseOpen(true)}>
                    {isForwarded ? "Remove Forwarding" : "Release Number"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Badge variant={phoneNumber.is_active ? "success" : "secondary"}>
              {phoneNumber.is_active ? "Active" : "Inactive"}
            </Badge>
            {isForwarded && <Badge variant="outline">Forwarded</Badge>}
            {!aiEnabled && (
              <Badge variant="outline" className="border-yellow-500/50 text-yellow-600 bg-yellow-500/10">
                AI Paused
              </Badge>
            )}
          </div>

          {/* Forwarding info */}
          {isForwarded && phoneNumber.user_phone_number && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2.5">
              <PhoneForwarded className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Forwards from{" "}
                <span className="font-medium text-foreground">
                  {formatPhoneNumber(phoneNumber.user_phone_number, countryCode)}
                </span>
              </p>
            </div>
          )}

          {/* Pending setup banner */}
          {phoneNumber.forwarding_status === "pending_setup" && (
            <div className="flex items-center gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-2.5">
              <AlertCircle className="h-3.5 w-3.5 text-yellow-600" />
              <p className="text-xs text-yellow-600">Forwarding not yet confirmed</p>
            </div>
          )}

          {phoneNumber.assistants ? (
            <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{phoneNumber.assistants.name}</p>
                <p className="text-xs text-muted-foreground">Assigned Assistant</p>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-3 text-center">
              <p className="text-sm text-muted-foreground">No assistant assigned</p>
              <Button variant="link" size="sm" className="mt-1 h-auto p-0" onClick={() => setAssignOpen(true)}>
                Assign now
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Assign Assistant Dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Assistant</DialogTitle>
            <DialogDescription>
              Choose which AI assistant should answer calls on {formatPhoneNumber(phoneNumber.phone_number, countryCode)}.
            </DialogDescription>
          </DialogHeader>
          <Select value={selectedAssistant} onValueChange={setSelectedAssistant}>
            <SelectTrigger>
              <SelectValue placeholder="Select an assistant" />
            </SelectTrigger>
            <SelectContent>
              {assistants.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)} disabled={assigning}>
              Cancel
            </Button>
            <Button onClick={handleAssign} disabled={assigning || !selectedAssistant}>
              {assigning ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Assigning...</> : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Release Number Dialog */}
      <Dialog open={releaseOpen} onOpenChange={setReleaseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isForwarded ? "Remove Forwarding?" : "Release Phone Number?"}</DialogTitle>
            <DialogDescription className="space-y-2">
              {isForwarded ? (
                <>
                  <span className="block">This will remove <span className="font-semibold text-foreground">{formatPhoneNumber(phoneNumber.phone_number, countryCode)}</span> from your account.</span>
                  <span className="block">You will need to disable call forwarding on your phone manually through your carrier settings.</span>
                </>
              ) : (
                <>
                  <span className="block">This will permanently release <span className="font-semibold text-foreground">{formatPhoneNumber(phoneNumber.phone_number, countryCode)}</span>.</span>
                  <span className="block font-semibold text-destructive">This action cannot be undone. You will not be able to get this exact number back.</span>
                  <span className="block">The number will stop receiving calls immediately and any active call forwarding will be disconnected.</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseOpen(false)} disabled={releasing}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRelease} disabled={releasing}>
              {releasing ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Releasing...</> : isForwarded ? "Remove Forwarding" : "Yes, Release Number"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Toggle Confirmation Dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>
          {dialCode && (
            <div className="rounded-lg bg-muted p-4 text-center">
              <p className="text-xs text-muted-foreground mb-1">{dialCodeLabel}</p>
              <a
                href={`tel:${encodeURIComponent(dialCode)}`}
                className="block text-2xl font-mono font-bold tracking-wider text-primary hover:underline"
              >
                {dialCode}
              </a>
              <p className="text-xs text-muted-foreground mt-2">{dialCodeHint}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={toggling}>
              Cancel
            </Button>
            <Button onClick={() => doToggle(pendingValue)} disabled={toggling}>
              {toggling ? "Updating..." : pendingValue ? "Enable AI" : "Pause AI"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
