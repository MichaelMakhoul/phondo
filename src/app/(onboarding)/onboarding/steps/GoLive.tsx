"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Check, Phone, Rocket } from "lucide-react";
import { getCountryConfig } from "@/lib/country-config";
import { getDisplayPlans } from "@/lib/stripe/client";
import { formatCurrency } from "@/lib/utils";

interface GoLiveProps {
  data: {
    areaCode: string;
    selectedPlan: string;
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
  const { areaCodeLength, countryCallingCode } = config.phone;
  const suggestedAreaCodes = config.suggestedAreaCodes;

  // Build phone preview using country-aware formatting
  const buildPreview = () => {
    const ac = data.areaCode || Array(areaCodeLength).fill("X").join("");
    if (countryCode === "AU") {
      // AU format: +61 X XXXX XXXX (area code is like "02", display digit is "2")
      const displayAc = ac.startsWith("0") ? ac.slice(1) : ac;
      return `+${countryCallingCode} ${displayAc} XXXX XXXX`;
    }
    // US format: +1 (XXX) XXX-XXXX
    return `+${countryCallingCode} (${ac}) XXX-XXXX`;
  };
  const previewNumber = buildPreview();

  return (
    <div className="space-y-6">
      {/* Phone Number Selection */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">Get Your Phone Number</h3>
          <p className="text-sm text-muted-foreground">
            Choose an area code for your AI receptionist&apos;s phone number
          </p>
        </div>

        <div className="flex items-end gap-4">
          <div className="flex-1 space-y-2">
            <Label htmlFor="areaCode">Area Code</Label>
            <Input
              id="areaCode"
              placeholder={suggestedAreaCodes[0]?.code || ""}
              maxLength={areaCodeLength}
              value={data.areaCode}
              onChange={(e) => onChange({ areaCode: e.target.value.replace(/\D/g, "") })}
            />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-3">
              <Phone className="h-5 w-5 text-muted-foreground" />
              <span className="text-muted-foreground">
                {previewNumber}
              </span>
            </div>
          </div>
        </div>

        {suggestedAreaCodes.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Suggested area codes:</Label>
            <div className="flex flex-wrap gap-2">
              {suggestedAreaCodes.map((ac) => (
                <button
                  key={ac.code}
                  type="button"
                  onClick={() => onChange({ areaCode: ac.code })}
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
