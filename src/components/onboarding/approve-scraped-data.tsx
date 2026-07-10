"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { parseBusinessHoursDetailed } from "@/lib/scraper/parse-business-hours";
import {
  readingsToDaySelections,
  buildApprovedHoursLines,
  formatTime12h,
  type HoursDaySelection,
} from "@/lib/scraper/approve-scraped";
import type { ScrapedFaq, ScrapedStaffMember } from "@/lib/scraper/website-scraper";

export interface ScrapedBusinessInfo {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  hours?: string[];
  services?: string[];
  about?: string;
  faqs?: ScrapedFaq[];
  summary?: string;
  staff?: ScrapedStaffMember[];
}

export interface ApprovedScrapedData {
  businessName?: string;
  businessPhone?: string;
  scrapedAddress?: string;
  /** Normalized lines the strict parser provably accepts. */
  scrapedHours: string[];
  scrapedServices: string[];
}

interface ApproveScrapedDataProps {
  businessInfo: ScrapedBusinessInfo;
  totalPages: number;
  /** "raw-fallback" = the crawl worked but the structured read failed. */
  extraction?: "structured" | "raw-fallback";
  onApply: (approved: ApprovedScrapedData) => void;
}

const DAY_LABELS: Record<string, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/**
 * SCRUM-534: the review-and-approve panel shown after a website scan.
 *
 * Nothing here auto-applies. The scan used to silently overwrite the form
 * fields; now the owner sees each block, unticks what is wrong, confirms
 * ambiguous hour readings the strict parser would have refused outright,
 * and presses one Apply. Staff are display-only by design — bookable
 * practitioners are an explicit Settings action, never a scrape side
 * effect (booking exclusion constraints key on practitioner_id).
 */
