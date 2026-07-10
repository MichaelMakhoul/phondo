"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Globe,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Building2,
  Phone,
  Mail,
} from "lucide-react";

interface WebsiteImportProps {
  assistantId?: string;
  onImportComplete?: (data: ImportResult) => void;
  onContentExtracted?: (content: string) => void;
}

interface ImportResult {
  url: string;
  totalPages: number;
  content: string;
  businessInfo: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
  };
}

export function WebsiteImport({
  assistantId,
  onImportComplete,
  onContentExtracted,
}: WebsiteImportProps) {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleImport = async () => {
    if (!url) {
      setError("Please enter a website URL");
      return;
    }

    // Validate URL format
    let normalizedUrl = url;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      normalizedUrl = `https://${url}`;
    }

    try {
      new URL(normalizedUrl);
    } catch {
      setError("Please enter a valid website URL");
      return;
    }

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/v1/knowledge-base/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: normalizedUrl,
          assistantId,
          maxPages: 20,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to import website");
      }

      const importResult: ImportResult = {
        url: data.data.url,
        totalPages: data.data.totalPages,
        content: data.data.content,
        businessInfo: data.data.businessInfo || {},
      };

      setResult(importResult);

      if (onImportComplete) {
        onImportComplete(importResult);
      }

      if (onContentExtracted) {
        onContentExtracted(data.data.content);
      }
    } catch (err: any) {
      setError(err.message || "Failed to import website content");
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isLoading) {
      handleImport();
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="websiteUrl">Website URL</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="websiteUrl"
              placeholder="www.yourbusiness.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading}
              className="pl-10"
            />
          </div>
          <Button onClick={handleImport} disabled={isLoading || !url}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Importing...
              </>
            ) : (
              "Import"
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          We&apos;ll analyze your website to train your AI with business-specific
          knowledge
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading && (
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <div>
              <p className="font-medium">Analyzing your website...</p>
              <p className="text-sm text-muted-foreground">
                This may take a moment depending on your website size
              </p>
            </div>
          </div>
        </Card>
      )}

      {result && (
        <Card className="p-4 space-y-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">Website imported successfully!</p>
              <p className="text-sm text-muted-foreground">{result.url}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span>
                <strong>{result.totalPages}</strong> pages analyzed
              </span>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <Badge variant="secondary">
                {result.content.length.toLocaleString()} characters
              </Badge>
            </div>
          </div>

          {/* Business info found */}
          {(result.businessInfo.phone || result.businessInfo.email) && (
            <div className="border-t pt-3">
              <p className="text-sm font-medium mb-2">Business info found:</p>
              <div className="grid gap-2 text-sm">
                {result.businessInfo.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span>{result.businessInfo.phone}</span>
                  </div>
                )}
                {result.businessInfo.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span>{result.businessInfo.email}</span>
                  </div>
                )}
                {result.businessInfo.address && (
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                    <span>{result.businessInfo.address}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
