"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { FieldPicker } from "./FieldPicker";
import { BehaviorToggles } from "./BehaviorToggles";
import { ToneSelector } from "./ToneSelector";
import { AdvancedPromptEditor } from "./AdvancedPromptEditor";
import type { PromptConfig, CollectionField, BehaviorToggles as BehaviorTogglesType, TonePreset } from "@/lib/prompt-builder/types";
import { buildPromptFromConfig, generateGreeting } from "@/lib/prompt-builder/generate-prompt";
import { getDefaultConfig } from "@/lib/prompt-builder/defaults";

interface PromptBuilderProps {
  config: PromptConfig | null;
  industry: string;
  businessName: string;
  systemPrompt: string;
  firstMessage: string;
  /** Org ISO country code — selects the emergency number in guidance (AU "000", else "911"). */
  country?: string;
  onChange: (updates: {
    systemPrompt: string;
    firstMessage: string;
    promptConfig: PromptConfig;
  }) => void;
  variant?: "onboarding" | "dashboard";
}

export function PromptBuilder({
  config,
  industry,
  businessName,
  systemPrompt,
  firstMessage,
  country,
  onChange,
  variant = "onboarding",
}: PromptBuilderProps) {
  // Initialize config from prop or defaults
  const [localConfig, setLocalConfig] = useState<PromptConfig>(
    () => config || getDefaultConfig(industry)
  );

  // Track the manually edited prompt (only when user edits the advanced editor)
  const [manualPrompt, setManualPrompt] = useState<string | null>(
    config?.isManuallyEdited ? systemPrompt : null
  );

  // Track previous industry to detect changes
  const prevIndustryRef = useRef(industry);

  // When industry changes, reset to new defaults
  useEffect(() => {
    if (prevIndustryRef.current !== industry) {
      prevIndustryRef.current = industry;
      const newConfig = getDefaultConfig(industry);
      setLocalConfig(newConfig);
      setManualPrompt(null);
    }
  }, [industry]);

  // Regenerate prompt whenever config changes (unless manually edited)
  const regenerate = useCallback(
    (cfg: PromptConfig) => {
      if (cfg.isManuallyEdited && manualPrompt !== null) {
        // Don't regenerate - user is using manual prompt
        onChange({
          systemPrompt: manualPrompt,
          firstMessage,
          promptConfig: cfg,
        });
        return;
      }

      const generated = buildPromptFromConfig(cfg, {
        businessName: businessName || "{business_name}",
        industry,
        country,
      });

      onChange({
        systemPrompt: generated,
        firstMessage: firstMessage || generateGreeting(cfg.tone, businessName),
        promptConfig: cfg,
      });
    },
    [businessName, industry, country, firstMessage, manualPrompt, onChange]
  );

  const updateFields = (fields: CollectionField[]) => {
    const updated = { ...localConfig, fields, isManuallyEdited: false };
    setLocalConfig(updated);
    setManualPrompt(null);
    regenerate(updated);
  };

  const updateBehaviors = (behaviors: BehaviorTogglesType) => {
    const updated = { ...localConfig, behaviors, isManuallyEdited: false };
    setLocalConfig(updated);
    setManualPrompt(null);
    regenerate(updated);
  };

  const updateTone = (tone: TonePreset) => {
    const updated = { ...localConfig, tone, isManuallyEdited: false };
    setLocalConfig(updated);
    setManualPrompt(null);

    // Also update the greeting to match the new tone
    const generated = buildPromptFromConfig(updated, {
      businessName: businessName || "{business_name}",
      industry,
      country,
    });
    const greeting = generateGreeting(tone, businessName);

    onChange({
      systemPrompt: generated,
      firstMessage: greeting,
      promptConfig: updated,
    });
  };

  const handleManualEdit = (prompt: string) => {
    setManualPrompt(prompt);
    const updated = { ...localConfig, isManuallyEdited: true };
    setLocalConfig(updated);
    onChange({
      systemPrompt: prompt,
      firstMessage,
      promptConfig: updated,
    });
  };

  const handleReset = () => {
    setManualPrompt(null);
    const updated = { ...localConfig, isManuallyEdited: false };
    setLocalConfig(updated);
    regenerate(updated);
  };

  const currentPrompt = manualPrompt ?? systemPrompt;

  return (
    <div className="space-y-6">
      {/* Section A: Caller Data Collection */}
      <div className="space-y-3">
        <div>
          <Label className="text-base font-semibold">Caller Data Collection</Label>
          <p className="text-sm text-muted-foreground">
            Choose what information your AI should collect from callers
          </p>
        </div>
        <FieldPicker fields={localConfig.fields} onChange={updateFields} />
      </div>

      <Separator />

      {/* Section B: Receptionist Behaviors */}
      <div className="space-y-3">
        <div>
          <Label className="text-base font-semibold">Receptionist Behaviors</Label>
          <p className="text-sm text-muted-foreground">
            What should your AI be able to do?
          </p>
        </div>
        <BehaviorToggles behaviors={localConfig.behaviors} onChange={updateBehaviors} />
      </div>

      <Separator />

      {/* Section C: Tone */}
      <div className="space-y-3">
        <div>
          <Label className="text-base font-semibold">Tone & Personality</Label>
          <p className="text-sm text-muted-foreground">
            How should your AI sound to callers?
          </p>
        </div>
        <ToneSelector tone={localConfig.tone} onChange={updateTone} />
      </div>

      <Separator />

      {/* Section D: Advanced */}
      <AdvancedPromptEditor
        generatedPrompt={currentPrompt}
        isManuallyEdited={localConfig.isManuallyEdited}
        onManualEdit={handleManualEdit}
        onReset={handleReset}
      />
    </div>
  );
}
