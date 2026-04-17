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
import { TimePicker } from "@/components/ui/time-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Building, Clock, Globe, Calendar, Shield, AlertTriangle } from "lucide-react";
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

// Verification method options — code-based modes removed in SCRUM-259 to
// eliminate AI hallucination issues with spoken confirmation codes.
// The AI now always verifies callers by name, phone, and other identity fields.
const VERIFICATION_METHODS = [
  { id: "details_only", label: "Verify by Details", description: "Caller verifies their identity with name, phone number, and other fields you choose below." },
];

// Fields available for identity verification
const VERIFICATION_FIELD_OPTIONS = [
  { id: "name", label: "Full Name", shortLabel: "name", description: "Caller must state their name as it was booked" },
  { id: "phone", label: "Phone Number", shortLabel: "phone", description: "Caller must confirm the phone number used when booking" },
  { id: "email", label: "Email Address", shortLabel: "email", description: "Caller must provide the email used when booking" },
  // DOB: disabled until appointments store date_of_birth (SCRUM-147 follow-up)
  // { id: "date_of_birth", label: "Date of Birth", shortLabel: "DOB", description: "Recommended for medical and legal practices" },
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
    businessEmail: string;
    address: string;
    timezone: string;
    businessHours: BusinessHours | null;
    defaultAppointmentDuration: number;
    businessState: string;
    recordingConsentMode: string;
    recordingDisclosureText: string;
    appointmentVerificationFields: { method: string; fields: string[] } | string[];
    sendCustomerConfirmations: boolean;
    smsSender: string | null;
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
  const [businessEmail, setBusinessEmail] = useState(initialData.businessEmail || "");
  const [address, setAddress] = useState(initialData.address);
  const [timezone, setTimezone] = useState(initialData.timezone);
  const [appointmentDuration, setAppointmentDuration] = useState(
    initialData.defaultAppointmentDuration
  );
  const [businessState, setBusinessState] = useState(initialData.businessState);
  const [recordingConsentMode, setRecordingConsentMode] = useState(initialData.recordingConsentMode);
  const [disclosureText, setDisclosureText] = useState(initialData.recordingDisclosureText || "");
  const [sendCustomerConfirmations, setSendCustomerConfirmations] = useState(
    initialData.sendCustomerConfirmations ?? true
  );
  const [smsSender, setSmsSender] = useState(initialData.smsSender || "");
  const [smsSenderError, setSmsSenderError] = useState<string | null>(null);
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
  // Parse verification settings (structured object or legacy array)
  const initVerification = (() => {
    const raw = initialData.appointmentVerificationFields;
    if (raw && !Array.isArray(raw) && raw.fields) {
      return { method: "details_only", fields: raw.fields || ["name", "phone"] };
    }
    if (Array.isArray(raw)) {
      return { method: "details_only", fields: raw };
    }
    return { method: "details_only", fields: ["name", "phone"] };
  })();
  const [verificationMethod, setVerificationMethod] = useState(initVerification.method);
  const [verificationFields, setVerificationFields] = useState<string[]>(initVerification.fields);
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

    if (businessEmail.trim()) {
      // Matches the DB CHECK constraint: something@something.something, no spaces
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(businessEmail.trim())) {
        newErrors.businessEmail = "Enter a valid email address";
      } else if (businessEmail.trim().length > 254) {
        newErrors.businessEmail = "Email is too long";
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
    // SCRUM-260: validate SMS sender (alphanumeric, 1-11 chars, at least one letter)
    if (smsSender.trim()) {
      const s = smsSender.trim();
      let smsErr: string | null = null;
      if (s.length > 11) smsErr = "SMS sender must be at most 11 characters";
      else if (!/^[A-Za-z0-9 ]+$/.test(s)) smsErr = "SMS sender can only contain letters, numbers, and spaces";
      else if (!/[A-Za-z]/.test(s)) smsErr = "SMS sender must contain at least one letter";
      if (smsErr) {
        setSmsSenderError(smsErr);
        toast({ variant: "destructive", title: "Invalid SMS sender", description: smsErr });
        return;
      }
      setSmsSenderError(null);
    }
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
          business_email: businessEmail.trim() || null,
          business_address: address,
          timezone,
          business_hours: businessHours,
          default_appointment_duration: appointmentDuration,
          business_state: businessState || null,
          recording_consent_mode: recordingConsentMode,
          recording_disclosure_text: disclosureText.trim() || null,
          appointment_verification_fields: { method: verificationMethod, fields: verificationFields },
          send_customer_confirmations: sendCustomerConfirmations,
          sms_sender: smsSender.trim() || null,
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
            <SelectTrigger className="w-full md:w-[300px]" aria-label="Country">
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
              <SelectTrigger className="w-full md:w-[300px]" aria-label="State">
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
              <SelectTrigger aria-label="Industry">
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
          <div className="space-y-2">
            <Label htmlFor="businessEmail">Business Email</Label>
            <Input
              id="businessEmail"
              type="email"
              value={businessEmail}
              onChange={(e) => { setBusinessEmail(e.target.value); clearError("businessEmail"); }}
              placeholder="hello@yourbusiness.com"
              className={errors.businessEmail ? "border-destructive" : ""}
            />
            {errors.businessEmail && (
              <p className="text-xs text-destructive">{errors.businessEmail}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Used as an opt-out contact on text messages when you&apos;re not giving out your phone number.
            </p>
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
            <SelectTrigger className="w-full md:w-[300px]" aria-label="Timezone">
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
                className="flex flex-col gap-2 py-2 border-b last:border-0 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="w-28 flex items-center gap-2 shrink-0">
                  <Switch
                    checked={!!businessHours[day.key]}
                    onCheckedChange={() => toggleDayOpen(day.key)}
                    aria-label={`${day.label} open`}
                  />
                  <span className="text-sm font-medium">{day.label}</span>
                </div>

                {businessHours[day.key] ? (
                  <div className="flex items-center gap-2 text-sm pl-10 sm:pl-0">
                    <TimePicker
                      value={businessHours[day.key]?.open || "09:00"}
                      onChange={(v) => updateDayHours(day.key, "open", v)}
                      className="w-[8rem]"
                      aria-label={`${day.label} open time`}
                    />
                    <span className="text-muted-foreground">to</span>
                    <TimePicker
                      value={businessHours[day.key]?.close || "17:00"}
                      onChange={(v) => updateDayHours(day.key, "close", v)}
                      className="w-[8rem]"
                      aria-label={`${day.label} close time`}
                    />
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground pl-10 sm:pl-0">Closed</span>
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
            <SelectTrigger className="w-full md:w-[300px]" aria-label="Default appointment duration">
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

          {/* Warning when "never" is selected in a jurisdiction that requires disclosure */}
          {recordingConsentMode === "never" && (
            country === "AU" || (country === "US" && businessState && TWO_PARTY_CONSENT_STATES.has(businessState))
          ) && (
            <Alert variant="destructive" className="border-amber-500/50 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-200 [&>svg]:text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                <span className="font-semibold">Legal risk: </span>
                {country === "AU"
                  ? "Australia requires all-party consent for call recording. Disabling the disclosure may violate the Telecommunications (Interception and Access) Act 1979."
                  : `${US_STATES.find((s) => s.code === businessState)?.name} is a two-party consent state. Disabling the disclosure may violate state wiretapping laws.`}
                {" "}Only disable this if you do not record calls or handle consent through a separate system before the AI answers.
              </AlertDescription>
            </Alert>
          )}

          {/* Custom disclosure text — shown when mode is not "never" */}
          {recordingConsentMode !== "never" && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Custom Disclosure Message (optional)</Label>
              <textarea
                value={disclosureText}
                onChange={(e) => setDisclosureText(e.target.value)}
                placeholder="Just so you know, this call may be recorded."
                rows={3}
                maxLength={500}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <p className="text-xs text-muted-foreground">
                Leave blank for the default: {'"'}Just so you know, this call may be recorded.{'"'} Use <code className="rounded bg-muted px-1 text-[11px]">{"{business_name}"}</code> to insert your business name.
                This short message plays before the AI greets the caller.
              </p>
            </div>
          )}
        </div>

        <Separator />

        {/* Customer Confirmation Messages (SCRUM-240 Phase 1) */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <div>
              <Label className="text-base font-medium">Customer Confirmation Messages</Label>
              <p className="text-sm text-muted-foreground">
                When enabled, we automatically text customers a booking confirmation (and a cancellation notice) after your AI receptionist books or cancels an appointment. Gives them a chance to catch mistakes before they arrive.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Send confirmation texts</Label>
              <p className="text-xs text-muted-foreground">
                Recommended. Turn off only if you have your own confirmation system.
              </p>
            </div>
            <Switch
              checked={sendCustomerConfirmations}
              onCheckedChange={setSendCustomerConfirmations}
              aria-label="Send customer confirmation texts"
            />
          </div>

          {/* SCRUM-260: Alphanumeric SMS sender — shown as the sender name on texts */}
          {sendCustomerConfirmations && (
            <div className="rounded-lg border p-4 space-y-2">
              <Label htmlFor="smsSender" className="text-sm font-medium">
                SMS sender name
              </Label>
              <p className="text-xs text-muted-foreground">
                What customers see as the sender when they receive a text. Up to 11 letters, numbers, and spaces — must contain at least one letter. Leave blank to send from your phone number instead.
              </p>
              <Input
                id="smsSender"
                value={smsSender}
                onChange={(e) => {
                  setSmsSender(e.target.value);
                  setSmsSenderError(null);
                }}
                placeholder="e.g. SmileHub"
                maxLength={11}
                className={smsSenderError ? "border-destructive" : ""}
              />
              {smsSenderError && (
                <p className="text-xs text-destructive">{smsSenderError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                <strong>Heads up:</strong> when sending with a sender name, customers can&apos;t reply to the text. Every text will say &quot;replies aren&apos;t monitored&quot; and point them at your phone or email instead.
              </p>
              <p className="text-xs text-muted-foreground">
                The contact that appears in every text (legal opt-out requirement): <strong>{phone || businessEmail || "not set"}</strong>. We prefer your phone if set, then your email. Set at least one in the Business Info section above.
              </p>
            </div>
          )}
        </div>

        <Separator />

        {/* Appointment Verification */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <div>
              <Label className="text-base font-medium">Appointment Lookup Verification</Label>
              <p className="text-sm text-muted-foreground">
                How callers verify their identity when checking, rescheduling, or cancelling appointments.
              </p>
            </div>
          </div>

          {/* Method selector */}
          <RadioGroup value={verificationMethod} onValueChange={setVerificationMethod}>
            {VERIFICATION_METHODS.map((m) => (
              <label
                key={m.id}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  verificationMethod === m.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <RadioGroupItem value={m.id} className="mt-0.5" />
                <div>
                  <span className="text-sm font-medium">{m.label}</span>
                  <p className="text-xs text-muted-foreground">{m.description}</p>
                </div>
              </label>
            ))}
          </RadioGroup>

          {/* Verification fields — shown for code_and_verify and details_only */}
          {verificationMethod !== "code_only" && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                {verificationMethod === "code_and_verify"
                  ? "Additional identity check (after code)"
                  : "Identity verification fields"}
              </Label>
              <p className="text-xs text-muted-foreground">
                {verificationMethod === "code_and_verify"
                  ? "After the caller provides their code, the AI will also ask for:"
                  : "The AI will ask callers for the following to verify their identity:"}
              </p>
              {VERIFICATION_FIELD_OPTIONS.map((field) => (
                <label
                  key={field.id}
                  className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    verificationFields.includes(field.id) ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                  }`}
                >
                  <Checkbox
                    checked={verificationFields.includes(field.id)}
                    onCheckedChange={(checked) => {
                      setVerificationFields((prev) => {
                        const next = checked === true
                          ? [...prev, field.id]
                          : prev.filter((f) => f !== field.id);
                        return next.length === 0 ? prev : next;
                      });
                    }}
                  />
                  <div className="flex-1">
                    <span className="text-sm font-medium">{field.label}</span>
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  </div>
                </label>
              ))}
            </div>
          )}

          {/* Explainer */}
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">How it works:</span>{" "}
              {verificationMethod === "code_and_verify" && (
                <>AI asks for confirmation code + {verificationFields.map((f) => VERIFICATION_FIELD_OPTIONS.find((o) => o.id === f)?.shortLabel || f).join(" + ")} before sharing appointment details.</>
              )}
              {verificationMethod === "code_only" && (
                <>AI asks for the 6-digit confirmation code only. No additional questions needed.</>
              )}
              {verificationMethod === "details_only" && (
                <>AI asks for {verificationFields.map((f) => VERIFICATION_FIELD_OPTIONS.find((o) => o.id === f)?.shortLabel || f).join(" + ")} to verify identity. No confirmation codes are used.</>
              )}
            </p>
          </div>
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
