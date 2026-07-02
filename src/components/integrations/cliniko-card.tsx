"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { ArrowUpRight, CalendarCheck2, Loader2, RefreshCw, Unplug } from "lucide-react";

interface ClinikoStatus {
  connected: boolean;
  canConnect: boolean;
  active?: boolean;
  business?: { id: string; name: string } | null;
  keyLast4?: string | null;
  lastSyncedAt?: string | null;
  errorState?: string | null;
  counts?: { practitioners: number; serviceTypes: number };
}

interface BusinessOption {
  id: string;
  name: string;
}

/**
 * Cliniko connect card (SCRUM-12). States: loading → gated (upgrade) →
 * disconnected (key paste) → business picker (multi-location) → connected
 * (sync/disconnect) with an error banner when the stored key stops working.
 */
export function ClinikoCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<ClinikoStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState<string>("");
  const [busy, setBusy] = useState<"connect" | "pick" | "sync" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/integrations/cliniko");
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as ClinikoStatus);
    } catch {
      setStatus(null);
      setFormError("Couldn't load the Cliniko connection status. Refresh the page to try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleConnect() {
    setBusy("connect");
    setFormError(null);
    try {
      const res = await fetch("/api/v1/integrations/cliniko", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFormError(body.error || "Couldn't connect to Cliniko.");
        return;
      }
      setApiKey("");
      if (body.active) {
        toast({
          title: "Cliniko connected",
          description: body.syncError
            ? body.syncError
            : `Imported ${body.sync?.practitionersUpserted ?? 0} practitioners and ${body.sync?.serviceTypesUpserted ?? 0} appointment types.`,
        });
        setBusinesses([]);
        await refresh();
      } else {
        // Multi-location account — pick which diary the AI books into.
        setBusinesses(body.businesses || []);
        setSelectedBusiness("");
        await refresh();
      }
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handlePickBusiness() {
    if (!selectedBusiness) return;
    setBusy("pick");
    setFormError(null);
    try {
      const res = await fetch("/api/v1/integrations/cliniko", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId: selectedBusiness }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFormError(body.error || "Couldn't select that location.");
        return;
      }
      toast({ title: "Cliniko connected", description: `Booking into ${body.business?.name}.` });
      setBusinesses([]);
      await refresh();
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleSync() {
    setBusy("sync");
    try {
      const res = await fetch("/api/v1/integrations/cliniko/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        toast({ title: "Sync failed", description: body.error, variant: "destructive" });
      } else {
        toast({
          title: "Catalog synced",
          description: `${body.sync.practitionersUpserted} practitioners, ${body.sync.serviceTypesUpserted} appointment types.`,
        });
      }
    } catch {
      toast({ title: "Sync failed", description: "Couldn't reach the server.", variant: "destructive" });
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function handleDisconnect() {
    setBusy("disconnect");
    try {
      const res = await fetch("/api/v1/integrations/cliniko", { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Disconnect failed", description: body.error, variant: "destructive" });
      } else {
        toast({ title: "Cliniko disconnected", description: "The AI is back on the built-in calendar." });
      }
    } catch {
      toast({ title: "Disconnect failed", description: "Couldn't reach the server.", variant: "destructive" });
    } finally {
      setBusy(null);
      setConfirmDisconnect(false);
      await refresh();
    }
  }

  const pickerOpen = !!status?.connected && !status?.active && businesses.length > 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarCheck2 className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <CardTitle className="text-base">Cliniko</CardTitle>
            {status?.connected && status.active && (
              <Badge variant={status.errorState ? "destructive" : "secondary"}>
                {status.errorState ? "Needs attention" : "Connected"}
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>
          Book appointments straight into your Cliniko diary — availability, new bookings, cancellations and
          reschedules all sync live.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-28" />
          </div>
        ) : !status?.canConnect && !status?.connected ? (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              The Cliniko integration is available on Professional and Business plans.{" "}
              <a href="/billing" className="inline-flex items-center font-medium underline underline-offset-2">
                Upgrade <ArrowUpRight className="ml-0.5 h-3 w-3" />
              </a>
            </p>
          </div>
        ) : !status?.connected ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cliniko-api-key">Cliniko API key</Label>
              <Input
                id="cliniko-api-key"
                type="password"
                autoComplete="off"
                placeholder="Paste your API key, including the -au1 style suffix"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={busy === "connect"}
              />
              <p className="text-xs text-muted-foreground">
                In Cliniko: My Info → Manage API keys → Add an API key.{" "}
                <a
                  href="https://help.cliniko.com/en/articles/1023957-generate-a-cliniko-api-key"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  Step-by-step guide
                </a>
              </p>
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <Button onClick={handleConnect} disabled={!apiKey.trim() || busy === "connect"}>
              {busy === "connect" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Connect Cliniko
            </Button>
          </div>
        ) : pickerOpen ? (
          <div className="space-y-3">
            <p className="text-sm">Your Cliniko account has multiple locations. Which one should the AI book into?</p>
            <RadioGroup value={selectedBusiness} onValueChange={setSelectedBusiness}>
              {businesses.map((b) => (
                <div key={b.id} className="flex items-center gap-2">
                  <RadioGroupItem value={b.id} id={`cliniko-biz-${b.id}`} />
                  <Label htmlFor={`cliniko-biz-${b.id}`}>{b.name}</Label>
                </div>
              ))}
            </RadioGroup>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <Button onClick={handlePickBusiness} disabled={!selectedBusiness || busy === "pick"}>
              {busy === "pick" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Use this location
            </Button>
          </div>
        ) : !status.active ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Cliniko is connected but not finished setting up. Reconnect with your API key to choose a location.
            </p>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            <Button variant="outline" onClick={() => setStatus({ connected: false, canConnect: true })}>
              Reconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {status.errorState === "auth_failed" && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
                <p className="text-sm text-red-800 dark:text-red-200">
                  Cliniko rejected the stored API key — the AI is taking messages instead of booking. Reconnect with a
                  fresh key to resume live booking.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setStatus({ connected: false, canConnect: true })}
                >
                  Enter a new key
                </Button>
              </div>
            )}
            {status.errorState === "sync_failed" && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  The last catalog sync failed. Bookings still work; use Sync now to refresh practitioners and
                  appointment types.
                </p>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Location</dt>
              <dd>{status.business?.name || "—"}</dd>
              <dt className="text-muted-foreground">API key</dt>
              <dd>••••{status.keyLast4 || ""}</dd>
              <dt className="text-muted-foreground">Practitioners</dt>
              <dd>{status.counts?.practitioners ?? 0}</dd>
              <dt className="text-muted-foreground">Appointment types</dt>
              <dd>{status.counts?.serviceTypes ?? 0}</dd>
              <dt className="text-muted-foreground">Last synced</dt>
              <dd>{status.lastSyncedAt ? new Date(status.lastSyncedAt).toLocaleString() : "Never"}</dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={handleSync} disabled={busy === "sync"}>
                {busy === "sync" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Sync now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy === "disconnect"}
              >
                <Unplug className="mr-2 h-4 w-4" />
                Disconnect
              </Button>
            </div>
          </div>
        )}

        <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect Cliniko?</DialogTitle>
              <DialogDescription>
                The AI will stop booking into your Cliniko diary and fall back to the built-in calendar. Imported
                practitioners and appointment types are deactivated (nothing is deleted), and existing appointments are
                untouched.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDisconnect(false)} disabled={busy === "disconnect"}>
                Keep connected
              </Button>
              <Button variant="destructive" onClick={handleDisconnect} disabled={busy === "disconnect"}>
                {busy === "disconnect" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
