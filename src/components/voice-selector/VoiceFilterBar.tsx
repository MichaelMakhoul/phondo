"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { VOICE_FILTERS, VOICE_CATALOG, type VoiceLanguage } from "@/lib/voices";

interface VoiceFilterBarProps {
  activeFilter: string;
  onChange: (filterKey: string) => void;
  language?: VoiceLanguage;
}

export function VoiceFilterBar({ activeFilter, onChange, language = "en" }: VoiceFilterBarProps) {
  const visibleFilters = useMemo(() => {
    const langVoices = VOICE_CATALOG.filter((v) => v.language === language);
    return VOICE_FILTERS.filter(
      (f) => f.key === "all" || langVoices.some(f.predicate)
    );
  }, [language]);

  return (
    <div className="flex flex-wrap gap-2">
      {visibleFilters.map((f) => (
        <Button
          key={f.key}
          type="button"
          size="sm"
          variant={activeFilter === f.key ? "default" : "outline"}
          onClick={() => onChange(f.key)}
        >
          {f.label}
        </Button>
      ))}
    </div>
  );
}
