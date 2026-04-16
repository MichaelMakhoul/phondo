"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import {
  Search, Plus, User, Phone, Calendar, Clock, Loader2, ChevronLeft, ChevronRight,
} from "lucide-react";
import { AppointmentDetailPanel } from "../calendar/appointment-detail-panel";

interface ServiceType {
  id: string;
  name: string;
  duration_minutes: number;
}

interface Practitioner {
  id: string;
  name: string;
  title: string | null;
}

interface Appointment {
  id: string;
  attendee_name: string;
  attendee_phone: string | null;
  start_time: string;
  status: string;
  confirmation_code: string | null;
  provider: string;
  service_types: { name: string } | null;
  practitioners: { name: string } | null;
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  completed: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  no_show: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
};

interface Props {
  serviceTypes: ServiceType[];
  practitioners: Practitioner[];
}

export function AppointmentsList({ serviceTypes, practitioners }: Props) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();

  // Create form state
  const [newAppt, setNewAppt] = useState({
    first_name: "", last_name: "", phone: "", email: "",
    start_time: "", service_type_id: "", practitioner_id: "", notes: "",
  });

  const fetchAppointments = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: "20",
        ...(search && { search }),
        ...(statusFilter !== "all" && { status: statusFilter }),
      });
      const res = await fetch(`/api/v1/appointments?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setAppointments(data.appointments);
      setTotal(data.total);
    } catch {
      toast({ title: "Error loading appointments", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, toast]);

  useEffect(() => { fetchAppointments(); }, [fetchAppointments]);

  // Debounce search
  const [searchDebounced, setSearchDebounced] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDebounced), 300);
    return () => clearTimeout(timer);
  }, [searchDebounced]);

  const handleCreate = async () => {
    if (!newAppt.first_name || !newAppt.phone || !newAppt.start_time) {
      toast({ title: "Missing fields", description: "First name, phone, and date/time are required", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const selectedService = serviceTypes.find((s) => s.id === newAppt.service_type_id);
      const res = await fetch("/api/v1/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: newAppt.first_name,
          last_name: newAppt.last_name || undefined,
          phone: newAppt.phone,
          email: newAppt.email || undefined,
          start_time: new Date(newAppt.start_time).toISOString(),
          duration_minutes: selectedService?.duration_minutes || 30,
          service_type_id: newAppt.service_type_id || undefined,
          practitioner_id: newAppt.practitioner_id || undefined,
          notes: newAppt.notes || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create");
      }
      toast({ title: "Appointment created" });
      setShowCreateForm(false);
      setNewAppt({ first_name: "", last_name: "", phone: "", email: "", start_time: "", service_type_id: "", practitioner_id: "", notes: "" });
      fetchAppointments();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("en-AU", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  };

  const totalPages = Math.ceil(total / 20);

  return (
    <>
      {/* Search + Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, phone, or code..."
            value={searchDebounced}
            onChange={(e) => setSearchDebounced(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Active</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="no_show">No Show</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreateForm(!showCreateForm)}>
          <Plus className="h-4 w-4 mr-1" /> New Appointment
        </Button>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Appointment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">First Name *</Label>
                <Input value={newAppt.first_name} onChange={(e) => setNewAppt({ ...newAppt, first_name: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs">Last Name</Label>
                <Input value={newAppt.last_name} onChange={(e) => setNewAppt({ ...newAppt, last_name: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs">Phone *</Label>
                <Input value={newAppt.phone} onChange={(e) => setNewAppt({ ...newAppt, phone: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs">Email</Label>
                <Input value={newAppt.email} onChange={(e) => setNewAppt({ ...newAppt, email: e.target.value })} />
              </div>
              <div>
                <Label className="text-xs">Date & Time *</Label>
                <Input type="datetime-local" value={newAppt.start_time} onChange={(e) => setNewAppt({ ...newAppt, start_time: e.target.value })} />
              </div>
              {serviceTypes.length > 0 && (
                <div>
                  <Label className="text-xs">Service Type</Label>
                  <Select value={newAppt.service_type_id} onValueChange={(v) => setNewAppt({ ...newAppt, service_type_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {serviceTypes.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name} ({s.duration_minutes}m)</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {practitioners.length > 0 && (
                <div>
                  <Label className="text-xs">Practitioner</Label>
                  <Select value={newAppt.practitioner_id} onValueChange={(v) => setNewAppt({ ...newAppt, practitioner_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {practitioners.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="col-span-2">
                <Label className="text-xs">Notes</Label>
                <Input value={newAppt.notes} onChange={(e) => setNewAppt({ ...newAppt, notes: e.target.value })} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowCreateForm(false)}>Cancel</Button>
              <Button size="sm" onClick={handleCreate} disabled={creating}>
                {creating && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                Create
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Appointments Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : appointments.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">
              {search ? "No appointments match your search." : "No appointments yet."}
            </p>
          ) : (
            <div className="divide-y">
              {appointments.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-start gap-3 p-4 cursor-pointer hover:bg-muted/30 transition-colors sm:items-center sm:gap-4"
                  onClick={() => { setDetailId(appt.id); setDetailOpen(true); }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">{appt.attendee_name}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                      {appt.attendee_phone && (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{appt.attendee_phone}</span>
                        </div>
                      )}
                      {appt.service_types?.name && (
                        <span className="text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-none">{appt.service_types.name}</span>
                      )}
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        <span>{formatDateTime(appt.start_time)}</span>
                      </div>
                      {appt.practitioners?.name && (
                        <span className="text-xs text-muted-foreground">with {appt.practitioners.name}</span>
                      )}
                    </div>
                  </div>
                  <Badge className={`shrink-0 ${STATUS_COLORS[appt.status] || ""}`}>
                    {appt.status.replace("_", " ")}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t p-4">
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({total} total)
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail Panel */}
      <AppointmentDetailPanel
        appointmentId={detailId}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailId(null); }}
        onUpdated={fetchAppointments}
      />
    </>
  );
}
