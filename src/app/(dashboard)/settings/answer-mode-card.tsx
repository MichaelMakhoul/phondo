"use client";

import { useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, PhoneForwarded } from "lucide-react";

const TIMEOUT_OPTIONS = [
  { value: "10", label: "10 seconds" },
  { value: "15", label: "15 seconds" },
  { value: "20", label: "20 seconds (recommended)" },
  { value: "25", label: "25 seconds" },
  { value: "30", label: "30 seconds" },
];

interface AnswerModeCardProps {
  assistantId: string;
  initialSettings: {
    answerMode: string;
    ringFirstNumber: string;
    ringFirstTimeout: number;
  };
}

export function AnswerModeCard({ assistantId, initialSettings }: AnswerModeCardProps) {
  const [answerMode, setAnswerMode] = useState(initialSettings.answerMode);
  const [ringFirstNumber, setRingFirstNumber] = useState(initialSettings.ringFirstNumber);
  const [ringFirstTimeout, setRingFirstTimeout] = useState(initialSettings.ringFirstTimeout);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (answerMode === "ring_first") {
      if (!ringFirstNumber.trim()) {
        newErrors.ringFirstNumber = "Phone number is required for ring-first mode";
      } else if (!/^\+\d{7,15}$/.test(ringFirstNumber.trim())) {
        newErrors.ringFirstNumber = "Enter a valid phone number in international format (e.g., +61412345678)";
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/v1/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            answerMode,
            ringFirstNumber: answerMode === "ring_first" ? ringFirstNumber.trim() : null,
            ringFirstTimeout: answerMode === "ring_first" ? ringFirstTimeout : null,
          },
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast({ title: "Settings saved", description: "Call answering mode has been updated." });
    } catch {
      toast({ variant: "destructive", title: "Error", description: "Failed to save settings. Please try again." });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneForwarded className="h-5 w-5" />
          Call Answering Mode
        </CardTitle>
        <CardDescription>
          Choose how incoming calls are handled — let AI answer immediately, or ring your phone first
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup value={answerMode} onValueChange={setAnswerMode} className="space-y-3">
          <div className="flex items-start gap-2">
            <RadioGroupItem value="ai_first" id="mode-ai" className="mt-1" />
            <div>
              <Label htmlFor="mode-ai" className="font-medium">AI answers all calls</Label>
              <p className="text-xs text-muted-foreground">
                Your AI receptionist answers every call immediately. Best for businesses that want 24/7 coverage.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="ring_first" id="mode-ring" className="mt-1" />
            <div>
              <Label htmlFor="mode-ring" className="font-medium">Ring my phone first</Label>
              <p className="text-xs text-muted-foreground">
                Calls ring your phone first. If you don't answer, the AI picks up automatically. Best for solo operators who prefer to answer their own calls.
              </p>
            </div>
          </div>
        </RadioGroup>

        {answerMode === "ring_first" && (
          <div className="space-y-4 rounded-lg border p-4 bg-muted/30">
            <div className="space-y-2">
              <Label htmlFor="ringFirstNumber">Your phone number</Label>
              <Input
                id="ringFirstNumber"
                type="tel"
                value={ringFirstNumber}
                onChange={(e) => { setRingFirstNumber(e.target.value); setErrors({}); }}
                placeholder="+61412345678"
                className={errors.ringFirstNumber ? "border-destructive" : ""}
              />
              {errors.ringFirstNumber ? (
                <p className="text-xs text-destructive">{errors.ringFirstNumber}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Enter your mobile number in international format. This is the number that will ring before the AI takes over.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Ring duration</Label>
              <Select value={String(ringFirstTimeout)} onValueChange={(v) => setRingFirstTimeout(Number(v))}>
                <SelectTrigger className="w-full md:w-[300px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEOUT_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                How long your phone rings before the AI picks up
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Answering Mode
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
