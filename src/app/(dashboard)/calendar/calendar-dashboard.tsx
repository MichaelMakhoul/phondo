"use client";

import { useState, useMemo, useCallback } from "react";
import { AppointmentDetailPanel } from "./appointment-detail-panel";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CalendarDays,
  CalendarRange,
  CalendarCheck2,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Phone,
  Mail,
  FileText,
  X,
  Calendar as CalendarIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPhoneNumber } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { CalendarScene } from "@/components/ui/empty-state-scenes";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addMonths,
  subMonths,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  isToday,
  addDays,
  getDay,
} from "date-fns";

// --- Types ---

interface Appointment {
  id: string;
  organization_id: string;
  call_id: string | null;
  external_id: string | null;
  provider: string;
  event_type: string | null;
  start_time: string;
  end_time: string;
  attendee_name: string;
  attendee_email: string | null;
  attendee_phone: string | null;
  notes: string | null;
  status: "confirmed" | "cancelled" | "rescheduled" | "completed" | "no_show";
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

interface BusinessHours {
  [key: string]: { open: string; close: string } | null;
}

interface Stats {
  today: number;
  thisWeek: number;
  thisMonth: number;
}

type CalendarView = "days" | "months" | "years";

interface CalendarDashboardProps {
  initialAppointments: Appointment[];
  initialStats: Stats;
  businessHours: BusinessHours | null;
  timezone: string | null;
  businessName: string | null;
  calendarConnected: boolean;
}

// --- Helpers ---

const DAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_MAP: Record<number, string> = {
  0: "sunday",
  1: "monday",
  2: "tuesday",
  3: "wednesday",
  4: "thursday",
  5: "friday",
  6: "saturday",
};

function getVisibleDays(month: Date): Date[] {
  const weekOptions = { weekStartsOn: 1 as const };
  const start = startOfWeek(startOfMonth(month), weekOptions);
  const end = endOfWeek(endOfMonth(month), weekOptions);
  return eachDayOfInterval({ start, end });
}

function getBusinessHoursForDay(
  hours: BusinessHours | null,
  date: Date
): { open: string; close: string } | null {
  if (!hours) return null;
  const dayName = WEEKDAY_MAP[getDay(date)];
  return hours[dayName] ?? null;
}

function getStatusVariant(
  status: Appointment["status"]
): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "confirmed":
      return "success";
    case "cancelled":
      return "destructive";
    case "rescheduled":
      return "warning";
    case "completed":
      return "secondary";
    case "no_show":
      return "destructive";
    default:
      return "secondary";
  }
}

function formatTimeRange(startStr: string, endStr: string): string {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return `${format(start, "h:mm a")} - ${format(end, "h:mm a")}`;
}

