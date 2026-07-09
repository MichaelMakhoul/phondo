"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VoiceSelector } from "@/components/voice-selector";
import { PromptBuilder } from "@/components/prompt-builder";
import type { PromptConfig } from "@/lib/prompt-builder/types";
import { getDefaultConfig } from "@/lib/prompt-builder/defaults";
import { buildPromptFromConfig, generateGreeting } from "@/lib/prompt-builder/generate-prompt";

interface AssistantSetupProps {
  data: {
    assistantName: string;
    systemPrompt: string;
    firstMessage: string;
    voiceId: string;
    promptConfig?: Record<string, any> | null;
  };
  businessInfo: {
    businessName: string;
    industry: string;
    /** Org ISO country code — selects the emergency number in the generated prompt. */
    country?: string;
  };
  scrapedCustomInstructions?: string;
  onChange: (data: Partial<AssistantSetupProps["data"]>) => void;
}

export function AssistantSetup({ data, businessInfo, scrapedCustomInstructions, onChange }: AssistantSetupProps) {
  const hasInitializedRef = useRef(false);
  const lastIndustryRef = useRef(businessInfo.industry);

  // Initialize with defaults on first render or industry change
  useEffect(() => {
    const industryChanged = lastIndustryRef.current !== businessInfo.industry;

    if (businessInfo.industry && (!hasInitializedRef.current || industryChanged)) {
      const defaultConfig = getDefaultConfig(businessInfo.industry);

      // Inject scraped website info into custom instructions
      if (scrapedCustomInstructions) {
        defaultConfig.customInstructions = scrapedCustomInstructions;
      }

      const generated = buildPromptFromConfig(defaultConfig, {
        businessName: businessInfo.businessName || "{business_name}",
        industry: businessInfo.industry,
        country: businessInfo.country,
      });
      const greeting = generateGreeting(defaultConfig.tone, businessInfo.businessName);

      onChange({
        assistantName: data.assistantName || `${businessInfo.businessName || "My"} AI Receptionist`,
        systemPrompt: generated,
        firstMessage: greeting,
        voiceId: data.voiceId || "EXAVITQu4vr4xnSDxMaL",
        promptConfig: defaultConfig,
      });

      hasInitializedRef.current = true;
      lastIndustryRef.current = businessInfo.industry;
    }
  }, [businessInfo.industry, businessInfo.businessName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle late-arriving scraped instructions (user scrapes after visiting step 2)
  useEffect(() => {
    if (scrapedCustomInstructions && hasInitializedRef.current && data.promptConfig) {
      const config = { ...(data.promptConfig as PromptConfig), customInstructions: scrapedCustomInstructions };
      const generated = buildPromptFromConfig(config, {
        businessName: businessInfo.businessName || "{business_name}",
        industry: businessInfo.industry,
        country: businessInfo.country,
      });
      onChange({ systemPrompt: generated, promptConfig: config });
    }
  }, [scrapedCustomInstructions]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePromptBuilderChange = useCallback(
    (updates: { systemPrompt: string; firstMessage: string; promptConfig: PromptConfig }) => {
      onChange({
        systemPrompt: updates.systemPrompt,
        firstMessage: updates.firstMessage,
        promptConfig: updates.promptConfig,
      });
    },
    [onChange]
  );

  return (
    <div className="space-y-6">
      {/* Assistant Name */}
      <div className="space-y-2">
        <Label htmlFor="assistantName">Assistant Name</Label>
        <Input
          id="assistantName"
          placeholder="My AI Receptionist"
          value={data.assistantName}
          onChange={(e) => onChange({ assistantName: e.target.value })}
        />
      </div>

      {/* Guided Prompt Builder */}
      <PromptBuilder
        config={(data.promptConfig as PromptConfig) || null}
        industry={businessInfo.industry || "other"}
        businessName={businessInfo.businessName || ""}
        systemPrompt={data.systemPrompt}
        firstMessage={data.firstMessage}
        country={businessInfo.country}
        onChange={handlePromptBuilderChange}
        variant="onboarding"
      />

      {/* Greeting Message */}
      <div className="space-y-2">
        <Label htmlFor="firstMessage">Greeting Message</Label>
        <Textarea
          id="firstMessage"
          placeholder="Thank you for calling! How can I help you today?"
          value={data.firstMessage}
          onChange={(e) => onChange({ firstMessage: e.target.value })}
          rows={2}
        />
        <p className="text-xs text-muted-foreground">
          This is the first thing callers will hear
        </p>
      </div>

      {/* Voice Selection */}
      <div className="space-y-2">
        <Label>Voice Selection</Label>
        <VoiceSelector
          value={data.voiceId}
          onChange={(voiceId) => onChange({ voiceId })}
        />
        <p className="text-xs text-muted-foreground">
          Choose the voice your AI receptionist will use
        </p>
      </div>
    </div>
  );
}
