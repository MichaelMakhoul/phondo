"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import {
  User, Phone, Mail, Clock, Calendar, FileText,
  Edit2, Check, Ban, CheckCircle, AlertTriangle,
  Loader2, ExternalLink, History,
} from "lucide-react";
import { describeChange } from "@/lib/calendar/appointment-lifecycle";
import type { AppointmentLabels } from "@/lib/calendar/industry-labels";

// SCRUM-397: bookings without a collected email get a synthetic placeholder
// (`booking-<uuid>@noreply.phondo.ai`). Never show it as if it were a real address.
const SYNTHETIC_EMAIL_DOMAIN = "@noreply.phondo.ai";
function isSyntheticEmail(email: string | null | undefined): boolean {
  return !!email && email.includes(SYNTHETIC_EMAIL_DOMAIN);
}

// SCRUM-397: neutral fallback until the API's industry-resolved labels arrive.
const DEFAULT_LABELS: AppointmentLabels = { practitioner: "Practitioner", service: "Service" };

// Statuses a user can set manually from the edit form. `rescheduled` is excluded —
// it's system-managed (set by the reschedule flow), not a manual choice.
const EDITABLE_STATUSES: { value: string; label: string }[] = [
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "no_show", label: "No Show" },
  { value: "cancelled", label: "Cancelled" },
];

// Radix Select can't use "" as a value; sentinel for "no practitioner/service".
const NONE_VALUE = "__none__";

// datetime-local <-> ISO helpers (browser-local, matching the panel's other times).
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}

