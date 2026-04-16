"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2 } from "lucide-react";
import { FieldEditor } from "./FieldEditor";
import type { CollectionField, VerificationMethod } from "@/lib/prompt-builder/types";

const verificationOptions: { value: VerificationMethod; label: string }[] = [
  { value: "none", label: "None" },
  { value: "repeat-confirm", label: "Repeat & confirm" },
  { value: "read-back-digits", label: "Digits" },
  { value: "spell-out", label: "Spell out" },
  { value: "read-back-characters", label: "Characters" },
];

interface FieldPickerProps {
  fields: CollectionField[];
  onChange: (fields: CollectionField[]) => void;
}

export function FieldPicker({ fields, onChange }: FieldPickerProps) {
  const [showEditor, setShowEditor] = useState(false);

  const toggleField = (id: string, checked: boolean) => {
    if (checked) {
      // Field is being re-enabled — shouldn't happen since we remove, but guard
      return;
    }
    // Remove field
    onChange(fields.filter((f) => f.id !== id));
  };

  const toggleRequired = (id: string, required: boolean) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, required } : f)));
  };

  const updateVerification = (id: string, verification: VerificationMethod) => {
    onChange(fields.map((f) => (f.id === id ? { ...f, verification } : f)));
  };

  const addField = (field: CollectionField) => {
    onChange([...fields, field]);
    setShowEditor(false);
  };

  const removeField = (id: string) => {
    onChange(fields.filter((f) => f.id !== id));
  };

  const universalFields = fields.filter((f) => f.category === "universal");
  const industryFields = fields.filter(
    (f) => f.category !== "universal" && f.category !== "other"
  );
  const customFields = fields.filter(
    (f) => f.id.startsWith("custom_") || (f.category === "other" && !["address", "company_name", "reason_for_calling"].includes(f.id))
  );
  const otherPresetFields = fields.filter(
    (f) => f.category === "other" && !f.id.startsWith("custom_")
  );

  const renderFieldRow = (field: CollectionField, removable: boolean) => (
    <div
      key={field.id}
      className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="shrink-0">
        <span className="text-sm font-medium">{field.label}</span>
      </div>

      <div className="flex items-center gap-2 sm:ml-auto shrink-0">
        <div className="flex items-center gap-1.5">
          <Switch
            checked={field.required}
            onCheckedChange={(v) => toggleRequired(field.id, v)}
            className="scale-75"
          />
          <span className="text-xs text-muted-foreground w-14">
            {field.required ? "Required" : "Optional"}
          </span>
        </div>

        <Select
          value={field.verification}
          onValueChange={(v) => updateVerification(field.id, v as VerificationMethod)}
        >
          <SelectTrigger className="h-7 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {verificationOptions.map((vo) => (
              <SelectItem key={vo.value} value={vo.value} className="text-xs">
                {vo.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {removable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => removeField(field.id)}
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {universalFields.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Basic Info</p>
            <Badge variant="secondary" className="text-xs">
              Universal
            </Badge>
          </div>
          <div className="space-y-1.5">
            {universalFields.map((f) => renderFieldRow(f, false))}
          </div>
        </div>
      )}

      {industryFields.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Industry Fields</p>
            <Badge variant="secondary" className="text-xs">
              Recommended
            </Badge>
          </div>
          <div className="space-y-1.5">
            {industryFields.map((f) => renderFieldRow(f, true))}
          </div>
        </div>
      )}

      {otherPresetFields.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Other Fields</p>
          <div className="space-y-1.5">
            {otherPresetFields.map((f) => renderFieldRow(f, true))}
          </div>
        </div>
      )}

      {customFields.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Custom Fields</p>
            <Badge variant="outline" className="text-xs">
              Custom
            </Badge>
          </div>
          <div className="space-y-1.5">
            {customFields.map((f) => renderFieldRow(f, true))}
          </div>
        </div>
      )}

      {showEditor ? (
        <FieldEditor
          onAdd={addField}
          onCancel={() => setShowEditor(false)}
        />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowEditor(true)}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Custom Field
        </Button>
      )}
    </div>
  );
}
