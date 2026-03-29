"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Building, Clock, Globe, Calendar, Shield } from "lucide-react";
import {
  SUPPORTED_COUNTRIES,
  getCountryConfig,
  getTimezonesForCountry,
} from "@/lib/country-config";
import { industryOptions } from "@/lib/templates";

const DAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
];

const APPOINTMENT_DURATIONS = [
  { value: "15", label: "15 minutes" },
  { value: "20", label: "20 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
];

const US_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }, { code: "DC", name: "District of Columbia" },
];

// UI-only copy for showing consent warnings. Authoritative list is in
// voice-server/lib/recording-consent.js (runtime enforcement).
const TWO_PARTY_CONSENT_STATES = new Set([
  "CA", "CT", "FL", "IL", "MD", "MA", "MT", "NV", "NH", "PA", "WA",
]);

interface BusinessHours {
  [key: string]: { open: string; close: string } | null;
}

interface BusinessSettingsFormProps {
  organizationId: string;
  initialData: {
    country: string;
    businessName: string;
    industry: string;
    websiteUrl: string;
    phone: string;
    address: string;
    timezone: string;
    businessHours: BusinessHours | null;
    defaultAppointmentDuration: number;
    businessState: string;
    recordingConsentMode: string;
    appointmentVerificationFields: string[];
  };
}

