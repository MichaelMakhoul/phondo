"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/components/ui/use-toast";
import {
  Loader2,
  Phone,
  PhoneCall,
  Copy,
  Check,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";
import {
  getCountryConfig,
  validatePhoneForCountry,
  formatInstructions,
  type CarrierInfo,
} from "@/lib/country-config";

interface Assistant {
  id: string;
  name: string;
}

interface ForwardingSetupDialogProps {
  assistants: Assistant[];
  countryCode?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step =
  | "enter_number"
  | "select_carrier"
  | "assign_assistant"
  | "provisioning"
  | "instructions"
  | "verifying";

interface ProvisionedResult {
  id: string;
  phone_number: string;
}

export function ForwardingSetupDialog({
  assistants,
  countryCode = "US",
  open,
  onOpenChange,
}: ForwardingSetupDialogProps) {
  const config = getCountryConfig(countryCode);
  const countryCarriers = config.carriers;
  const [step, setStep] = useState<Step>("enter_number");
  const [userPhone, setUserPhone] = useState("");
  const [carrierId, setCarrierId] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisioned, setProvisioned] = useState<ProvisionedResult | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  const selectedCarrier = carrierId
    ? countryCarriers.find((c) => c.id === carrierId)
    : undefined;

  const cleanPhone = userPhone.replace(/\D/g, "");
  const isValidPhone = validatePhoneForCountry(cleanPhone, countryCode);

  const stepContent: Record<Step, { title: string; description: string }> = {
    enter_number: {
      title: "Enter Your Phone Number",
      description: "Enter the business phone number you want to forward to your AI assistant",
    },
    select_carrier: {
      title: "Select Your Carrier",
      description: "Select your phone carrier so we can show the correct dial codes",
    },
    assign_assistant: {
      title: "Configure Forwarding",
      description: "Optionally assign an assistant and give this number a name",
    },
    provisioning: {
      title: "Setting Up Forwarding",
      description: "Provisioning a destination number for your calls...",
    },
    instructions: {
      title: "Forwarding Instructions",
      description: "Follow these instructions to set up call forwarding on your phone",
    },
    verifying: {
      title: "Verify Forwarding",
      description: "Call your business number from another phone to verify",
    },
  };

  // Verification polling state
  const [verifyStatus, setVerifyStatus] = useState<"waiting" | "verified" | "timeout">("waiting");
  const [verifySeconds, setVerifySeconds] = useState(120);
  const [pollError, setPollError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  const startVerification = useCallback(() => {
    if (!provisioned) return;
    setVerifyStatus("waiting");
    setVerifySeconds(120);
    setPollError(null);
    failCountRef.current = 0;
    stopPolling();

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/phone-numbers/${provisioned.id}/verify-status`);
        if (res.ok) {
          failCountRef.current = 0;
          setPollError(null);
          const data = await res.json();
          if (data.verified) {
            setVerifyStatus((prev) => {
              if (prev !== "waiting") return prev;
              stopPolling();
              return "verified";
            });
          }
        } else {
          failCountRef.current++;
          if (failCountRef.current >= 5) {
            stopPolling();
            setPollError("Unable to reach verification service. Please try again.");
            setVerifyStatus("timeout");
          }
        }
      } catch {
        failCountRef.current++;
        if (failCountRef.current >= 5) {
          stopPolling();
          setPollError("Connection lost. Please check your internet and try again.");
          setVerifyStatus("timeout");
        }
      }
    }, 3000);

    countdownRef.current = setInterval(() => {
      setVerifySeconds((prev) => {
        if (prev <= 1) {
          setVerifyStatus((current) => {
            if (current !== "waiting") return current;
            stopPolling();
            return "timeout";
          });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [provisioned, stopPolling]);

  // Clean up polling on unmount
  useEffect(() => stopPolling, [stopPolling]);

  const resetForm = () => {
    setStep("enter_number");
    setUserPhone("");
    setCarrierId("");
    setAssistantId("");
    setFriendlyName("");
    setIsProvisioning(false);
    setProvisionError(null);
    setProvisioned(null);
    setCopiedText(null);
    setIsConfirming(false);
    setVerifyStatus("waiting");
    setVerifySeconds(120);
    setPollError(null);
    failCountRef.current = 0;
    stopPolling();
  };

  const handleProvision = async () => {
    setStep("provisioning");
    setIsProvisioning(true);
    setProvisionError(null);

    try {
      const response = await fetch("/api/v1/phone-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType: "forwarded",
          userPhoneNumber: userPhone,
          carrier: carrierId,
          assistantId: assistantId || undefined,
          friendlyName: friendlyName || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Failed to provision forwarding number (HTTP ${response.status})`);
      }

      const result = await response.json();
      setProvisioned({ id: result.id, phone_number: result.phone_number });
      setStep("instructions");
    } catch (error) {
      setProvisionError(
        error instanceof Error ? error.message : "Failed to provision number"
      );
      setStep("assign_assistant");
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
      setTimeout(() => setCopiedText(null), 2000);
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Please copy the code manually." });
    }
  };

  const handleVerifyDone = (verified: boolean) => {
    stopPolling();
    if (verified) {
      toast({
        title: "Forwarding verified!",
        description: `Calls to ${formatPhoneNumber(userPhone, countryCode)} are being forwarded to your AI assistant.`,
      });
    } else {
      toast({
        title: "Number provisioned",
        description: "You can verify forwarding later from the phone numbers page.",
      });
    }
    onOpenChange(false);
    resetForm();
    router.refresh();
  };

  const renderDialCode = (
    carrier: CarrierInfo,
    type: "conditional" | "unconditional",
    destinationNumber: string
  ) => {
    const inst = carrier.instructions[type];
    const enableCode = formatInstructions(inst.enable, destinationNumber);
    const disableCode = formatInstructions(inst.disable, destinationNumber);

    return (
      <div className="space-y-3">
        <div className="space-y-2">
          <Label className="text-xs font-medium text-muted-foreground">
            To enable forwarding, dial:
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">
              {enableCode}
            </code>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => handleCopy(enableCode)}
            >
              {copiedText === enableCode ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label className="text-xs font-medium text-muted-foreground">
            To disable forwarding later:
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">
              {disableCode}
            </code>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => handleCopy(disableCode)}
            >
              {copiedText === disableCode ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{inst.note}</p>
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{stepContent[step].title}</DialogTitle>
          <DialogDescription>{stepContent[step].description}</DialogDescription>
        </DialogHeader>

        {/* Step: Enter Phone Number */}
        {step === "enter_number" && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="userPhone">Your Business Phone Number</Label>
              <Input
                id="userPhone"
                placeholder={config.phone.placeholder}
                value={userPhone}
                onChange={(e) => setUserPhone(e.target.value)}
                type="tel"
              />
              {userPhone && !isValidPhone && (
                <p className="text-xs text-destructive">
                  Enter a valid phone number
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step: Select Carrier */}
        {step === "select_carrier" && (
          <div className="space-y-3 py-4">
            {countryCarriers.map((carrier) => (
              <button
                key={carrier.id}
                type="button"
                onClick={() => setCarrierId(carrier.id)}
                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                  carrierId === carrier.id
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted"
                }`}
              >
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
                    carrierId === carrier.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  {carrier.name.charAt(0)}
                </div>
                <span className="font-medium">{carrier.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Step: Assign Assistant */}
        {step === "assign_assistant" && (
          <div className="space-y-4 py-4">
            {provisionError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{provisionError}</AlertDescription>
              </Alert>
            )}

            <div className="rounded-lg bg-muted p-3">
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {formatPhoneNumber(userPhone, countryCode)}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  AI Assistant
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Carrier: {selectedCarrier?.name}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fwdFriendlyName">Friendly Name (optional)</Label>
              <Input
                id="fwdFriendlyName"
                placeholder="e.g., Main Office Line"
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fwdAssistant">
                Assign to Assistant (optional)
              </Label>
              <Select
                value={assistantId || "none"}
                onValueChange={(v) => setAssistantId(v === "none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an assistant" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No assistant</SelectItem>
                  {assistants.map((assistant) => (
                    <SelectItem key={assistant.id} value={assistant.id}>
                      {assistant.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* Step: Provisioning */}
        {step === "provisioning" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              Provisioning a destination number...
            </p>
          </div>
        )}

        {/* Step: Instructions */}
        {step === "instructions" && provisioned && selectedCarrier && (
          <div className="space-y-4 py-4">
            <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 text-center">
              <p className="text-xs font-medium text-muted-foreground">
                Forward calls to this number:
              </p>
              <p className="mt-1 text-xl font-bold">
                {formatPhoneNumber(provisioned.phone_number, countryCode)}
              </p>
            </div>

            <Tabs defaultValue="conditional">
              <TabsList className="w-full">
                <TabsTrigger value="conditional" className="flex-1">
                  When Busy / No Answer
                </TabsTrigger>
                <TabsTrigger value="unconditional" className="flex-1">
                  Always Forward
                </TabsTrigger>
              </TabsList>
              <TabsContent value="conditional" className="mt-3">
                {renderDialCode(
                  selectedCarrier,
                  "conditional",
                  provisioned.phone_number.replace(/\D/g, "")
                )}
              </TabsContent>
              <TabsContent value="unconditional" className="mt-3">
                {renderDialCode(
                  selectedCarrier,
                  "unconditional",
                  provisioned.phone_number.replace(/\D/g, "")
                )}
              </TabsContent>
            </Tabs>

            <Alert>
              <Phone className="h-4 w-4" />
              <AlertDescription>
                Open your phone&apos;s dialer, enter the code above, and press
                call. You should hear a confirmation tone or message.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Step: Verifying */}
        {step === "verifying" && (
          <div className="space-y-4 py-4">
            {verifyStatus === "waiting" && (
              <div className="rounded-lg border p-6 text-center">
                <PhoneCall className="mx-auto h-10 w-10 text-primary animate-pulse" />
                <p className="mt-3 text-sm font-medium">
                  Call your business number from another phone
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Dial {formatPhoneNumber(userPhone, countryCode)} and wait for your AI to answer.
                </p>
                <p className="mt-3 text-2xl font-bold tabular-nums text-primary">
                  {Math.floor(verifySeconds / 60)}:{String(verifySeconds % 60).padStart(2, "0")}
                </p>
                <p className="text-xs text-muted-foreground">Listening for incoming calls...</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Tip: Use a mobile phone, ask a colleague, or call from a landline — any phone other than {formatPhoneNumber(userPhone, countryCode)}.
                </p>
              </div>
            )}

            {verifyStatus === "verified" && (
              <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/20 p-6 text-center">
                <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" />
                <p className="mt-3 text-sm font-medium text-green-800 dark:text-green-200">
                  Forwarding verified!
                </p>
                <p className="mt-1 text-xs text-green-700 dark:text-green-300">
                  Your AI assistant is answering forwarded calls.
                </p>
              </div>
            )}

            {verifyStatus === "timeout" && (
              <div className="space-y-3">
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20 p-4 text-center">
                  <AlertCircle className="mx-auto h-8 w-8 text-amber-600" />
                  <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">
                    {pollError || "No call detected"}
                  </p>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <p className="font-medium">Troubleshooting tips:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>Make sure you dialed the forwarding code from the instructions step</li>
                    <li>Call from a different phone (not the one being forwarded)</li>
                    <li>Some carriers take a few minutes to activate forwarding</li>
                    <li>If you set up conditional forwarding, let it ring until it goes unanswered</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "enter_number" && (
            <Button onClick={() => setStep("select_carrier")} disabled={!isValidPhone}>
              Continue
            </Button>
          )}
          {step === "select_carrier" && (
            <>
              <Button
                variant="outline"
                onClick={() => setStep("enter_number")}
              >
                Back
              </Button>
              <Button
                onClick={() => setStep("assign_assistant")}
                disabled={!carrierId}
              >
                Continue
              </Button>
            </>
          )}
          {step === "assign_assistant" && (
            <>
              <Button
                variant="outline"
                onClick={() => setStep("select_carrier")}
              >
                Back
              </Button>
              <Button onClick={handleProvision} disabled={isProvisioning}>
                {isProvisioning && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Set Up Forwarding
              </Button>
            </>
          )}
          {step === "instructions" && (
            <Button onClick={() => { setStep("verifying"); startVerification(); }}>
              I&apos;ve Dialed the Code — Verify Now
            </Button>
          )}
          {step === "verifying" && verifyStatus === "waiting" && (
            <Button
              variant="outline"
              onClick={() => handleVerifyDone(false)}
            >
              Skip Verification
            </Button>
          )}
          {step === "verifying" && verifyStatus === "verified" && (
            <Button onClick={() => handleVerifyDone(true)}>
              Done
            </Button>
          )}
          {step === "verifying" && verifyStatus === "timeout" && (
            <>
              <Button
                variant="ghost"
                onClick={() => { stopPolling(); setStep("instructions"); }}
              >
                Back to Instructions
              </Button>
              <Button
                variant="outline"
                onClick={() => handleVerifyDone(false)}
              >
                I&apos;ll Verify Later
              </Button>
              <Button onClick={startVerification}>
                Try Again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
