"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { industryOptions } from "@/lib/templates";
import { SUPPORTED_COUNTRIES, getCountryConfig } from "@/lib/country-config";
import { Loader2, Globe } from "lucide-react";
import {
  ApproveScrapedData,
  type ApprovedScrapedData,
  type ScrapedBusinessInfo,
} from "@/components/onboarding/approve-scraped-data";

interface ScrapeResult {
  businessInfo: ScrapedBusinessInfo;
  totalPages: number;
  extraction?: "structured" | "raw-fallback";
}

interface BusinessInfoProps {
  data: {
    country: string;
    businessName: string;
    industry: string;
    businessPhone: string;
    businessWebsite: string;
  };
  onChange: (data: Partial<BusinessInfoProps["data"]>) => void;
  onScrape?: (url: string) => Promise<void>;
  isScraping?: boolean;
  scrapeResult?: ScrapeResult | null;
  /** SCRUM-534: the only path scraped data takes into the form. */
  onApplyScraped?: (approved: ApprovedScrapedData) => void;
}

export function BusinessInfo({ data, onChange, onScrape, isScraping, scrapeResult, onApplyScraped }: BusinessInfoProps) {
  const config = data.country ? getCountryConfig(data.country) : null;
  const phonePlaceholder = config?.phone.placeholder || "+1 (555) 123-4567";

  const canImport = data.businessWebsite.trim() !== "" && !isScraping;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="country">Country *</Label>
        <Select
          value={data.country || "none"}
          onValueChange={(v) => onChange({ country: v === "none" ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select your country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select your country</SelectItem>
            {SUPPORTED_COUNTRIES.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          This determines your phone number options and timezone defaults
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="businessWebsite">Website URL (Optional)</Label>
        <div className="flex gap-2">
          <Input
            id="businessWebsite"
            type="url"
            placeholder="https://www.example.com"
            value={data.businessWebsite}
            onChange={(e) => onChange({ businessWebsite: e.target.value })}
            className="flex-1"
          />
          {onScrape && (
            <Button
              type="button"
              variant="outline"
              size="default"
              disabled={!canImport}
              onClick={() => onScrape(data.businessWebsite)}
            >
              {isScraping ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <Globe className="mr-2 h-4 w-4" />
                  Import
                </>
              )}
            </Button>
          )}
        </div>
        {scrapeResult && onApplyScraped ? (
          /* SCRUM-534: nothing auto-applies. The owner reviews each block
             and presses Apply; the panel keys on the scan so a re-scan of a
             different site starts its state fresh. */
          <ApproveScrapedData
            key={`${data.businessWebsite}-${scrapeResult.totalPages}`}
            businessInfo={scrapeResult.businessInfo}
            totalPages={scrapeResult.totalPages}
            extraction={scrapeResult.extraction}
            onApply={onApplyScraped}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            We can import information from your website to train your AI
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="businessName">Business Name *</Label>
        <Input
          id="businessName"
          placeholder="Acme Dental Practice"
          value={data.businessName}
          onChange={(e) => onChange({ businessName: e.target.value })}
          required
        />
        <p className="text-xs text-muted-foreground">
          This is how your AI receptionist will identify your business
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="industry">Industry *</Label>
        <Select
          value={data.industry || "none"}
          onValueChange={(v) => onChange({ industry: v === "none" ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select your industry" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select your industry</SelectItem>
            {industryOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <div className="flex flex-col">
                  <span>{option.label}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          We&apos;ll customize your AI receptionist based on your industry
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="businessPhone">Business Phone Number</Label>
        <Input
          id="businessPhone"
          type="tel"
          placeholder={phonePlaceholder}
          value={data.businessPhone}
          onChange={(e) => onChange({ businessPhone: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Your current business phone (we&apos;ll help forward calls later)
        </p>
      </div>
    </div>
  );
}
