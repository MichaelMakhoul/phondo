"use client";

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface OutcomeData {
  name: string;
  value: number;
  color: string;
}

interface OutcomeChartProps {
  data: OutcomeData[];
}

export function OutcomeChart({ data }: OutcomeChartProps) {
  const nonZero = data.filter((d) => d.value > 0);

  if (nonZero.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px] text-muted-foreground text-sm">
        No call data yet
      </div>
    );
  }

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={nonZero}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={100}
            paddingAngle={2}
            dataKey="value"
          >
            {nonZero.map((entry, idx) => (
              <Cell key={idx} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(var(--border))",
              backgroundColor: "hsl(var(--popover))",
              color: "hsl(var(--popover-foreground))",
            }}
            formatter={(value: any, name: any) => [value, name]}
          />
          <Legend
            formatter={(value: string) => (
              <span className="text-sm">{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
