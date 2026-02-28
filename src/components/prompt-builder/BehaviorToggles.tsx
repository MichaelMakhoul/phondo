"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BehaviorToggles as BehaviorTogglesType } from "@/lib/prompt-builder/types";

interface BehaviorTogglesProps {
  behaviors: BehaviorTogglesType;
  onChange: (behaviors: BehaviorTogglesType) => void;
}

const behaviorDefinitions: {
  key: keyof BehaviorTogglesType;
  label: string;
  description: string;
}[] = [
  {
    key: "scheduleAppointments",
    label: "Schedule Appointments",
    description: "Help callers book, reschedule, or cancel appointments",
  },
  {
    key: "handleEmergencies",
    label: "Handle Emergencies",
    description: "Detect urgent situations and provide appropriate guidance",
  },
  {
    key: "providePricingInfo",
    label: "Provide Pricing Info",
    description: "Share general pricing when asked by callers",
  },
  {
    key: "takeMessages",
    label: "Take Messages",
    description: "Record caller details and reason for calling",
  },
  {
    key: "transferToHuman",
    label: "Transfer to Human",
    description: "Offer to transfer the call when a person is needed",
  },
  {
    key: "afterHoursHandling",
    label: "After Hours Handling",
    description: "Different greeting and behavior when calls arrive outside business hours",
  },
];

export function BehaviorToggles({ behaviors, onChange }: BehaviorTogglesProps) {
  const toggle = (key: keyof BehaviorTogglesType) => {
    onChange({ ...behaviors, [key]: !behaviors[key] });
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {behaviorDefinitions.map(({ key, label, description }) => (
        <div
          key={key}
          className="flex items-start justify-between gap-3 rounded-lg border p-3"
        >
          <div className="space-y-0.5">
            <Label className="text-sm font-medium leading-none cursor-pointer" htmlFor={key}>
              {label}
            </Label>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Switch
            id={key}
            checked={behaviors[key]}
            onCheckedChange={() => toggle(key)}
            className="shrink-0"
          />
        </div>
      ))}
    </div>
  );
}
