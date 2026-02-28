"use client";

interface HeatmapData {
  day: number;
  hour: number;
  count: number;
}

interface CallHeatmapProps {
  data: HeatmapData[];
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CallHeatmap({ data }: CallHeatmapProps) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const getCell = (day: number, hour: number) =>
    data.find((d) => d.day === day && d.hour === hour)?.count ?? 0;

  return (
    <div className="space-y-2 overflow-x-auto">
      <div className="min-w-[600px]">
        {/* Hour labels */}
        <div className="flex">
          <div className="w-10 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="flex-1 text-center text-[10px] text-muted-foreground"
            >
              {h % 3 === 0 ? `${h}` : ""}
            </div>
          ))}
        </div>

        {/* Grid rows */}
        {DAY_LABELS.map((label, dayIdx) => (
          <div key={label} className="flex items-center gap-1">
            <div className="w-10 shrink-0 text-xs text-muted-foreground text-right pr-1">
              {label}
            </div>
            {Array.from({ length: 24 }, (_, h) => {
              const count = getCell(dayIdx, h);
              const intensity = maxCount > 0 ? count / maxCount : 0;
              return (
                <div
                  key={h}
                  className="flex-1 aspect-square rounded-sm cursor-default transition-colors"
                  style={{
                    backgroundColor:
                      count === 0
                        ? "hsl(var(--muted))"
                        : `rgba(34, 197, 94, ${0.15 + intensity * 0.85})`,
                  }}
                  title={`${label} ${h}:00 — ${count} call${count !== 1 ? "s" : ""}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
        <span>Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((intensity) => (
          <div
            key={intensity}
            className="w-3 h-3 rounded-sm"
            style={{
              backgroundColor:
                intensity === 0
                  ? "hsl(var(--muted))"
                  : `rgba(34, 197, 94, ${0.15 + intensity * 0.85})`,
            }}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
