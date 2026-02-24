"use client";

import { useState, useMemo } from "react";
import { Slider } from "@/components/ui/slider";
import { formatCurrency } from "@/lib/utils";

const REVENUE_PER_MISSED_CALL = 450; // industry average (AUD)
const RECOVERY_RATE = 0.47; // 47% of missed calls recovered with AI + SMS

export function ROICalculator() {
  const [missedCallsPerWeek, setMissedCallsPerWeek] = useState(10);

  const stats = useMemo(() => {
    const missedPerMonth = missedCallsPerWeek * 4.33;
    const lostRevenuePerYear = missedPerMonth * 12 * REVENUE_PER_MISSED_CALL;
    const recoveredPerMonth = Math.round(missedPerMonth * RECOVERY_RATE);
    const recoveredRevenuePerYear = recoveredPerMonth * 12 * REVENUE_PER_MISSED_CALL;
    // Assume Professional plan for ROI calculation ($249/mo)
    const planCostPerYear = 24900 * 12; // cents
    const netSavingsPerYear = recoveredRevenuePerYear * 100 - planCostPerYear; // cents
    const paybackDays = recoveredRevenuePerYear > 0
      ? Math.ceil((planCostPerYear / 100) / (recoveredRevenuePerYear / 365))
      : 999;

    return {
      missedPerMonth: Math.round(missedPerMonth),
      lostRevenuePerYear,
      recoveredPerMonth,
      recoveredRevenuePerYear,
      netSavingsPerYear,
      paybackDays,
    };
  }, [missedCallsPerWeek]);

  return (
    <div className="rounded-2xl border bg-card p-8 shadow-sm">
      <div className="space-y-8">
        <div className="space-y-4">
          <label className="text-sm font-medium">
            How many calls do you miss per week?
          </label>
          <div className="flex items-center gap-6">
            <Slider
              value={[missedCallsPerWeek]}
              onValueChange={(v) => setMissedCallsPerWeek(v[0])}
              min={1}
              max={50}
              step={1}
              aria-label="Number of calls missed per week"
              className="flex-1"
            />
            <span className="min-w-[4rem] text-right text-3xl font-bold text-primary">
              {missedCallsPerWeek}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            The average SMB misses 62% of inbound calls
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg bg-destructive/10 p-4">
            <p className="text-sm text-muted-foreground">Revenue lost per year</p>
            <p className="mt-1 text-2xl font-bold text-destructive">
              {formatCurrency(stats.lostRevenuePerYear * 100)}
            </p>
            <p className="text-xs text-muted-foreground">
              ~{stats.missedPerMonth} missed calls/mo x ${REVENUE_PER_MISSED_CALL}
            </p>
          </div>
          <div className="rounded-lg bg-green-500/10 p-4">
            <p className="text-sm text-muted-foreground">Revenue recovered per year</p>
            <p className="mt-1 text-2xl font-bold text-green-600 dark:text-green-400">
              {formatCurrency(stats.recoveredRevenuePerYear * 100)}
            </p>
            <p className="text-xs text-muted-foreground">
              ~{stats.recoveredPerMonth} calls recovered/mo (47% rate)
            </p>
          </div>
        </div>

        <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-4 text-center">
          <p className="text-sm text-muted-foreground">Hola Recep pays for itself in</p>
          <p className="mt-1 text-4xl font-bold text-primary">
            {stats.paybackDays} {stats.paybackDays === 1 ? "day" : "days"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Net savings: {formatCurrency(stats.netSavingsPerYear)}/year after plan cost
          </p>
        </div>
      </div>
    </div>
  );
}
