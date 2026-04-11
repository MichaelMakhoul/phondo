"use client";

import { useState, useEffect } from "react";
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
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Plus, Trash2, Clock, AlertTriangle } from "lucide-react";

interface BlockedTime {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  all_day: boolean;
  reason: string | null;
  practitioner_id: string | null;
}

interface Practitioner {
  id: string;
  name: string;
  title: string | null;
}

interface ConflictingAppointment {
  id: string;
  attendee_name: string;
  start_time: string;
  confirmation_code: string | null;
}

export function BlockedTimesCard() {
  const [blocks, setBlocks] = useState<BlockedTime[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [conflicts, setConflicts] = useState<ConflictingAppointment[]>([]);
  const [practitioners, setPractitioners] = useState<Practitioner[]>([]);
  const [selectedPractitioner, setSelectedPractitioner] = useState<string>("");

  // Form state
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [allDay, setAllDay] = useState(false);
  const [reason, setReason] = useState("");

  const { toast } = useToast();

  const fetchBlocks = async () => {
    try {
      const res = await fetch("/api/v1/blocked-times");
      if (res.ok) setBlocks(await res.json());
    } catch {
      // Silent fail on load
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchBlocks(); }, []);

  useEffect(() => {
    fetch("/api/v1/practitioners").then(r => r.ok ? r.json() : []).then(data => {
      setPractitioners(Array.isArray(data) ? data : data.practitioners || []);
    }).catch(() => {});
  }, []);

  const handleAdd = async () => {
    if (!title.trim() || !date) {
      toast({ title: "Missing fields", description: "Title and date are required.", variant: "destructive" });
      return;
    }

    setAdding(true);
    try {
      const startISO = allDay
        ? new Date(`${date}T00:00:00`).toISOString()
        : new Date(`${date}T${startTime}:00`).toISOString();
      const endISO = allDay
        ? new Date(`${date}T23:59:59`).toISOString()
        : new Date(`${date}T${endTime}:00`).toISOString();

      const res = await fetch("/api/v1/blocked-times", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          startTime: startISO,
          endTime: endISO,
          allDay,
          reason: reason.trim() || undefined,
          practitionerId: selectedPractitioner || null,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create");
      }

      const { block, conflicts: newConflicts, conflictCount } = await res.json();
      setBlocks((prev) => [...prev, block].sort((a, b) => a.start_time.localeCompare(b.start_time)));
      setShowForm(false);
      setTitle("");
      setDate("");
      setReason("");
      setAllDay(false);
      setSelectedPractitioner("");

      if (conflictCount > 0) {
        setConflicts(newConflicts);
        toast({
          title: `Time blocked — ${conflictCount} existing appointment${conflictCount > 1 ? "s" : ""}`,
          description: "Some appointments fall within this blocked time. You may want to reschedule them.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Time blocked", description: `${title} has been added.` });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/blocked-times?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      setBlocks((prev) => prev.filter((b) => b.id !== id));
      toast({ title: "Block removed" });
    } catch {
      toast({ title: "Error", description: "Failed to remove block", variant: "destructive" });
    }
  };

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("en-AU", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString("en-AU", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Blocked Times
            </CardTitle>
            <CardDescription>
              Block times when no appointments should be booked (holidays, breaks, meetings).
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="mr-1 h-4 w-4" />
            Block Time
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add form */}
        {showForm && (
          <div className="rounded-lg border p-4 space-y-3 bg-muted/30">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Title</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Staff training, Public holiday, Lunch break"
                />
              </div>
              <div>
                <Label>Date</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={(e) => setAllDay(e.target.checked)}
                    className="h-4 w-4 rounded border-input"
                  />
                  <span className="text-sm">All day</span>
                </label>
              </div>
              {!allDay && (
                <>
                  <div>
                    <Label>Start Time</Label>
                    <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </div>
                  <div>
                    <Label>End Time</Label>
                    <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                  </div>
                </>
              )}
              {practitioners.length > 0 && (
                <div className="col-span-2">
                  <Label>Applies to</Label>
                  <select
                    value={selectedPractitioner}
                    onChange={(e) => setSelectedPractitioner(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">All staff (org-wide)</option>
                    {practitioners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.title ? ` — ${p.title}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="col-span-2">
                <Label>Reason (optional)</Label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g., Annual leave, equipment maintenance"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAdd} disabled={adding}>
                {adding && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Block Time
              </Button>
            </div>
          </div>
        )}

        {/* Conflicts warning */}
        {conflicts.length > 0 && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  {conflicts.length} existing appointment{conflicts.length > 1 ? "s" : ""} affected
                </p>
                <ul className="text-xs text-amber-800 dark:text-amber-300 mt-1 space-y-1">
                  {conflicts.map((c) => (
                    <li key={c.id}>
                      {c.attendee_name || "Unknown"} — {formatDateTime(c.start_time)}
                      {c.confirmation_code && ` (${c.confirmation_code})`}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
                  These appointments will not be automatically cancelled. Contact the callers to reschedule.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-6 text-xs text-amber-700"
                  onClick={() => setConflicts([])}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Block list */}
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No blocked times. Your AI receptionist can book any available slot.
          </p>
        ) : (
          <div className="space-y-2">
            {blocks.map((block) => (
              <div key={block.id} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <span className="text-sm font-medium">{block.title}</span>
                  {block.practitioner_id && (
                    <span className="ml-2 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {practitioners.find(p => p.id === block.practitioner_id)?.name || "Staff member"}
                    </span>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {block.all_day
                      ? formatDate(block.start_time)
                      : `${formatDateTime(block.start_time)} — ${formatDateTime(block.end_time)}`}
                  </p>
                  {block.reason && (
                    <p className="text-xs text-muted-foreground mt-0.5">{block.reason}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDelete(block.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
