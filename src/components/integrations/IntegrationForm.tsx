"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Copy, AlertTriangle } from "lucide-react";
import { trackWebhookCreated } from "@/lib/analytics";
import { SUPPORTED_PLATFORMS, INTEGRATION_EVENTS } from "@/lib/integrations/types";

interface IntegrationFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export function IntegrationForm({ open, onOpenChange, onCreated }: IntegrationFormProps) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState("webhook");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["call.completed"]);
  const [isCreating, setIsCreating] = useState(false);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const { toast } = useToast();

  const toggleEvent = (event: string) => {
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
  };

  const handleCreate = async () => {
    if (!name.trim() || !webhookUrl.trim() || events.length === 0) return;
    setIsCreating(true);

    try {
      const response = await fetch("/api/v1/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, platform, webhook_url: webhookUrl, events }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to create integration");
      }

      const data = await response.json();
      setSigningSecret(data.signing_secret);
      trackWebhookCreated();
      onCreated();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create integration",
      });
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    setName("");
    setPlatform("webhook");
    setWebhookUrl("");
    setEvents(["call.completed"]);
    setSigningSecret(null);
    onOpenChange(false);
  };

  const copySecret = () => {
    if (signingSecret) {
      navigator.clipboard.writeText(signingSecret);
      toast({ title: "Copied!", description: "Signing secret copied to clipboard" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        {signingSecret ? (
          <>
            <DialogHeader>
              <DialogTitle>Integration Created</DialogTitle>
              <DialogDescription>
                Save your signing secret — you won&apos;t be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="rounded-lg bg-muted p-4">
                <Label className="text-xs text-muted-foreground">Signing Secret</Label>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <code className="text-sm font-mono break-all">{signingSecret}</code>
                  <Button variant="ghost" size="icon" onClick={copySecret} className="shrink-0">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm text-amber-600">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Use this secret to verify webhook signatures on your server.
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add Integration</DialogTitle>
              <DialogDescription>
                Send call data to an external service via webhook.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="int-name">Name</Label>
                <Input
                  id="int-name"
                  placeholder="e.g., My Zapier Hook"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Platform</Label>
                <Select value={platform} onValueChange={setPlatform}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPORTED_PLATFORMS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="int-url">Webhook URL</Label>
                <Input
                  id="int-url"
                  type="url"
                  placeholder="https://hooks.zapier.com/hooks/catch/..."
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Events</Label>
                <div className="space-y-2">
                  {INTEGRATION_EVENTS.map((evt) => (
                    <div key={evt.value} className="flex items-center gap-2">
                      <Checkbox
                        id={`event-${evt.value}`}
                        checked={events.includes(evt.value)}
                        onCheckedChange={() => toggleEvent(evt.value)}
                      />
                      <label
                        htmlFor={`event-${evt.value}`}
                        className="text-sm cursor-pointer"
                      >
                        {evt.label}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={isCreating || !name.trim() || !webhookUrl.trim() || events.length === 0}
              >
                {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
