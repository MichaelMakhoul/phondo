"use client";

import { useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, ShieldAlert } from "lucide-react";

interface PiiRedactionCardProps {
  assistantId: string;
  initialEnabled: boolean;
}

export function PiiRedactionCard({ assistantId, initialEnabled }: PiiRedactionCardProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleToggle = async (checked: boolean) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/v1/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { piiRedactionEnabled: checked },
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setEnabled(checked);
      toast({
        title: checked ? "PII redaction enabled" : "PII redaction disabled",
        description: checked
          ? "Sensitive information will be automatically redacted from transcripts and summaries."
          : "PII redaction has been turned off.",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save settings. Please try again.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          PII Redaction
        </CardTitle>
        <CardDescription>
          Automatically detect and redact personally identifiable information (Medicare numbers, tax file numbers, bank details, etc.) from call transcripts and summaries before they are stored. Names and free-form conversational text are not redacted. Applies to future calls only &mdash; existing transcripts are not affected. Recommended for medical and legal practices.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <Label htmlFor="pii-toggle" className="flex items-center gap-2">
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {enabled ? "Enabled" : "Disabled"}
          </Label>
          <Switch
            id="pii-toggle"
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={isLoading}
          />
        </div>
      </CardContent>
    </Card>
  );
}
