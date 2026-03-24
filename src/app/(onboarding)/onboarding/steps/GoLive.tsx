"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Check, Phone, Rocket, Loader2, Search, CheckCircle2 } from "lucide-react";
import { getCountryConfig } from "@/lib/country-config";
import { getDisplayPlans } from "@/lib/stripe/client";
import { formatCurrency, formatPhoneNumber } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";

interface AvailableNumber {
  number: string;
  locality?: string;
  region?: string;
}

interface GoLiveProps {
  data: {
    areaCode: string;
    selectedPlan: string;
    selectedPhoneNumber: string;
  };
  countryCode: string;
  onChange: (data: Partial<GoLiveProps["data"]>) => void;
}

const plans = getDisplayPlans().map((plan) => ({
  ...plan,
  highlight: plan.highlighted,
}));

export function GoLive({ data, countryCode, onChange }: GoLiveProps) {
  const config = getCountryConfig(countryCode);
  const { areaCodeLength } = config.phone;
  const suggestedAreaCodes = config.suggestedAreaCodes;
  const { toast } = useToast();

  const [availableNumbers, setAvailableNumbers] = useState<AvailableNumber[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = async (areaCodeOverride?: string) => {
    const ac = areaCodeOverride ?? data.areaCode;
    if (ac.length !== areaCodeLength) return;

    setIsSearching(true);
    setSearchError(null);
    setAvailableNumbers([]);
    setHasSearched(false);
    // Clear previous selection when searching again
    onChange({ selectedPhoneNumber: "" });

    try {
      const response = await fetch("/api/v1/phone-numbers/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areaCode: ac, limit: 5 }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Failed to search phone numbers");
      }

      const numbers = await response.json();
      setAvailableNumbers(numbers);
      setHasSearched(true);
    } catch (error: any) {
      setSearchError(error.message || "Failed to search for numbers. Check your Twilio configuration.");
      toast({
        variant: "destructive",
        title: "Search failed",
        description: error.message || "Could not search for phone numbers.",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const handleAreaCodeClick = (code: string) => {
    onChange({ areaCode: code, selectedPhoneNumber: "" });
    setAvailableNumbers([]);
    setHasSearched(false);
    setSearchError(null);
    // Auto-search when clicking a suggested area code
    handleSearch(code);
  };

  return (
    <div className="space-y-6">
      {/* Phone Number Selection */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Get Your Phone Number</h3>
          <p className="text-sm text-muted-foreground">
            Choose an area code and pick a phone number for your AI receptionist
          </p>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-2">
            <Label htmlFor="areaCode">Area Code</Label>
            <Input
              id="areaCode"
              placeholder={suggestedAreaCodes[0]?.code || ""}
              maxLength={areaCodeLength}
              value={data.areaCode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, "");
                onChange({ areaCode: val, selectedPhoneNumber: "" });
                setAvailableNumbers([]);
                setHasSearched(false);
                setSearchError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSearch();
                }
              }}
            />
          </div>
          <Button
            onClick={() => handleSearch()}
            disabled={data.areaCode.length !== areaCodeLength || isSearching}
            className="min-w-[140px]"
          >
            {isSearching ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="mr-2 h-4 w-4" />
                Find Numbers
              </>
            )}
          </Button>
        </div>

        {suggestedAreaCodes.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Suggested area codes:</Label>
            <div className="flex flex-wrap gap-2">
              {suggestedAreaCodes.map((ac) => (
                <button
                  key={ac.code}
                  type="button"
                  onClick={() => handleAreaCodeClick(ac.code)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    data.areaCode === ac.code
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted hover:bg-muted/80"
                  }`}
                >
                  {ac.code} ({ac.location})
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Search error */}
        {searchError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {searchError}
          </div>
        )}

        {/* Available numbers list */}
        {hasSearched && availableNumbers.length > 0 && (
          <div className="space-y-2">
            <Label className="text-sm">Select a number:</Label>
            <div className="space-y-2">
              {availableNumbers.map((num) => (
                <button
                  key={num.number}
                  type="button"
                  onClick={() => onChange({ selectedPhoneNumber: num.number })}
                  className={`flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors hover:bg-muted ${
                    data.selectedPhoneNumber === num.number
                      ? "border-primary bg-primary/5 ring-2 ring-primary"
                      : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium">{formatPhoneNumber(num.number, countryCode)}</p>
                      {(num.locality || num.region) && (
                        <p className="text-xs text-muted-foreground">
                          {[num.locality, num.region].filter(Boolean).join(", ")}
                        </p>
                      )}
                    </div>
                  </div>
                  {data.selectedPhoneNumber === num.number && (
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* No numbers found */}
        {hasSearched && availableNumbers.length === 0 && !searchError && (
          <div className="rounded-lg border bg-muted/50 p-4 text-center text-sm text-muted-foreground">
            No numbers available for this area code. Try a different one.
          </div>
        )}

        {/* Selected number confirmation */}
        {data.selectedPhoneNumber && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/50 bg-primary/5 p-3">
            <CheckCircle2 className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium">
              Your number: {formatPhoneNumber(data.selectedPhoneNumber, countryCode)}
            </span>
          </div>
        )}
      </div>

      {/* Plan Selection */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-medium">Choose Your Plan</h3>
            <p className="text-sm text-muted-foreground">
              Start with a 14-day free trial - no credit card required
            </p>
          </div>
          <Badge variant="secondary" className="bg-green-100 text-green-700">
            14-day free trial
          </Badge>
        </div>

        <RadioGroup
          value={data.selectedPlan || "none"}
          onValueChange={(v) => onChange({ selectedPlan: v === "none" ? "" : v })}
          className="grid gap-4 md:grid-cols-3"
        >
          {plans.map((plan) => (
            <Label
              key={plan.id}
              htmlFor={plan.id}
              className={`cursor-pointer rounded-lg border p-4 transition-all hover:border-primary ${
                data.selectedPlan === plan.id
                  ? "border-primary bg-primary/5 ring-2 ring-primary"
                  : plan.highlight
                  ? "border-primary/50"
                  : ""
              }`}
            >
              <RadioGroupItem
                value={plan.id}
                id={plan.id}
                className="sr-only"
              />
              <div className="space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{plan.name}</span>
                      {plan.highlight && (
                        <Badge variant="default" className="text-xs">
                          Popular
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {plan.description}
                    </p>
                  </div>
                  {data.selectedPlan === plan.id && (
                    <Check className="h-5 w-5 text-primary" />
                  )}
                </div>
                <div className="text-2xl font-bold">
                  {formatCurrency(plan.price)}
                  <span className="text-sm font-normal text-muted-foreground">
                    /month
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {plan.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Check className="h-4 w-4 text-green-500" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            </Label>
          ))}
        </RadioGroup>
      </div>

      {/* What's Next */}
      <Card className="bg-muted/50 p-4">
        <h4 className="flex items-center gap-2 font-medium">
          <Rocket className="h-5 w-5 text-primary" />
          What happens next?
        </h4>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              1
            </span>
            Your AI receptionist will be created and ready instantly
          </li>
          <li className="flex items-start gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              2
            </span>
            You&apos;ll get a phone number that connects to your AI
          </li>
          <li className="flex items-start gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              3
            </span>
            Forward your existing number or share your new number
          </li>
          <li className="flex items-start gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              4
            </span>
            Start receiving calls handled by your AI receptionist!
          </li>
        </ul>
      </Card>
    </div>
  );
}
