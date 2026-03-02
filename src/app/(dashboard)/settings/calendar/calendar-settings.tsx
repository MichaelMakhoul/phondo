"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import {
  Calendar,
  Check,
  Loader2,
  ExternalLink,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { trackCalendarConnected, trackCalendarDisconnected } from "@/lib/analytics";

interface CalendarIntegration {
  id: string;
  calendar_id: string | null;
  booking_url: string | null;
  assistant_id: string | null;
  is_active: boolean;
  settings: Record<string, any>;
}

interface Assistant {
  id: string;
  name: string;
}

interface EventType {
  id: number;
  slug: string;
  title: string;
  length: number;
}

interface CalendarSettingsProps {
  organizationId: string;
  initialIntegration: CalendarIntegration | null;
  assistants: Assistant[];
}

export function CalendarSettings({
  organizationId,
  initialIntegration,
  assistants,
}: CalendarSettingsProps) {
  // API key is not passed from server - user must enter it fresh for security
  const [apiKey, setApiKey] = useState("");
  const [selectedEventType, setSelectedEventType] = useState(
    initialIntegration?.calendar_id || ""
  );
  const [selectedAssistant, setSelectedAssistant] = useState(
    initialIntegration?.assistant_id || "all"
  );
  const [bookingUrl, setBookingUrl] = useState(
    initialIntegration?.booking_url || ""
  );
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [isConnected, setIsConnected] = useState(!!initialIntegration?.is_active);
  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [accountInfo, setAccountInfo] = useState<{ username: string; email: string } | null>(null);

  const router = useRouter();
  const { toast } = useToast();

  // Test the API key and fetch event types
  const testConnection = async () => {
    if (!apiKey) {
      toast({
        variant: "destructive",
        title: "API Key Required",
        description: "Please enter your Cal.com API key first.",
      });
      return;
    }

    setIsTesting(true);
    try {
      const response = await fetch("/api/v1/calendar/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      const data = await response.json();

      if (data.success) {
        setAccountInfo(data.account);
        setEventTypes(data.eventTypes);
        toast({
          title: "Connection Successful",
          description: `Connected to Cal.com as ${data.account.username}`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Connection Failed",
          description: data.error || "Could not connect to Cal.com",
        });
      }
    } catch {
      toast({
        variant: "destructive",
        title: "Connection Error",
        description: "Failed to test connection. Please check your API key.",
      });
    } finally {
      setIsTesting(false);
    }
  };

  // Save the integration
  const saveIntegration = async () => {
    // API key required for new connections, optional for updates
    if (!apiKey && !isConnected) {
      toast({
        variant: "destructive",
        title: "API Key Required",
        description: "Please enter your Cal.com API key.",
      });
      return;
    }

    if (!selectedEventType) {
      toast({
        variant: "destructive",
        title: "Event Type Required",
        description: "Please select an event type for appointment booking.",
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/v1/calendar/integration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          apiKey: apiKey || undefined, // Only send if user entered a new key
          eventTypeId: selectedEventType,
          assistantId: selectedAssistant === "all" ? null : selectedAssistant,
          bookingUrl,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setIsConnected(true);
        trackCalendarConnected();
        toast({
          title: "Calendar Connected",
          description: "Your Cal.com integration is now active.",
        });
        router.refresh();
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to save integration.",
        });
      }
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save calendar integration.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Delete the integration
  const deleteIntegration = async () => {
    if (!confirm("Are you sure you want to disconnect Cal.com? Your AI will no longer be able to book appointments.")) {
      return;
    }

    setIsDeleting(true);
    try {
      const response = await fetch("/api/v1/calendar/integration", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });

      const data = await response.json();

      if (data.success) {
        setIsConnected(false);
        setApiKey("");
        setSelectedEventType("");
        setAccountInfo(null);
        setEventTypes([]);
        trackCalendarDisconnected();
        toast({
          title: "Calendar Disconnected",
          description: "Cal.com integration has been removed.",
        });
        router.refresh();
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to disconnect calendar.",
        });
      }
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to disconnect calendar integration.",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              <CardTitle>Cal.com Integration</CardTitle>
            </div>
            {isConnected && (
              <Badge variant="success" className="bg-green-100 text-green-800">
                <Check className="h-3 w-3 mr-1" />
                Connected
              </Badge>
            )}
          </div>
          <CardDescription>
            Connect your Cal.com account to enable automatic appointment booking
            during calls.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="apiKey">Cal.com API Key</Label>
            <div className="flex gap-2">
              <Input
                id="apiKey"
                type="password"
                placeholder={isConnected && !apiKey ? "API key configured (enter new key to update)" : "cal_live_..."}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={testConnection}
                disabled={isTesting || !apiKey}
              >
                {isTesting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {isTesting ? "Testing..." : "Test"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isConnected && !apiKey
                ? "Your API key is stored securely. Enter a new key to update it."
                : <>Get your API key from{" "}
                  <a
                    href="https://app.cal.com/settings/developer/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Cal.com Settings
                    <ExternalLink className="inline h-3 w-3 ml-1" />
                  </a>
                </>
              }
            </p>
          </div>

          {/* Account Info */}
          {accountInfo && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm">
                Connected as <strong>{accountInfo.username}</strong> (
                {accountInfo.email})
              </p>
            </div>
          )}

          {/* Event Type Selection */}
          {eventTypes.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="eventType">Event Type for Bookings</Label>
              <Select
                value={selectedEventType}
                onValueChange={setSelectedEventType}
              >
                <SelectTrigger id="eventType">
                  <SelectValue placeholder="Select an event type" />
                </SelectTrigger>
                <SelectContent>
                  {eventTypes.map((et) => (
                    <SelectItem key={et.id} value={et.id.toString()}>
                      {et.title} ({et.length} min)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This is the type of appointment your AI will book when callers
                request an appointment.
              </p>
            </div>
          )}

          {/* Assistant Selection */}
          {assistants.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="assistant">Link to Assistant (Optional)</Label>
              <Select
                value={selectedAssistant}
                onValueChange={setSelectedAssistant}
              >
                <SelectTrigger id="assistant">
                  <SelectValue placeholder="All assistants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All assistants</SelectItem>
                  {assistants.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Optionally link this calendar to a specific assistant. If not
                selected, all assistants can use this calendar.
              </p>
            </div>
          )}

          {/* Booking URL */}
          <div className="space-y-2">
            <Label htmlFor="bookingUrl">Public Booking URL (Optional)</Label>
            <Input
              id="bookingUrl"
              type="url"
              placeholder="https://cal.com/yourname/appointment"
              value={bookingUrl}
              onChange={(e) => setBookingUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Your public Cal.com booking URL. This can be shared with callers
              if they prefer to book online.
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-4">
            <Button
              onClick={saveIntegration}
              disabled={isLoading || !apiKey || !selectedEventType}
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : isConnected ? (
                "Update Integration"
              ) : (
                "Connect Calendar"
              )}
            </Button>

            {isConnected && (
              <Button
                variant="destructive"
                onClick={deleteIntegration}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* How It Works */}
      <Card>
        <CardHeader>
          <CardTitle>How It Works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
            <li>
              Connect your Cal.com account by entering your API key above.
            </li>
            <li>
              Select which event type should be used for appointment bookings.
            </li>
            <li>
              When callers ask to schedule an appointment, your AI receptionist
              will automatically check your calendar availability.
            </li>
            <li>
              The AI will collect the caller&apos;s information and book the
              appointment directly in your Cal.com calendar.
            </li>
            <li>
              Both you and the caller will receive confirmation notifications.
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