export function ApproveScrapedData({ businessInfo, totalPages, extraction, onApply }: ApproveScrapedDataProps) {
  const readings = useMemo(() => parseBusinessHoursDetailed(businessInfo.hours), [businessInfo.hours]);
  const unrepresentable = useMemo(() => readings.filter((r) => r.days.length === 0), [readings]);

  const [name, setName] = useState(businessInfo.name ?? "");
  const [phone, setPhone] = useState(businessInfo.phone ?? "");
  const [address, setAddress] = useState(businessInfo.address ?? "");
  const [includeDetails, setIncludeDetails] = useState(true);
  const [days, setDays] = useState<HoursDaySelection[]>(() => readingsToDaySelections(readings));
  const [services, setServices] = useState<{ name: string; include: boolean }[]>(
    () => (businessInfo.services ?? []).map((s) => ({ name: s, include: true }))
  );
  const [applied, setApplied] = useState(false);

  const updateDay = (day: string, patch: Partial<HoursDaySelection>) =>
    setDays((rows) => rows.map((r) => (r.day === day ? { ...r, ...patch } : r)));

  const handleApply = () => {
    onApply({
      ...(includeDetails && name.trim() ? { businessName: name.trim() } : {}),
      ...(includeDetails && phone.trim() ? { businessPhone: phone.trim() } : {}),
      ...(includeDetails && address.trim() ? { scrapedAddress: address.trim() } : {}),
      scrapedHours: buildApprovedHoursLines(days),
      scrapedServices: services.filter((s) => s.include).map((s) => s.name),
    });
    setApplied(true);
  };

  return (
    <div className="space-y-4 rounded-md border p-4 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
        <span>
          We read {totalPages} page{totalPages !== 1 ? "s" : ""} of your website. Check what we found, then apply it.
        </span>
      </div>

      {extraction === "raw-fallback" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            We saved your website text for the AI, but couldn&apos;t sort it into the fields below.
            Fill them in yourself, or try the scan again later.
          </AlertDescription>
        </Alert>
      )}

      {/* Business details */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 font-medium">
          <Checkbox checked={includeDetails} onCheckedChange={(v) => setIncludeDetails(v === true)} />
          Business details
        </label>
        {includeDetails && (
          <div className="space-y-2 pl-6">
            <div className="space-y-1">
              <Label htmlFor="approve-name" className="text-xs text-muted-foreground">Business name</Label>
              <Input id="approve-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="approve-phone" className="text-xs text-muted-foreground">
                Your existing number — calls will forward from here to your AI
              </Label>
              <Input id="approve-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="approve-address" className="text-xs text-muted-foreground">Address</Label>
              <Input id="approve-address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {/* Hours */}
      {(days.length > 0 || unrepresentable.length > 0) && (
        <div className="space-y-2">
          <p className="font-medium">Opening hours</p>
          <div className="space-y-1.5 pl-1">
            {days.map((row) => (
              <div key={row.day} className="flex flex-wrap items-center gap-2">
                <label className="flex w-full items-center gap-2 sm:w-auto">
                  <Checkbox
                    checked={row.include}
                    onCheckedChange={(v) => updateDay(row.day, { include: v === true })}
                    aria-label={`Include ${row.day}`}
                  />
                  <span className="w-10 font-medium">{DAY_LABELS[row.day]}</span>
                </label>
                {row.hours === null && !row.warning ? (
                  <span className="text-muted-foreground">Closed</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Input
                      type="time"
                      className="h-8 w-28"
                      aria-label={`${row.day} opens`}
                      value={row.hours?.open ?? ""}
                      onChange={(e) =>
                        updateDay(row.day, { hours: { open: e.target.value, close: row.hours?.close ?? "" } })
                      }
                    />
                    <span className="text-muted-foreground">to</span>
                    <Input
                      type="time"
                      className="h-8 w-28"
                      aria-label={`${row.day} closes`}
                      value={row.hours?.close ?? ""}
                      onChange={(e) =>
                        updateDay(row.day, { hours: { open: row.hours?.open ?? "", close: e.target.value } })
                      }
                    />
                  </span>
                )}
                {row.warning && (
                  <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {row.warning}
                    {row.hours && ` — we read it as ${formatTime12h(row.hours.open)} to ${formatTime12h(row.hours.close)}; tick to confirm or fix the times`}
                  </span>
                )}
              </div>
            ))}
            {unrepresentable.map((r) => (
              <p key={r.line} className="text-xs text-muted-foreground">
                Couldn&apos;t read &quot;{r.line}&quot; — you can set this later in Settings.
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Services */}
      {services.length > 0 && (
        <div className="space-y-2">
          <p className="font-medium">Services callers can book</p>
          <div className="grid gap-1.5 pl-1 sm:grid-cols-2">
            {services.map((s) => (
              <label key={s.name} className="flex items-center gap-2">
                <Checkbox
                  checked={s.include}
                  onCheckedChange={(v) =>
                    setServices((rows) => rows.map((r) => (r.name === s.name ? { ...r, include: v === true } : r)))
                  }
                />
                <span>{s.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* FAQs — informational: already part of the saved website knowledge */}
      {businessInfo.faqs && businessInfo.faqs.length > 0 && (
        <div className="flex gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            We also found {businessInfo.faqs.length} question{businessInfo.faqs.length !== 1 ? "s" : ""} and answers
            on your site (e.g. &quot;{businessInfo.faqs[0].question}&quot;). Your AI will use them when callers ask.
          </p>
        </div>
      )}

      {/* Staff — display only, by design */}
      {businessInfo.staff && businessInfo.staff.length > 0 && (
        <div className="flex gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            Team members on your site: {businessInfo.staff.map((m) => (m.role ? `${m.name} (${m.role})` : m.name)).join(", ")}.
            If callers should book with a specific person, add them under Settings later — we never set that up from a
            website scan.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleApply}>
          Apply selections
        </Button>
        {applied && (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> Applied — you can adjust and apply again
          </span>
        )}
      </div>
    </div>
  );
}