export function BusinessSettingsForm({
  organizationId,
  initialData,
}: BusinessSettingsFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [country, setCountry] = useState(initialData.country);
  const [businessName, setBusinessName] = useState(initialData.businessName);
  const [industry, setIndustry] = useState(initialData.industry);
  const [websiteUrl, setWebsiteUrl] = useState(initialData.websiteUrl);
  const [phone, setPhone] = useState(initialData.phone);
  const [address, setAddress] = useState(initialData.address);
  const [timezone, setTimezone] = useState(initialData.timezone);
  const [appointmentDuration, setAppointmentDuration] = useState(
    initialData.defaultAppointmentDuration
  );
  const [businessState, setBusinessState] = useState(initialData.businessState);
  const [recordingConsentMode, setRecordingConsentMode] = useState(initialData.recordingConsentMode);
  const [businessHours, setBusinessHours] = useState<BusinessHours>(
    initialData.businessHours || {
      monday: { open: "09:00", close: "17:00" },
      tuesday: { open: "09:00", close: "17:00" },
      wednesday: { open: "09:00", close: "17:00" },
      thursday: { open: "09:00", close: "17:00" },
      friday: { open: "09:00", close: "17:00" },
      saturday: null,
      sunday: null,
    }
  );
  const [verificationFields, setVerificationFields] = useState<string[]>(
    initialData.appointmentVerificationFields || ["name", "phone"]
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const supabase = createClient();

  const config = getCountryConfig(country);
  const timezones = getTimezonesForCountry(country);

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!businessName.trim()) {
      newErrors.businessName = "Business name is required";
    }

    if (phone.trim()) {
      // Allow digits, spaces, dashes, parens, plus sign — min 7 digits
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) {
        newErrors.phone = "Enter a valid phone number (7-15 digits)";
      }
    }

    if (websiteUrl.trim()) {
      try {
        const url = new URL(websiteUrl);
        if (!["http:", "https:"].includes(url.protocol)) {
          newErrors.websiteUrl = "URL must start with http:// or https://";
        }
      } catch {
        newErrors.websiteUrl = "Enter a valid URL (e.g. https://example.com)";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const clearError = (field: string) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleCountryChange = (newCountry: string) => {
    setCountry(newCountry);
    const newConfig = getCountryConfig(newCountry);
    // If current timezone isn't in the new country's list, switch to default
    const tzValues = newConfig.timezones.map((t) => t.value);
    if (!tzValues.includes(timezone)) {
      setTimezone(newConfig.defaultTimezone);
    }
    // Clear US state when switching away from US
    if (newCountry !== "US") {
      setBusinessState("");
    }
  };

  const handleSave = async () => {
    if (!validate()) return;
    setIsLoading(true);
    try {
      const { error } = await (supabase as any)
        .from("organizations")
        .update({
          country,
          business_name: businessName,
          name: businessName, // Keep name in sync
          industry,
          business_website: websiteUrl,
          business_phone: phone,
          business_address: address,
          timezone,
          business_hours: businessHours,
          default_appointment_duration: appointmentDuration,
          business_state: businessState || null,
          recording_consent_mode: recordingConsentMode,
          appointment_verification_fields: verificationFields,
        })
        .eq("id", organizationId);

      if (error) throw error;

      toast({
        title: "Settings saved",
        description: "Your business settings have been updated.",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save settings. Please try again.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const toggleDayOpen = (day: string) => {
    setBusinessHours((prev) => ({
      ...prev,
      [day]: prev[day] ? null : { open: "09:00", close: "17:00" },
    }));
  };

  const updateDayHours = (
    day: string,
    field: "open" | "close",
    value: string
  ) => {
    setBusinessHours((prev) => ({
      ...prev,
      [day]: prev[day] ? { ...prev[day]!, [field]: value } : null,
    }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building className="h-5 w-5" />
          Business Information
        </CardTitle>
        <CardDescription>
          Tell us about your business so your AI receptionist can serve your
          customers better
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Country */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            Country
          </Label>
          <Select value={country} onValueChange={handleCountryChange}>
            <SelectTrigger className="w-full md:w-[300px]">
              <SelectValue placeholder="Select country" />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Changing your country affects timezone options and new phone number
            provisioning. Existing phone numbers will continue to work.
          </p>
        </div>

        {/* State (US only) */}
        {country === "US" && (
          <div className="space-y-2">
            <Label>State</Label>
            <Select value={businessState} onValueChange={setBusinessState}>
              <SelectTrigger className="w-full md:w-[300px]">
                <SelectValue placeholder="Select state" />
              </SelectTrigger>
              <SelectContent>
                {US_STATES.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!businessState && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Select your state to ensure correct recording disclosure settings.
                Some states require all-party consent for call recording.
              </p>
            )}
            {businessState && TWO_PARTY_CONSENT_STATES.has(businessState) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {US_STATES.find((s) => s.code === businessState)?.name} requires
                all-party consent for call recording. A recording disclosure will
                be played at the start of each call.
              </p>
            )}
          </div>
        )}

        {/* Basic Info */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="businessName">Business Name</Label>
            <Input
              id="businessName"
              value={businessName}
              onChange={(e) => { setBusinessName(e.target.value); clearError("businessName"); }}
              placeholder="Acme Dental"
              className={errors.businessName ? "border-destructive" : ""}
            />
            {errors.businessName && (
              <p className="text-xs text-destructive">{errors.businessName}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="industry">Industry</Label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger>
                <SelectValue placeholder="Select your industry" />
              </SelectTrigger>
              <SelectContent>
                {industryOptions.map((ind) => (
                  <SelectItem key={ind.value} value={ind.value}>
                    {ind.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="websiteUrl">Website URL</Label>
            <Input
              id="websiteUrl"
              type="url"
              value={websiteUrl}
              onChange={(e) => { setWebsiteUrl(e.target.value); clearError("websiteUrl"); }}
              placeholder="https://acmedental.com"
              className={errors.websiteUrl ? "border-destructive" : ""}
            />
            {errors.websiteUrl ? (
              <p className="text-xs text-destructive">{errors.websiteUrl}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                We can import information from your website to train your AI
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Business Phone</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); clearError("phone"); }}
              placeholder={config.phone.placeholder}
              className={errors.phone ? "border-destructive" : ""}
            />
            {errors.phone && (
              <p className="text-xs text-destructive">{errors.phone}</p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="address">Business Address</Label>
          <Input
            id="address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, State 12345"
          />
        </div>

        <Separator />

        {/* Timezone */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Timezone
          </Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger className="w-full md:w-[300px]">
              <SelectValue placeholder="Select timezone" />
            </SelectTrigger>
            <SelectContent>
              {timezones.map((tz) => (
                <SelectItem key={tz.value} value={tz.value}>
                  {tz.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Separator />

        {/* Business Hours */}
        <div className="space-y-4">
          <Label className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Business Hours
          </Label>
          <p className="text-sm text-muted-foreground">
            Your AI will know when you're open and can inform callers
            accordingly
          </p>

          <div className="space-y-3">
            {DAYS.map((day) => (
              <div
                key={day.key}
                className="flex items-center gap-4 py-2 border-b last:border-0"
              >
                <div className="w-28 flex items-center gap-2">
                  <Switch
                    checked={!!businessHours[day.key]}
                    onCheckedChange={() => toggleDayOpen(day.key)}
                  />
                  <span className="text-sm font-medium">{day.label}</span>
                </div>

                {businessHours[day.key] ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Input
                      type="time"
                      value={businessHours[day.key]?.open || "09:00"}
                      onChange={(e) =>
                        updateDayHours(day.key, "open", e.target.value)
                      }
                      className="w-32"
                    />
                    <span className="text-muted-foreground">to</span>
                    <Input
                      type="time"
                      value={businessHours[day.key]?.close || "17:00"}
                      onChange={(e) =>
                        updateDayHours(day.key, "close", e.target.value)
                      }
                      className="w-32"
                    />
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">Closed</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <Separator />

        {/* Appointment Duration */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Default Appointment Duration
          </Label>
          <Select
            value={String(appointmentDuration)}
            onValueChange={(v) => setAppointmentDuration(Number(v))}
          >
            <SelectTrigger className="w-full md:w-[300px]">
              <SelectValue placeholder="Select duration" />
            </SelectTrigger>
            <SelectContent>
              {APPOINTMENT_DURATIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
              {!APPOINTMENT_DURATIONS.some((d) => d.value === String(appointmentDuration)) && (
                <SelectItem value={String(appointmentDuration)}>
                  {appointmentDuration} minutes
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            How long each appointment slot should be when using built-in
            booking. Cal.com users: duration comes from your event type instead.
          </p>
        </div>

        <Separator />

        {/* Compliance & Privacy */}
        <div className="space-y-4">
          <Label className="flex items-center gap-2 text-base font-semibold">
            <Shield className="h-4 w-4" />
            Call Recording Disclosure
          </Label>
          <p className="text-sm text-muted-foreground">
            When enabled, a brief recording disclosure is played to the caller
            before your AI receptionist greets them. Required by law in some
            jurisdictions.
          </p>
          <RadioGroup
            value={recordingConsentMode}
            onValueChange={setRecordingConsentMode}
            className="space-y-2"
          >
            <div className="flex items-start gap-2">
              <RadioGroupItem value="auto" id="consent-auto" className="mt-1" />
              <div>
                <Label htmlFor="consent-auto" className="font-medium">
                  Automatic (recommended)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Disclosure is played when required by your business location
                  {country === "AU" && " — always required in Australia"}
                  {country === "US" && businessState && TWO_PARTY_CONSENT_STATES.has(businessState) && ` — required in ${US_STATES.find((s) => s.code === businessState)?.name}`}
                  {country === "US" && businessState && !TWO_PARTY_CONSENT_STATES.has(businessState) && " — not required in your state (one-party consent)"}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="always" id="consent-always" className="mt-1" />
              <div>
                <Label htmlFor="consent-always" className="font-medium">
                  Always disclose
                </Label>
                <p className="text-xs text-muted-foreground">
                  Play the recording disclosure on every call regardless of location
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <RadioGroupItem value="never" id="consent-never" className="mt-1" />
              <div>
                <Label htmlFor="consent-never" className="font-medium">
                  Never disclose
                </Label>
                <p className="text-xs text-muted-foreground">
                  Do not play a recording disclosure. Only use this if you do not
                  record calls or handle consent separately.
                </p>
              </div>
            </div>
          </RadioGroup>
        </div>

        <Separator />

        {/* Appointment Verification */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <div>
              <Label className="text-base font-medium">Appointment Verification</Label>
              <p className="text-sm text-muted-foreground">
                Choose which fields the AI must verify before sharing appointment details with a caller.
                This protects patient/client privacy.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { id: "name", label: "Full Name", description: "Caller must provide their name", required: true },
              { id: "phone", label: "Phone Number", description: "Caller must confirm their phone number", required: false },
              { id: "email", label: "Email Address", description: "Caller must provide their email", required: false },
              { id: "date_of_birth", label: "Date of Birth", description: "Caller must provide their DOB", required: false },
            ].map((field) => (
              <label
                key={field.id}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  verificationFields.includes(field.id) ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                } ${field.required ? "opacity-100" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={verificationFields.includes(field.id)}
                  disabled={field.required}
                  onChange={(e) => {
                    if (field.required) return;
                    setVerificationFields((prev) =>
                      e.target.checked
                        ? [...prev, field.id]
                        : prev.filter((f) => f !== field.id)
                    );
                  }}
                  className="mt-1 h-4 w-4 rounded border-input"
                />
                <div>
                  <span className="text-sm font-medium">{field.label}</span>
                  {field.required && (
                    <span className="ml-1 text-xs text-muted-foreground">(always required)</span>
                  )}
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                </div>
              </label>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            The AI will ask callers for {verificationFields.map((f) =>
              f === "name" ? "their name" : f === "phone" ? "their phone number" : f === "email" ? "their email" : "their date of birth"
            ).join(", ")} before looking up or sharing any appointment information.
          </p>
        </div>

        <Separator />

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Business Info
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
