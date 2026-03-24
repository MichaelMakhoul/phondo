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
import { Loader2, CheckCircle2, Globe } from "lucide-react";

interface ScrapeResult {
  businessInfo: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    hours?: string[];
    services?: string[];
    about?: string;
  };
  totalPages: number;
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
}

export function BusinessInfo({ data, onChange, onScrape, isScraping, scrapeResult }: BusinessInfoProps) {
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
        {scrapeResult ? (
          <div className="space-y-2 rounded-md bg-green-50 px-3 py-3 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-300">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              <span>Website imported — please confirm the details below</span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pl-6 text-xs">
              {([
                ["Name", scrapeResult.businessInfo.name],
                ["Phone", scrapeResult.businessInfo.phone],
                ["Email", scrapeResult.businessInfo.email],
                ["Address", scrapeResult.businessInfo.address],
                ["Hours", scrapeResult.businessInfo.hours?.join(", ")],
                ["Services", scrapeResult.businessInfo.services?.join(", ")],
              ] as const).map(([label, value]) =>
                value ? (
                  <span key={label} className="contents">
                    <dt className="font-medium text-green-700 dark:text-green-400">{label}</dt>
                    <dd>{value}</dd>
                  </span>
                ) : null
              )}
            </dl>
            <p className="pl-6 text-xs text-green-600 dark:text-green-400">
              {scrapeResult.totalPages} page{scrapeResult.totalPages !== 1 ? "s" : ""} scraped.
              Some fields below have been pre-filled — review and edit if needed.
            </p>
          </div>
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
