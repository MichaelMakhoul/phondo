"use client";

import { cn } from "@/lib/utils";

interface VoiceWaveformProps {
  isActive: boolean;
  className?: string;
}

const BAR_DELAYS = ["delay-[0ms]", "delay-[150ms]", "delay-[300ms]", "delay-[450ms]", "delay-[600ms]"];

export function VoiceWaveform({ isActive, className }: VoiceWaveformProps) {
  return (
    <div className={cn("flex items-center justify-center gap-[3px]", className)}>
      {BAR_DELAYS.map((delay, i) => (
        <div
          key={i}
          className={cn(
            "w-[3px] rounded-full bg-current transition-all",
            isActive ? `h-5 animate-waveform ${delay}` : "h-1"
          )}
          style={isActive ? { animationDelay: `${i * 150}ms` } : undefined}
        />
      ))}
    </div>
  );
}
