export function formatAdminDate(date: string | Date | null): string {
  if (!date) return "\u2014";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "\u2014";
  // Use explicit UTC formatting for consistency across server/client
  return d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatAdminDateShort(date: string | Date | null): string {
  if (!date) return "\u2014";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
