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
import { useToast } from "@/components/ui/use-toast";
import {
  User, Phone, Mail, Clock, Calendar, FileText,
  Edit2, X, Check, Ban, CheckCircle, AlertTriangle,
  Loader2, ExternalLink, History,
} from "lucide-react";

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
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editData, setEditData] = useState<Record<string, any>>({});
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
      toast({ title: `Appointment ${newStatus}` });
      onUpdated();
      fetchAppointment();
    } catch {
      toast({ title: "Error", description: "Failed to update status", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!appointmentId || Object.keys(editData).length === 0) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editData),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save");
      }
      toast({ title: "Appointment updated" });
      setEditing(false);
      setEditData({});
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

  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleTimeString("en-AU", {
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  };

  const appt = appointment;
  const isActive = appt?.status === "confirmed" || appt?.status === "pending";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
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
                  {appt.status.replace("_", " ")}
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
                    <Button variant="ghost" size="sm" onClick={() => {
                      setEditing(true);
                      setEditData({
                        attendee_first_name: appt.attendee_first_name || appt.attendee_name?.split(" ")[0] || "",
                        attendee_last_name: appt.attendee_last_name || appt.attendee_name?.split(" ").slice(1).join(" ") || "",
                        attendee_phone: appt.attendee_phone || "",
                        attendee_email: appt.attendee_email || "",
                        notes: appt.notes || "",
                      });
                    }}>
                      <Edit2 className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                  )}
                </div>
              </div>

              {editing ? (
                <div className="space-y-3">
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
                    <Button variant="outline" size="sm" onClick={() => { setEditing(false); setEditData({}); }}>
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
                  {appt.attendee_email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">{appt.attendee_email}</span>
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
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
