"use client";

import { useState, useEffect } from "react";
import { stopVoicePreview } from "@/lib/audio/voice-preview";
import { filterVoices, resolveVoiceId } from "@/lib/voices";
import { VoiceCard } from "./VoiceCard";
import { VoiceFilterBar } from "./VoiceFilterBar";

interface VoiceSelectorProps {
  value: string;
  onChange: (voiceId: string) => void;
}

export function VoiceSelector({ value, onChange }: VoiceSelectorProps) {
  const [filter, setFilter] = useState("all");

  // Resolve legacy short-name IDs on mount
  useEffect(() => {
    const resolved = resolveVoiceId(value);
    if (resolved !== value) {
      onChange(resolved);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop any playing preview on unmount
  useEffect(() => {
    return () => stopVoicePreview();
  }, []);

  const resolvedValue = resolveVoiceId(value);
  const voices = filterVoices(filter);

  return (
    <div className="space-y-3">
      <VoiceFilterBar activeFilter={filter} onChange={setFilter} />

      {voices.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No voices match this filter.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {voices.map((voice) => (
            <VoiceCard
              key={voice.id}
              voice={voice}
              selected={voice.id === resolvedValue}
              onSelect={() => onChange(voice.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