interface AppointmentDetailPanelProps {
  appointmentId: string | null;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

interface ClientHistory {
  clientType: "new" | "returning" | "regular";
  totalAppointments: number;
  totalCalls: number;
  firstSeen: string | null;
  previousAppointments: { id: string; start_time: string; status: string; service_type_name: string | null }[];
}

// SCRUM-389: one leg of an appointment's reschedule lifecycle (booked → moved → …).
interface LifecycleLeg {
  id: string;
  status: string;
  startTime: string;
  bookedAt: string;
  supersededAt: string | null;
  channel: string;
  practitioner: string | null; // SCRUM-391
  serviceType: string | null;
  isCurrent: boolean;
}

const CHANNEL_LABELS: Record<string, string> = {
  voice: "AI Call",
  dashboard: "Dashboard",
  cal_com: "Cal.com",
  calendly: "Calendly",
  google_calendar: "Google Calendar",
};

const STATUS_COLORS: Record<string, string> = {
  confirmed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  completed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  no_show: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
  rescheduled: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

const CLIENT_TYPE_COLORS: Record<string, string> = {
  new: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  returning: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  regular: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
};

export function AppointmentDetailPanel({
  appointmentId,
  open,
  onClose,
  onUpdated,
}: AppointmentDetailPanelProps) {
  const [loading, setLoading] = useState(true);
  const [appointment, setAppointment] = useState<any>(null);
  const [clientHistory, setClientHistory] = useState<ClientHistory | null>(null);
  const [linkedCall, setLinkedCall] = useState<any>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleLeg[] | null>(null);
  const [labels, setLabels] = useState<AppointmentLabels>(DEFAULT_LABELS);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editData, setEditData] = useState<Record<string, any>>({});
  // SCRUM-397: snapshot of the values at edit-start, so save sends only what changed
  // (critical: re-sending an unchanged past start_time would 400 on the past-time guard).
  const [editInitial, setEditInitial] = useState<Record<string, any>>({});
  const [practitioners, setPractitioners] = useState<{ id: string; name: string }[]>([]);
  const [serviceTypes, setServiceTypes] = useState<{ id: string; name: string; duration_minutes: number }[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const { toast } = useToast();

  const fetchAppointment = useCallback(async () => {
    if (!appointmentId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/appointments/${appointmentId}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setAppointment(data.appointment);
      setClientHistory(data.clientHistory);
      setLinkedCall(data.linkedCall);
      setLifecycle(data.lifecycle ?? null);
      if (data.labels) setLabels(data.labels);
    } catch {
      toast({ title: "Error", description: "Failed to load appointment details", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [appointmentId, toast]);

  useEffect(() => {
    if (open && appointmentId) {
      fetchAppointment();
      setEditing(false);
    }
  }, [open, appointmentId, fetchAppointment]);

  // SCRUM-397: enter full edit mode — load the practitioner/service options and seed
  // the form (and the diff snapshot) from the current appointment. The synthetic
  // placeholder email is shown blank so the user isn't confused by it.
  const openEditor = async () => {
    if (!appt) return;
    const seed = {
      attendee_first_name: appt.attendee_first_name || appt.attendee_name?.split(" ")[0] || "",
      attendee_last_name: appt.attendee_last_name || appt.attendee_name?.split(" ").slice(1).join(" ") || "",
      attendee_phone: appt.attendee_phone || "",
      attendee_email: isSyntheticEmail(appt.attendee_email) ? "" : (appt.attendee_email || ""),
      notes: appt.notes || "",
      start_time: appt.start_time || "",
      service_type_id: appt.service_type_id ?? null,
      practitioner_id: appt.practitioner_id ?? null,
      status: appt.status || "confirmed",
    };
    setEditData(seed);
    setEditInitial(seed);
    setEditing(true);
    setOptionsLoading(true);
    // A non-OK response (401/500) does NOT throw — so track failure explicitly and
    // surface it, otherwise the dropdowns silently render empty and a user could
    // "tidy up" a blank Select into nulling a real practitioner/service assignment.
    let failed = false;
    try {
      const [pRes, sRes] = await Promise.all([
        fetch("/api/v1/practitioners"),
        fetch("/api/v1/service-types"),
      ]);
      if (pRes.ok) {
        const p = await pRes.json();
        setPractitioners(Array.isArray(p) ? p.map((x: any) => ({ id: x.id, name: x.name })) : []);
      } else {
        failed = true;
      }
      if (sRes.ok) {
        const s = await sRes.json();
        setServiceTypes(
          Array.isArray(s)
            ? s.map((x: any) => ({ id: x.id, name: x.name, duration_minutes: x.duration_minutes }))
            : []
        );
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    } finally {
      setOptionsLoading(false);
    }
    if (failed) {
      toast({
        title: "Couldn't load practitioner/service options",
        description: "Reopen the editor to try again before changing them.",
        variant: "destructive",
      });
    }
  };

  const closeEditor = () => {
    setEditing(false);
    setEditData({});
    setEditInitial({});
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!appointmentId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const label = newStatus === "no_show" ? "No Show" : newStatus.charAt(0).toUpperCase() + newStatus.slice(1);
      toast({ title: `Appointment marked as ${label}` });
      onUpdated();
      fetchAppointment();
    } catch {
      toast({ title: "Error", description: "Failed to update status", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!appointmentId) return;

    // SCRUM-397: send ONLY changed fields. Re-sending an unchanged value is at best
    // wasteful and at worst breaks (the route 400s if you PATCH a start_time in the
    // past, which an untouched older appointment would have).
    const payload: Record<string, any> = {};
    const keys = ["attendee_phone", "notes", "status"] as const;
    for (const k of keys) {
      if ((editData[k] ?? "") !== (editInitial[k] ?? "")) payload[k] = editData[k];
    }
    // Name is denormalized server-side into `attendee_name`, rebuilt from the PATCH
    // payload — so sending only one part drops the other from the display name. Send
    // BOTH parts together whenever either changes.
    const nameChanged =
      (editData.attendee_first_name ?? "") !== (editInitial.attendee_first_name ?? "") ||
      (editData.attendee_last_name ?? "") !== (editInitial.attendee_last_name ?? "");
    if (nameChanged) {
      payload.attendee_first_name = editData.attendee_first_name;
      payload.attendee_last_name = editData.attendee_last_name;
    }
    // Email: a cleared field saves as null (schema allows .email().nullable()).
    if ((editData.attendee_email ?? "") !== (editInitial.attendee_email ?? "")) {
      payload.attendee_email = editData.attendee_email?.trim() ? editData.attendee_email.trim() : null;
    }
    if ((editData.practitioner_id ?? null) !== (editInitial.practitioner_id ?? null)) {
      payload.practitioner_id = editData.practitioner_id ?? null;
    }
    if ((editData.service_type_id ?? null) !== (editInitial.service_type_id ?? null)) {
      payload.service_type_id = editData.service_type_id ?? null;
    }
    // Compare by instant, not raw string: the picker round-trips the timestamp format
    // ("…+00:00" → "…Z", minute precision), so a string compare would flag an untouched
    // time as changed and could trip the server's past-time guard on a re-save.
    const startChanged =
      !!editData.start_time &&
      new Date(editData.start_time).getTime() !== new Date(editInitial.start_time).getTime();
    if (startChanged) payload.start_time = editData.start_time;

    // Recompute end_time when the start or the service (hence duration) changed.
    if (startChanged || payload.service_type_id !== undefined) {
      const startIso = payload.start_time || appt.start_time;
      const svcId = editData.service_type_id ?? appt.service_type_id;
      const duration =
        serviceTypes.find((s) => s.id === svcId)?.duration_minutes ?? appt.duration_minutes ?? 30;
      if (startIso) {
        payload.end_time = new Date(new Date(startIso).getTime() + duration * 60000).toISOString();
        payload.duration_minutes = duration;
      }
    }

    if (Object.keys(payload).length === 0) {
      closeEditor();
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/v1/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save");
      }
      toast({ title: "Appointment updated" });
      closeEditor();
      onUpdated();
      fetchAppointment();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("en-AU", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  };

  const formatStatus = (status: string) => {
    const labels: Record<string, string> = {
      confirmed: "Confirmed", pending: "Pending", cancelled: "Cancelled",
      completed: "Completed", no_show: "No Show", rescheduled: "Rescheduled",
    };
    return labels[status] || status;
  };

  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleTimeString("en-AU", {
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  };

  const appt = appointment;
  const isActive = appt?.status === "confirmed" || appt?.status === "pending";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto px-6">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Appointment Details
          </SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !appt ? (
          <p className="text-center text-muted-foreground py-12">Appointment not found</p>
        ) : (
          <div className="space-y-6 mt-6">
            {/* Status + Time Header */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Badge className={STATUS_COLORS[appt.status] || ""}>
                  {formatStatus(appt.status)}
                </Badge>
                {appt.confirmation_code && (
                  <span className="text-xs text-muted-foreground font-mono">
                    Code: {appt.confirmation_code}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{formatDateTime(appt.start_time)}</span>
              </div>
              {appt.end_time && (
                <p className="text-xs text-muted-foreground ml-6">
                  Until {formatTime(appt.end_time)} ({appt.duration_minutes} min)
                </p>
              )}
              {appt.service_types?.name && (
                <p className="text-sm text-muted-foreground ml-6">{appt.service_types.name}</p>
              )}
              {appt.practitioners?.name && (
                <p className="text-sm text-muted-foreground ml-6">with {appt.practitioners.name}</p>
              )}
            </div>

            <Separator />

            {/* Client Info */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Client</h3>
                <div className="flex gap-2">
                  {clientHistory && (
                    <Badge className={CLIENT_TYPE_COLORS[clientHistory.clientType] || ""}>
                      {clientHistory.clientType === "new" ? "New Client" :
                       clientHistory.clientType === "returning" ? "Returning" : "Regular"}
                    </Badge>
                  )}
                  {!editing && isActive && (
                    <Button variant="ghost" size="sm" onClick={openEditor}>
                      <Edit2 className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                  )}
                </div>
              </div>

              {editing ? (
                <div className="space-y-3">
                  {/* Appointment details — SCRUM-397: correct what the AI got wrong */}
                  <div>
                    <Label className="text-xs">Date &amp; Time</Label>
                    <Input
                      type="datetime-local"
                      value={isoToLocalInput(editData.start_time)}
                      onChange={(e) =>
                        setEditData({
                          ...editData,
                          start_time: e.target.value ? localInputToIso(e.target.value) : editInitial.start_time,
                        })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">{labels.service}</Label>
                      <Select
                        value={editData.service_type_id ?? NONE_VALUE}
                        onValueChange={(v) =>
                          setEditData({ ...editData, service_type_id: v === NONE_VALUE ? null : v })
                        }
                        disabled={optionsLoading}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={optionsLoading ? "Loading…" : `Select ${labels.service.toLowerCase()}`} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>Unspecified</SelectItem>
                          {serviceTypes.map((s) => (
                            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">{labels.practitioner}</Label>
                      <Select
                        value={editData.practitioner_id ?? NONE_VALUE}
                        onValueChange={(v) =>
                          setEditData({ ...editData, practitioner_id: v === NONE_VALUE ? null : v })
                        }
                        disabled={optionsLoading}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={optionsLoading ? "Loading…" : `Any ${labels.practitioner.toLowerCase()}`} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>Any {labels.practitioner.toLowerCase()}</SelectItem>
                          {practitioners.map((p) => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Status</Label>
                    <Select value={editData.status} onValueChange={(v) => setEditData({ ...editData, status: v })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EDITABLE_STATUSES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Separator />

                  {/* Client details */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">First Name</Label>
                      <Input
                        value={editData.attendee_first_name || ""}
                        onChange={(e) => setEditData({ ...editData, attendee_first_name: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Last Name</Label>
                      <Input
                        value={editData.attendee_last_name || ""}
                        onChange={(e) => setEditData({ ...editData, attendee_last_name: e.target.value })}
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Phone</Label>
                    <Input
                      value={editData.attendee_phone || ""}
                      onChange={(e) => setEditData({ ...editData, attendee_phone: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Email</Label>
                    <Input
                      type="email"
                      placeholder="No email on file"
                      value={editData.attendee_email || ""}
                      onChange={(e) => setEditData({ ...editData, attendee_email: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Notes</Label>
                    <textarea
                      value={editData.notes || ""}
                      onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                      rows={3}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button variant="outline" size="sm" onClick={closeEditor}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={handleSaveEdit} disabled={saving}>
                      {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{appt.attendee_name || "Unknown"}</span>
                  </div>
                  {appt.attendee_phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <a href={`tel:${appt.attendee_phone}`} className="text-sm text-primary hover:underline">
                        {appt.attendee_phone}
                      </a>
                    </div>
                  )}
                  {appt.attendee_email && !isSyntheticEmail(appt.attendee_email) && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground truncate">{appt.attendee_email}</span>
                    </div>
                  )}
                  {appt.notes && (
                    <div className="flex items-start gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <span className="text-sm text-muted-foreground">{appt.notes}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Source Info */}
            {(appt.provider || linkedCall) && (
              <>
                <Separator />
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Source</h3>
                  <p className="text-xs text-muted-foreground">
                    Booked via {appt.provider === "internal" ? "AI Call" : appt.provider === "manual" ? "Dashboard" : appt.provider}
                  </p>
                  {linkedCall && (
                    <a
                      href={`/calls/${linkedCall.id}`}
                      className="flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View call transcript
                    </a>
                  )}
                </div>
              </>
            )}

            {/* Appointment History (reschedule lifecycle) — SCRUM-389 */}
            {lifecycle && lifecycle.length > 1 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">Appointment History</h3>
                  </div>
                  <ol className="space-y-3 pl-3">
                    {lifecycle.map((leg, i) => {
                      const isLast = i === lifecycle.length - 1;
                      // SCRUM-391: describe WHAT changed vs the previous leg (time /
                      // doctor / service), so a same-time doctor change reads "Doctor
                      // changed" instead of a confusing duplicate "Moved to <same time>".
                      const change = describeChange(leg, i > 0 ? lifecycle[i - 1] : null, labels);
                      return (
                        <li key={leg.id} className="relative pl-4">
                          {/* connector + dot */}
                          {!isLast && (
                            <span className="absolute left-0 top-3 h-full w-px bg-border" aria-hidden />
                          )}
                          <span
                            className={`absolute left-[-3px] top-1.5 h-2 w-2 rounded-full ring-2 ring-background ${
                              leg.isCurrent ? "bg-primary" : "bg-muted-foreground/40"
                            }`}
                            aria-hidden
                          />
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm">
                              <span className="font-medium">
                                {new Date(leg.startTime).toLocaleString("en-AU", {
                                  weekday: "short", day: "numeric", month: "short",
                                  hour: "numeric", minute: "2-digit", hour12: true,
                                })}
                              </span>
                              {leg.practitioner && (
                                <span className="text-muted-foreground"> · {leg.practitioner}</span>
                              )}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {leg.isCurrent && (
                                <span className="text-[10px] text-muted-foreground">Viewing</span>
                              )}
                              <Badge className={`text-[10px] h-5 ${STATUS_COLORS[leg.status] || ""}`}>
                                {formatStatus(leg.status)}
                              </Badge>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {change.label}
                            {" · "}
                            {new Date(change.at).toLocaleDateString("en-AU", { month: "short", day: "numeric" })}
                            {" · via "}
                            {CHANNEL_LABELS[leg.channel] || leg.channel}
                          </p>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              </>
            )}

            {/* Client History */}
            {clientHistory && clientHistory.previousAppointments.length > 1 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">
                      Visit History ({clientHistory.totalAppointments} appointments, {clientHistory.totalCalls} calls)
                    </h3>
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {clientHistory.previousAppointments
                      .filter((pa) => pa.id !== appt.id)
                      .slice(0, 5)
                      .map((pa) => (
                        <div key={pa.id} className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>
                            {new Date(pa.start_time).toLocaleDateString("en-AU", { month: "short", day: "numeric", year: "numeric" })}
                            {pa.service_type_name && ` — ${pa.service_type_name}`}
                          </span>
                          <Badge variant="outline" className="text-[10px] h-5">
                            {pa.status}
                          </Badge>
                        </div>
                      ))}
                  </div>
                </div>
              </>
            )}

            {/* Action Buttons */}
            {isActive && !editing && (
              <>
                <Separator />
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Actions</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline" size="sm"
                      onClick={() => handleStatusChange("completed")}
                      disabled={saving}
                    >
                      <CheckCircle className="h-3.5 w-3.5 mr-1" />
                      Complete
                    </Button>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => handleStatusChange("no_show")}
                      disabled={saving}
                    >
                      <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                      No Show
                    </Button>
                    <Button
                      variant="destructive" size="sm"
                      onClick={() => handleStatusChange("cancelled")}
                      disabled={saving}
                      className="col-span-2"
                    >
                      <Ban className="h-3.5 w-3.5 mr-1" />
                      Cancel Appointment
                    </Button>
                  </div>
                </div>
              </>
            )}

            {/* Undo — revert to confirmed for non-active statuses. SCRUM-388: NOT for
                a `rescheduled` row — its slot was moved to a separate live row, so
                reverting it would re-create a duplicate booking. */}
            {!isActive && !editing && appt.status !== "confirmed" && appt.status !== "rescheduled" && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    This appointment is marked as <span className="font-medium">{formatStatus(appt.status)}</span>.
                  </p>
                  <Button
                    variant="outline" size="sm" className="w-full"
                    onClick={() => handleStatusChange("confirmed")}
                    disabled={saving}
                  >
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Revert to Confirmed
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
