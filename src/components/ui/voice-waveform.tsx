"use client";

import { cn } from "@/lib/utils";

interface VoiceWaveformProps {
  isActive: boolean;
  className?: string;
}

const BAR_COUNT = 5;

export function VoiceWaveform({ isActive, className }: VoiceWaveformProps) {
  return (
    <div className={cn("flex items-center justify-center gap-[3px]", className)}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <div
          key={i}
          className={cn(
            "w-[3px] rounded-full bg-current transition-all",
            isActive ? "h-5 animate-waveform" : "h-1"
          )}
          style={isActive ? { animationDelay: `${i * 150}ms` } : undefined}
        />
      ))}
    </div>
  );
}
