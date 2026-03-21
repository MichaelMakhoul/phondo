"use client";

import { format } from "date-fns";

interface LocalTimeProps {
  date: string;
  formatStr?: string;
  className?: string;
}

/**
 * Renders a date/time in the user's local timezone.
 * Must be a client component because server components run in UTC.
 */
export function LocalTime({ date, formatStr = "MMM d, h:mm a", className }: LocalTimeProps) {
  const parsed = new Date(date);
  const formatted = isNaN(parsed.getTime()) ? "\u2014" : format(parsed, formatStr);
  return <span className={className} suppressHydrationWarning>{formatted}</span>;
}
