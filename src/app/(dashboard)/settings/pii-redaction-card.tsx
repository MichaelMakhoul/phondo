"use client";

import { useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";

interface PiiRedactionCardProps {
  assistantId: string;
  initialEnabled: boolean;
  industry?: string;
}

const PII_RECOMMENDED_INDUSTRIES = ["medical", "dental", "legal"];

export function PiiRedactionCard({ assistantId, initialEnabled, industry }: PiiRedactionCardProps) {
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
        {!enabled && industry && PII_RECOMMENDED_INDUSTRIES.includes(industry) && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              <span className="font-medium">Recommended:</span> Enable PII redaction for {industry === "legal" ? "legal" : "medical"} practices to protect {industry === "legal" ? "client" : "patient"} confidentiality.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
