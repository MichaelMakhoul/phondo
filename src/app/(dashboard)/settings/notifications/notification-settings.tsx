"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Mail, MessageSquare, Webhook, Phone, ArrowUpRight } from "lucide-react";
import { trackNotificationPrefsUpdated } from "@/lib/analytics";

interface NotificationPreferences {
  email_on_missed_call: boolean;
  email_on_voicemail: boolean;
  email_on_appointment_booked: boolean;
  email_on_callback_scheduled: boolean;
  email_daily_summary: boolean;
  sms_on_missed_call: boolean;
  sms_on_voicemail: boolean;
  sms_on_callback_scheduled: boolean;
  sms_phone_number: string | null;
  webhook_url: string | null;
  sms_textback_on_missed_call: boolean;
  sms_appointment_confirmation: boolean;
}

interface NotificationSettingsProps {
  organizationId: string;
  initialPreferences: NotificationPreferences | null;
  userEmail?: string;
  smsCallerEnabled: boolean;
}

export function NotificationSettings({
  organizationId,
  initialPreferences,
  userEmail,
  smsCallerEnabled,
}: NotificationSettingsProps) {
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    email_on_missed_call: initialPreferences?.email_on_missed_call ?? true,
    email_on_voicemail: initialPreferences?.email_on_voicemail ?? true,
    email_on_appointment_booked: initialPreferences?.email_on_appointment_booked ?? true,
    email_on_callback_scheduled: initialPreferences?.email_on_callback_scheduled ?? true,
    email_daily_summary: initialPreferences?.email_daily_summary ?? true,
    sms_on_missed_call: initialPreferences?.sms_on_missed_call ?? false,
    sms_on_voicemail: initialPreferences?.sms_on_voicemail ?? false,
    sms_on_callback_scheduled: initialPreferences?.sms_on_callback_scheduled ?? false,
    sms_phone_number: initialPreferences?.sms_phone_number ?? "",
    webhook_url: initialPreferences?.webhook_url ?? "",
    sms_textback_on_missed_call: initialPreferences?.sms_textback_on_missed_call ?? false,
    sms_appointment_confirmation: initialPreferences?.sms_appointment_confirmation ?? false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (preferences.sms_phone_number) {
      const digits = preferences.sms_phone_number.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) {
        newErrors.sms_phone_number = "Enter a valid phone number (7-15 digits)";
      }
    }

    // Require SMS phone when SMS toggles are on
    if ((preferences.sms_on_missed_call || preferences.sms_on_voicemail || preferences.sms_on_callback_scheduled) && !preferences.sms_phone_number) {
      newErrors.sms_phone_number = "Phone number is required when SMS notifications are enabled";
    }

    if (preferences.webhook_url) {
      try {
        const url = new URL(preferences.webhook_url);
        if (!["http:", "https:"].includes(url.protocol)) {
          newErrors.webhook_url = "URL must start with http:// or https://";
        }
      } catch {
        newErrors.webhook_url = "Enter a valid URL (e.g. https://example.com/webhook)";
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

  const handleToggle = (key: keyof NotificationPreferences) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleInputChange = (key: keyof NotificationPreferences, value: string) => {
    setPreferences((prev) => ({
      ...prev,
      [key]: value || null,
    }));
  };

  const handleSave = async () => {
    if (!validate()) return;
    setIsSaving(true);

    try {
      const response = await fetch("/api/v1/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save notification settings.");
      }

      const result = await response.json();

      // If fields were downgraded due to plan, update local state to reflect reality
      if (result.smsFieldsDowngraded) {
        setPreferences((prev) => ({
          ...prev,
          sms_textback_on_missed_call: false,
          sms_appointment_confirmation: false,
        }));
      }
      if (result.webhookDowngraded) {
        setPreferences((prev) => ({ ...prev, webhook_url: null }));
      }

      const downgraded = result.smsFieldsDowngraded || result.webhookDowngraded;
      trackNotificationPrefsUpdated();
      toast({
        title: "Settings saved",
        description: downgraded
          ? "Saved. Some features require a Professional or Business plan."
          : "Your notification preferences have been updated.",
      });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to save notification settings.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Email Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Email Notifications
          </CardTitle>
          <CardDescription>
            Notifications will be sent to {userEmail || "your account email"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Missed Calls</Label>
              <p className="text-sm text-muted-foreground">
                Get notified when a caller hangs up without speaking to your AI
              </p>
            </div>
            <Switch
              checked={preferences.email_on_missed_call}
              onCheckedChange={() => handleToggle("email_on_missed_call")}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Voicemails</Label>
              <p className="text-sm text-muted-foreground">
                Receive voicemail transcripts and audio links via email
              </p>
            </div>
            <Switch
              checked={preferences.email_on_voicemail}
              onCheckedChange={() => handleToggle("email_on_voicemail")}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Appointment Bookings</Label>
              <p className="text-sm text-muted-foreground">
                Get notified when your AI books a new appointment
              </p>
            </div>
            <Switch
              checked={preferences.email_on_appointment_booked}
              onCheckedChange={() => handleToggle("email_on_appointment_booked")}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Callback Requests</Label>
              <p className="text-sm text-muted-foreground">
                Get notified when a caller requests a callback
              </p>
            </div>
            <Switch
              checked={preferences.email_on_callback_scheduled}
              onCheckedChange={() => handleToggle("email_on_callback_scheduled")}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Daily Summary</Label>
              <p className="text-sm text-muted-foreground">
                Receive a daily digest of all calls and key metrics
              </p>
            </div>
            <Switch
              checked={preferences.email_daily_summary}
              onCheckedChange={() => handleToggle("email_daily_summary")}
            />
          </div>
        </CardContent>
      </Card>

      {/* SMS Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            SMS Notifications
          </CardTitle>
          <CardDescription>
            Get instant text alerts for important events
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="smsPhone">Phone Number for SMS</Label>
            <Input
              id="smsPhone"
              type="tel"
              placeholder="(555) 123-4567"
              value={preferences.sms_phone_number || ""}
              onChange={(e) => { handleInputChange("sms_phone_number", e.target.value); clearError("sms_phone_number"); }}
              className={errors.sms_phone_number ? "border-destructive" : ""}
            />
            {errors.sms_phone_number ? (
              <p className="text-xs text-destructive">{errors.sms_phone_number}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Standard messaging rates may apply
              </p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Missed Calls</Label>
              <p className="text-sm text-muted-foreground">
                Get a text when you miss a call
              </p>
            </div>
            <Switch
              checked={preferences.sms_on_missed_call}
              onCheckedChange={() => handleToggle("sms_on_missed_call")}
              disabled={!preferences.sms_phone_number}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Voicemails</Label>
              <p className="text-sm text-muted-foreground">
                Receive text alerts for new voicemails
              </p>
            </div>
            <Switch
              checked={preferences.sms_on_voicemail}
              onCheckedChange={() => handleToggle("sms_on_voicemail")}
              disabled={!preferences.sms_phone_number}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Callback Requests</Label>
              <p className="text-sm text-muted-foreground">
                Get a text when a caller requests a callback
              </p>
            </div>
            <Switch
              checked={preferences.sms_on_callback_scheduled}
              onCheckedChange={() => handleToggle("sms_on_callback_scheduled")}
              disabled={!preferences.sms_phone_number}
            />
          </div>
        </CardContent>
      </Card>

      {/* Caller SMS — messages sent to callers */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Caller SMS
          </CardTitle>
          <CardDescription>
            Automatically text callers from your AI receptionist&apos;s phone number.
            Callers can reply STOP at any time to opt out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!smsCallerEnabled && (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                Caller SMS notifications are available on Professional and Business plans.{" "}
                <a href="/billing" className="inline-flex items-center font-medium underline underline-offset-2">
                  Upgrade <ArrowUpRight className="ml-0.5 h-3 w-3" />
                </a>
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className={!smsCallerEnabled ? "text-muted-foreground" : ""}>
                Missed Call Text-Back
              </Label>
              <p className="text-sm text-muted-foreground">
                Send an SMS to callers when their call is missed, with your booking link and callback number
              </p>
            </div>
            <Switch
              checked={preferences.sms_textback_on_missed_call}
              onCheckedChange={() => handleToggle("sms_textback_on_missed_call")}
              disabled={!smsCallerEnabled}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className={!smsCallerEnabled ? "text-muted-foreground" : ""}>
                Appointment Confirmation
              </Label>
              <p className="text-sm text-muted-foreground">
                Send callers an SMS confirming their appointment after the AI books it
              </p>
            </div>
            <Switch
              checked={preferences.sms_appointment_confirmation}
              onCheckedChange={() => handleToggle("sms_appointment_confirmation")}
              disabled={!smsCallerEnabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Webhook Integration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="h-5 w-5" />
            Webhook Integration
          </CardTitle>
          <CardDescription>
            Send real-time notifications to your own server or apps
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webhookUrl">Webhook URL</Label>
            <Input
              id="webhookUrl"
              type="url"
              placeholder="https://your-server.com/webhook"
              value={preferences.webhook_url || ""}
              onChange={(e) => { handleInputChange("webhook_url", e.target.value); clearError("webhook_url"); }}
              className={errors.webhook_url ? "border-destructive" : ""}
            />
            {errors.webhook_url ? (
              <p className="text-xs text-destructive">{errors.webhook_url}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                We&apos;ll send POST requests with JSON payload for all call events
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  );
}