function formatBusinessHoursTime(time: string): string {
  const [h, m] = time.split(":");
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${m} ${ampm}`;
}

function getAppointmentsForDate(
  appointments: Appointment[],
  date: Date
): Appointment[] {
  return appointments
    .filter((a) => isSameDay(new Date(a.start_time), date))
    .sort(
      (a, b) =>
        new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    );
}

// --- Component ---

export function CalendarDashboard({
  initialAppointments,
  initialStats,
  businessHours,
  timezone,
  businessName,
  calendarConnected,
}: CalendarDashboardProps) {
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [appointments, setAppointments] = useState<Appointment[]>(initialAppointments);
  const [stats, setStats] = useState<Stats>(initialStats);
  const [isLoading, setIsLoading] = useState(false);
  const [calendarView, setCalendarView] = useState<CalendarView>("days");
  const [detailApptId, setDetailApptId] = useState<string | null>(null);
  const [calBannerDismissed, setCalBannerDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("phondo:calendar-banner-dismissed") === "true";
  });
  const [detailOpen, setDetailOpen] = useState(false);
  const [yearRangeStart, setYearRangeStart] = useState(() => Math.floor(new Date().getFullYear() / 12) * 12);

  const visibleDays = useMemo(() => getVisibleDays(currentMonth), [currentMonth]);

  const selectedDayAppointments = useMemo(() => {
    if (!selectedDate) return [];
    return getAppointmentsForDate(appointments, selectedDate);
  }, [appointments, selectedDate]);

  const selectedDayHours = useMemo(() => {
    if (!selectedDate) return null;
    return getBusinessHoursForDay(businessHours, selectedDate);
  }, [businessHours, selectedDate]);

  // Count appointments per day for dot indicators
  const appointmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const appt of appointments) {
      if (appt.status === "cancelled") continue;
      const key = format(new Date(appt.start_time), "yyyy-MM-dd");
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [appointments]);

  // Upcoming appointments (next 7 days, confirmed/rescheduled)
  const upcomingAppointments = useMemo(() => {
    const now = new Date();
    const end = addDays(now, 7);
    return appointments
      .filter((a) => {
        const start = new Date(a.start_time);
        return (
          start >= now &&
          start <= end &&
          (a.status === "confirmed" || a.status === "rescheduled")
        );
      })
      .sort(
        (a, b) =>
          new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
      );
  }, [appointments]);

  async function goToMonth(targetMonth: Date) {
    setCurrentMonth(targetMonth);
    setCalendarView("days");
    setIsLoading(true);

    try {
      const monthParam = format(targetMonth, "yyyy-MM");
      const res = await fetch(
        `/api/v1/calendar/appointments?month=${monthParam}`
      );
      if (res.ok) {
        const data = await res.json();
        setAppointments(data.appointments);
        setStats(data.stats);
      } else {
        console.error(`Failed to fetch appointments: HTTP ${res.status}`);
      }
    } catch (error) {
      console.error("Failed to fetch appointments:", error);
    } finally {
      setIsLoading(false);
    }
  }

  const refreshCurrentMonth = useCallback(() => {
    goToMonth(currentMonth);
  }, [currentMonth]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Calendar</h1>
        <p className="text-muted-foreground">
          View your appointment schedule and business hours
        </p>
      </div>

      {/* Stats Row */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Today&apos;s Appointments
            </CardTitle>
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.today}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              This Week
            </CardTitle>
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.thisWeek}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              This Month
            </CardTitle>
            <CalendarCheck2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.thisMonth}</div>
          </CardContent>
        </Card>
      </div>

      {/* External calendar integration banner (optional — built-in booking works without it) */}
      {!calendarConnected && !calBannerDismissed && (
        <Card className="border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/50">
          <CardContent className="flex items-center gap-3 p-4">
            <CalendarCheck2 className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                External calendar sync (optional)
              </p>
              <p className="text-sm text-blue-600 dark:text-blue-400">
                Connect an external calendar for two-way sync with your existing scheduling tools.
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/scheduling">Connect</Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-blue-600 dark:text-blue-400"
              onClick={() => {
                setCalBannerDismissed(true);
                localStorage.setItem("phondo:calendar-banner-dismissed", "true");
              }}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Dismiss</span>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Two-column Grid: Calendar + Day Detail */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Month Calendar */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (calendarView === "years") {
                    setYearRangeStart((prev) => prev - 12);
                  } else if (calendarView === "months") {
                    setCurrentMonth(subMonths(currentMonth, 12));
                  } else {
                    goToMonth(subMonths(currentMonth, 1));
                  }
                }}
                disabled={isLoading}
                aria-label={
                  calendarView === "years"
                    ? "Previous 12 years"
                    : calendarView === "months"
                      ? "Previous year"
                      : "Previous month"
                }
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                className="text-lg font-semibold"
                onClick={() => {
                  if (calendarView === "days") {
                    setCalendarView("months");
                  } else if (calendarView === "months") {
                    setCalendarView("years");
                  } else {
                    setCalendarView("days");
                  }
                }}
              >
                {calendarView === "years"
                  ? `${yearRangeStart}\u2013${yearRangeStart + 11}`
                  : calendarView === "months"
                    ? format(currentMonth, "yyyy")
                    : format(currentMonth, "MMMM yyyy")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (calendarView === "years") {
                    setYearRangeStart((prev) => prev + 12);
                  } else if (calendarView === "months") {
                    setCurrentMonth(addMonths(currentMonth, 12));
                  } else {
                    goToMonth(addMonths(currentMonth, 1));
                  }
                }}
                disabled={isLoading}
                aria-label={
                  calendarView === "years"
                    ? "Next 12 years"
                    : calendarView === "months"
                      ? "Next year"
                      : "Next month"
                }
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const today = new Date();
                const todayMonth = startOfMonth(today);
                setSelectedDate(today);
                setCalendarView("days");
                if (!isSameMonth(currentMonth, today)) {
                  goToMonth(todayMonth);
                }
              }}
            >
              Today
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : calendarView === "years" ? (
              <div className="grid grid-cols-4 gap-2 py-4">
                {(() => {
                  const now = new Date();
                  return Array.from({ length: 12 }, (_, i) => yearRangeStart + i).map(
                    (year) => (
                      <button
                        key={year}
                        onClick={() => {
                          setCurrentMonth(
                            startOfMonth(
                              new Date(year, currentMonth.getMonth())
                            )
                          );
                          setCalendarView("months");
                        }}
                        className={cn(
                          "rounded-md py-4 text-sm font-medium transition-colors hover:bg-muted",
                          year === now.getFullYear() && "ring-2 ring-primary"
                        )}
                      >
                        {year}
                      </button>
                    )
                  );
                })()}
              </div>
            ) : calendarView === "months" ? (
              <div className="grid grid-cols-4 gap-2 py-4">
                {(() => {
                  const now = new Date();
                  return MONTH_NAMES.map((name, index) => (
                    <button
                      key={name}
                      onClick={() =>
                        goToMonth(
                          startOfMonth(
                            new Date(currentMonth.getFullYear(), index)
                          )
                        )
                      }
                      className={cn(
                        "rounded-md py-4 text-sm font-medium transition-colors hover:bg-muted",
                        index === now.getMonth() &&
                          currentMonth.getFullYear() === now.getFullYear() &&
                          "ring-2 ring-primary"
                      )}
                    >
                      {name}
                    </button>
                  ));
                })()}
              </div>
            ) : (
              <div>
                {/* Day name headers */}
                <div className="grid grid-cols-7 mb-1">
                  {DAY_NAMES.map((day) => (
                    <div
                      key={day}
                      className="text-center text-xs font-medium text-muted-foreground py-2"
                    >
                      {day}
                    </div>
                  ))}
                </div>
                {/* Day cells */}
                <div className="grid grid-cols-7">
                  {visibleDays.map((day) => {
                    const dateKey = format(day, "yyyy-MM-dd");
                    const count = appointmentCounts.get(dateKey) || 0;
                    const isCurrentMonth = isSameMonth(day, currentMonth);
                    const dayHours = getBusinessHoursForDay(businessHours, day);
                    const isClosed = isCurrentMonth && dayHours === null;
                    const isSelected =
                      selectedDate && isSameDay(day, selectedDate);

                    return (
                      <button
                        key={dateKey}
                        onClick={() => setSelectedDate(day)}
                        className={cn(
                          "relative flex flex-col items-center justify-center py-2 h-14 text-sm transition-colors rounded-md",
                          !isCurrentMonth &&
                            "text-muted-foreground opacity-50",
                          isCurrentMonth && "hover:bg-muted",
                          isClosed && isCurrentMonth && "bg-muted/50",
                          isToday(day) && "ring-2 ring-primary",
                          isSelected &&
                            "bg-primary text-primary-foreground hover:bg-primary/90"
                        )}
                      >
                        <span className="leading-none">
                          {format(day, "d")}
                        </span>
                        {count > 0 && isCurrentMonth && (
                          <div className="flex items-center gap-0.5 mt-1">
                            <div
                              className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                isSelected
                                  ? "bg-primary-foreground"
                                  : "bg-primary"
                              )}
                            />
                            {count > 1 && (
                              <span
                                className={cn(
                                  "text-[10px] leading-none",
                                  isSelected
                                    ? "text-primary-foreground"
                                    : "text-primary"
                                )}
                              >
                                {count}
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right: Day Detail Panel */}
        <Card>
          <CardHeader className="pb-3">
            {selectedDate ? (
              <>
                <CardTitle className="text-base">
                  {format(selectedDate, "EEEE, MMMM d, yyyy")}
                </CardTitle>
                <div className="text-sm text-muted-foreground">
                  {selectedDayHours ? (
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" />
                      Open{" "}
                      {formatBusinessHoursTime(selectedDayHours.open)} &ndash;{" "}
                      {formatBusinessHoursTime(selectedDayHours.close)}
                    </span>
                  ) : (
                    <Badge variant="secondary">Closed</Badge>
                  )}
                </div>
              </>
            ) : (
              <CardTitle className="text-base">Day Details</CardTitle>
            )}
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[400px] pr-2">
              {!selectedDate ? (
                <EmptyState
                  icon={CalendarIcon}
                  title="Select a day"
                  description="Choose a date to view appointments"
                  illustration={<CalendarScene />}
                  compact
                />
              ) : selectedDayAppointments.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  title="No appointments"
                  description="No appointments scheduled for this day"
                  illustration={<CalendarScene />}
                  compact
                />
              ) : (
                <div className="space-y-3">
                  {selectedDayAppointments.map((appt) => (
                    <div
                      key={appt.id}
                      className="rounded-lg border p-3 space-y-2 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                      onClick={() => { setDetailApptId(appt.id); setDetailOpen(true); }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          {formatTimeRange(appt.start_time, appt.end_time)}
                        </span>
                        <Badge variant={getStatusVariant(appt.status)}>
                          {appt.status}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm font-medium">
                            {appt.attendee_name}
                          </span>
                        </div>
                        {appt.attendee_phone && (
                          <div className="flex items-center gap-2">
                            <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-sm text-muted-foreground">
                              {formatPhoneNumber(appt.attendee_phone)}
                            </span>
                          </div>
                        )}
                        {appt.attendee_email && !appt.attendee_email.includes("@noreply.phondo.ai") && (
                          <div className="flex items-center gap-2">
                            <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="text-sm text-muted-foreground truncate">
                              {appt.attendee_email}
                            </span>
                          </div>
                        )}
                        {appt.notes && (
                          <div className="flex items-start gap-2">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                            <span className="text-sm text-muted-foreground line-clamp-2">
                              {appt.notes}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Upcoming Appointments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Upcoming Appointments</CardTitle>
          <CardDescription>Next 7 days</CardDescription>
        </CardHeader>
        <CardContent>
          {upcomingAppointments.length === 0 ? (
            <EmptyState
              icon={CalendarCheck2}
              title="No upcoming appointments"
              description="Appointments for the next 7 days will appear here"
              illustration={<CalendarScene />}
              compact
            />
          ) : (
            <div className="space-y-2">
              {upcomingAppointments.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-4 rounded-lg border p-3 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                  onClick={() => { setDetailApptId(appt.id); setDetailOpen(true); }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="shrink-0 text-center">
                    <div className="text-xs font-medium text-muted-foreground">
                      {format(new Date(appt.start_time), "EEE")}
                    </div>
                    <div className="text-lg font-bold">
                      {format(new Date(appt.start_time), "d")}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {appt.attendee_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatTimeRange(appt.start_time, appt.end_time)}
                    </p>
                  </div>
                  <Badge variant={getStatusVariant(appt.status)}>
                    {appt.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Appointment Detail Panel */}
      <AppointmentDetailPanel
        appointmentId={detailApptId}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setDetailApptId(null); }}
        onUpdated={refreshCurrentMonth}
      />
    </div>
  );
}
