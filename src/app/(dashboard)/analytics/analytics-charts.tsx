"use client";

import { format, parseISO } from "date-fns";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface DailyStats {
  date: string;
  calls: number;
  answered: number;
  appointments: number;
}

interface AnalyticsChartsProps {
  dailyStats: DailyStats[];
}

export function AnalyticsCharts({ dailyStats }: AnalyticsChartsProps) {
  const recentDays = dailyStats.slice(-14).map((d) => ({
    ...d,
    label: format(parseISO(d.date), "MMM d"),
    missed: d.calls - d.answered,
  }));

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={recentDays} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
            stroke="hsl(var(--border))"
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
            stroke="hsl(var(--border))"
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(var(--border))",
              backgroundColor: "hsl(var(--popover))",
              color: "hsl(var(--popover-foreground))",
            }}
            itemStyle={{ color: "hsl(var(--popover-foreground))" }}
            labelStyle={{ color: "hsl(var(--popover-foreground))" }}
            formatter={(value: any, name: any) => [
              value,
              name === "answered" ? "Answered" : "Missed",
            ]}
            labelFormatter={(label: any) => String(label)}
          />
          <Legend
            formatter={(value: string) => (
              <span className="text-foreground">
                {value === "answered" ? "Answered" : "Missed"}
              </span>
            )}
          />
          <Bar dataKey="answered" stackId="calls" fill="hsl(142, 71%, 45%)" radius={[0, 0, 0, 0]} />
          <Bar dataKey="missed" stackId="calls" fill="hsl(var(--muted))" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
