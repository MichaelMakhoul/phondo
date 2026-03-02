"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Clock,
  Mic,
  Phone,
  ShieldAlert,
  BookOpen,
  Settings,
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { getIndustryTemplates, DEFAULT_RECORDING_DISCLOSURE } from "@/lib/templates";
import { PromptBuilder } from "@/components/prompt-builder";
import type { PromptConfig, AfterHoursConfig } from "@/lib/prompt-builder/types";
import { VoiceSelector } from "@/components/voice-selector";
import { resolveVoiceId, type VoiceLanguage } from "@/lib/voices";
import { AnswerModeCard } from "@/app/(dashboard)/settings/answer-mode-card";
import { PiiRedactionCard } from "@/app/(dashboard)/settings/pii-redaction-card";
import {
  trackAssistantUpdated,
  trackTemplateApplied,
  trackTransferRuleCreated,
  trackTransferRuleDeleted,
} from "@/lib/analytics";

// Industry templates
const INDUSTRY_TEMPLATES = getIndustryTemplates();

/** Parse a comma-separated keyword string into a trimmed, non-empty array. */
function parseKeywords(input: string): string[] {
  return input.split(",").map((k) => k.trim()).filter(Boolean);
}

interface Assistant {
  id: string;
  name: string;
  system_prompt: string;
  first_message: string;
  voice_id: string;
  voice_provider: string;
  language?: string;
  is_active: boolean;
  settings: Record<string, any>;
  prompt_config: Record<string, any> | null;
  after_hours_config: AfterHoursConfig | null;
  phone_numbers?: { id: string; phone_number: string }[];
  organization_id?: string;
}

interface TransferRule {
  id: string;
  name: string;
  trigger_keywords: string[];
  trigger_intent: string | null;
  transfer_to_phone: string;
  transfer_to_name: string | null;
  announcement_message: string | null;
  priority: number;
  is_active: boolean;
  destinations: { phone: string; name: string }[];
  require_confirmation: boolean;
}

interface AssistantBuilderProps {
  assistant: Assistant;
  organizationId: string;
  transferRules: TransferRule[];
  hasBusinessHours: boolean;
  hasTimezone: boolean;
}

export function AssistantBuilder({
  assistant,
  organizationId,
  transferRules: initialTransferRules,
  hasBusinessHours,
  hasTimezone,
}: AssistantBuilderProps) {
  const router = useRouter();
  const { toast } = useToast();

  // Basic info state
  const [name, setName] = useState(assistant.name);
  const [systemPrompt, setSystemPrompt] = useState(assistant.system_prompt);
  const [firstMessage, setFirstMessage] = useState(assistant.first_message);
  const [voiceId, setVoiceId] = useState(resolveVoiceId(assistant.voice_id));
  const [language, setLanguage] = useState<VoiceLanguage>((assistant.language as VoiceLanguage) || "en");
  const [initialLanguage] = useState<VoiceLanguage>((assistant.language as VoiceLanguage) || "en");
  const [isActive, setIsActive] = useState(assistant.is_active);

  // Detect greeting/language mismatch after language change
  const greetingLanguageMismatch = (() => {
    if (language === initialLanguage || !firstMessage.trim()) return false;
    const hasSpanish = /[áéíóúñ¡¿]/.test(firstMessage) || /\b(hola|gracias|llamar|ayudar)\b/i.test(firstMessage);
    const hasEnglish = /\b(hello|hi|thanks|thank|calling|help|welcome)\b/i.test(firstMessage);
    if (language === "es" && hasEnglish && !hasSpanish) return true;
    if (language === "en" && hasSpanish && !hasEnglish) return true;
    return false;
  })();

  const defaultGreetings: Record<VoiceLanguage, string> = {
    en: `Hi there! Thanks for calling ${name}. How can I help you today?`,
    es: `¡Hola! Gracias por llamar a ${name}. ¿En qué puedo ayudarle hoy?`,
  };

  // Settings state
  const [maxCallDuration, setMaxCallDuration] = useState(
    assistant.settings?.maxCallDuration || 600
  );
  const [spamFilterEnabled, setSpamFilterEnabled] = useState(
    assistant.settings?.spamFilterEnabled ?? true
  );
  const [recordingEnabled, setRecordingEnabled] = useState(
    assistant.settings?.recordingEnabled ?? true
  );
  const [recordingDisclosure, setRecordingDisclosure] = useState(
    assistant.settings?.recordingDisclosure ?? DEFAULT_RECORDING_DISCLOSURE
  );

  // Transfer rules state
  const [transferRules, setTransferRules] = useState(initialTransferRules);
  const [transferEnabled, setTransferEnabled] = useState(transferRules.length > 0);
  const [newTransferPhone, setNewTransferPhone] = useState("");
  const [newTransferName, setNewTransferName] = useState("");
  const [newTriggerKeywords, setNewTriggerKeywords] = useState("");
  const [newTriggerIntent, setNewTriggerIntent] = useState("");
  const [newAnnouncement, setNewAnnouncement] = useState("");
  const [newPriority, setNewPriority] = useState(0);
  const [newRequireConfirmation, setNewRequireConfirmation] = useState(false);

  // Inline edit state
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    transfer_to_phone: string;
    transfer_to_name: string;
    trigger_keywords: string;
    trigger_intent: string;
    announcement_message: string;
    priority: number;
    destinations: { phone: string; name: string }[];
    require_confirmation: boolean;
  }>({
    name: "",
    transfer_to_phone: "",
    transfer_to_name: "",
    trigger_keywords: "",
    trigger_intent: "",
    announcement_message: "",
    priority: 0,
    destinations: [],
    require_confirmation: false,
  });
  const [isEditSaving, setIsEditSaving] = useState(false);

  // Prompt builder state
  const [promptConfig, setPromptConfig] = useState<PromptConfig | null>(
    (assistant.prompt_config as PromptConfig) || null
  );
  const [useGuidedBuilder, setUseGuidedBuilder] = useState(
    assistant.prompt_config !== null
  );

  // After-hours config state
  const [afterHoursGreeting, setAfterHoursGreeting] = useState(
    assistant.after_hours_config?.greeting || ""
  );
  const [afterHoursInstructions, setAfterHoursInstructions] = useState(
    assistant.after_hours_config?.customInstructions || ""
  );
  const [afterHoursDisableScheduling, setAfterHoursDisableScheduling] = useState(
    assistant.after_hours_config?.disableScheduling ?? true
  );

  // Saving state
  const [isSaving, setIsSaving] = useState(false);

  // Apply industry template
  const applyTemplate = (industryKey: string) => {
    const template = INDUSTRY_TEMPLATES.find((t) => t.industry === industryKey);
    if (template) {
      setSystemPrompt(template.systemPrompt);
      setFirstMessage(template.firstMessage);
      if (template.voiceId) {
        setVoiceId(template.voiceId);
      }
      trackTemplateApplied(industryKey);
      toast({
        title: "Template Applied",
        description: `Applied ${template.name} template. You can customize it further.`,
      });
    }
  };

  // Save assistant
  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch(`/api/v1/assistants/${assistant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          systemPrompt,
          firstMessage,
          voiceId,
          language,
          isActive,
          settings: {
            ...assistant.settings,
            maxCallDuration,
            spamFilterEnabled,
            recordingEnabled,
            recordingDisclosure,
          },
          promptConfig: useGuidedBuilder ? promptConfig : null,
          afterHoursConfig: promptConfig?.behaviors?.afterHoursHandling
            ? {
                greeting: afterHoursGreeting || undefined,
                customInstructions: afterHoursInstructions || undefined,
                disableScheduling: afterHoursDisableScheduling,
              }
            : null,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.error || "Failed to save assistant");
      }

      toast({
        title: "Saved",
        description: "Assistant settings have been updated.",
      });
      trackAssistantUpdated("general");

      router.refresh();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save assistant settings.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Add transfer rule
  const addTransferRule = async () => {
    if (!newTransferPhone) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please enter a phone number for transfers.",
      });
      return;
    }

    try {
      const keywords = newTriggerKeywords
        ? parseKeywords(newTriggerKeywords)
        : ["speak to a human", "talk to someone", "representative"];

      const response = await fetch("/api/v1/transfer/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistantId: assistant.id,
          name: newTransferName || "Default Transfer",
          transferToPhone: newTransferPhone,
          transferToName: newTransferName || null,
          triggerKeywords: keywords,
          triggerIntent: newTriggerIntent || undefined,
          announcementMessage: newAnnouncement || undefined,
          priority: newPriority || undefined,
          requireConfirmation: newRequireConfirmation,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create transfer rule");
      }

      const { rule } = await response.json();
      setTransferRules([...transferRules, rule]);
      setNewTransferPhone("");
      setNewTransferName("");
      setNewTriggerKeywords("");
      setNewTriggerIntent("");
      setNewAnnouncement("");
      setNewPriority(0);
      setNewRequireConfirmation(false);

      trackTransferRuleCreated();
      toast({
        title: "Transfer Rule Added",
        description: "Callers can now be transferred to this number.",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to add transfer rule.",
      });
    }
  };

  // Delete transfer rule
  const deleteTransferRule = async (ruleId: string) => {
    try {
      const response = await fetch(`/api/v1/transfer/rules/${ruleId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete transfer rule");
      }

      setTransferRules(transferRules.filter((r) => r.id !== ruleId));
      trackTransferRuleDeleted();

      toast({
        title: "Transfer Rule Deleted",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete transfer rule.",
      });
    }
  };

  // Start editing a transfer rule
  const startEditRule = (rule: TransferRule) => {
    setEditingRuleId(rule.id);
    setEditForm({
      name: rule.name,
      transfer_to_phone: rule.transfer_to_phone,
      transfer_to_name: rule.transfer_to_name || "",
      trigger_keywords: (rule.trigger_keywords || []).join(", "),
      trigger_intent: rule.trigger_intent || "",
      announcement_message: rule.announcement_message || "",
      priority: rule.priority,
      destinations: rule.destinations || [],
      require_confirmation: rule.require_confirmation ?? false,
    });
  };

  // Save edited transfer rule
  const saveEditRule = async () => {
    if (!editingRuleId) return;
    setIsEditSaving(true);
    try {
      const keywords = editForm.trigger_keywords
        ? parseKeywords(editForm.trigger_keywords)
        : [];

      const response = await fetch(`/api/v1/transfer/rules/${editingRuleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name,
          transferToPhone: editForm.transfer_to_phone,
          transferToName: editForm.transfer_to_name || null,
          triggerKeywords: keywords,
          triggerIntent: editForm.trigger_intent || null,
          announcementMessage: editForm.announcement_message || null,
          priority: editForm.priority,
          destinations: editForm.destinations.filter(d => d.phone.trim()),
          requireConfirmation: editForm.require_confirmation,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to update transfer rule");
      }

      setTransferRules(
        transferRules.map((r) =>
          r.id === editingRuleId
            ? {
                ...r,
                name: editForm.name,
                transfer_to_phone: editForm.transfer_to_phone,
                transfer_to_name: editForm.transfer_to_name || null,
                trigger_keywords: keywords,
                trigger_intent: editForm.trigger_intent || null,
                announcement_message: editForm.announcement_message || null,
                priority: editForm.priority,
                destinations: editForm.destinations.filter(d => d.phone.trim()),
                require_confirmation: editForm.require_confirmation,
              }
            : r
        )
      );
      setEditingRuleId(null);

      toast({
        title: "Transfer Rule Updated",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update transfer rule.",
      });
    } finally {
      setIsEditSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/assistants">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{assistant.name}</h1>
              <Badge variant={isActive ? "success" : "secondary"}>
                {isActive ? "Active" : "Inactive"}
              </Badge>
            </div>
            {assistant.phone_numbers && assistant.phone_numbers.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {assistant.phone_numbers.map((p) => p.phone_number).join(", ")}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/assistants/${assistant.id}/test`}>
            <Button variant="outline">
              <Phone className="h-4 w-4 mr-2" />
              Test Call
            </Button>
          </Link>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="basics" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="basics" className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Basics
          </TabsTrigger>
          <TabsTrigger value="voice" className="flex items-center gap-2">
            <Mic className="h-4 w-4" />
            Voice
          </TabsTrigger>
          <TabsTrigger value="transfers" className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Transfers
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Settings
          </TabsTrigger>
        </TabsList>

        {/* Basics Tab */}
        <TabsContent value="basics" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
              <CardDescription>
                Configure your assistant's name and how it introduces itself
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Assistant Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Sarah - Front Desk"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="firstMessage">Greeting Message</Label>
                <Textarea
                  id="firstMessage"
                  value={firstMessage}
                  onChange={(e) => setFirstMessage(e.target.value)}
                  rows={2}
                  placeholder="What should the assistant say when answering?"
                />
                <p className="text-xs text-muted-foreground">
                  This is the first thing callers will hear
                </p>
                {greetingLanguageMismatch && (
                  <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-yellow-700 dark:text-yellow-300">
                        Your greeting appears to be in {language === "es" ? "English" : "Spanish"}, but the assistant language is set to {language === "es" ? "Spanish" : "English"}.
                      </p>
                      <button
                        type="button"
                        className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                        onClick={() => setFirstMessage(defaultGreetings[language])}
                      >
                        Use default {language === "es" ? "Spanish" : "English"} greeting
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label>Active Status</Label>
                  <p className="text-xs text-muted-foreground">
                    When inactive, calls will go to voicemail
                  </p>
                </div>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Instructions (System Prompt)</CardTitle>
              <CardDescription>
                Tell your AI how to behave and what information to provide
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {useGuidedBuilder ? (
                <PromptBuilder
                  config={promptConfig}
                  industry="other"
                  businessName={name}
                  systemPrompt={systemPrompt}
                  firstMessage={firstMessage}
                  onChange={(updates) => {
                    setSystemPrompt(updates.systemPrompt);
                    setFirstMessage(updates.firstMessage);
                    setPromptConfig(updates.promptConfig);
                  }}
                  variant="dashboard"
                />
              ) : (
                <>
                  <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/50 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                          Try the Guided Prompt Builder
                        </p>
                        <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
                          Configure your assistant visually — pick fields, toggle behaviors, and choose a tone without writing prompts.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          setUseGuidedBuilder(true);
                          // Keep existing prompt in advanced editor
                        }}
                      >
                        Switch to Guided
                      </Button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Select onValueChange={applyTemplate}>
                      <SelectTrigger className="w-[200px]">
                        <SelectValue placeholder="Apply Template" />
                      </SelectTrigger>
                      <SelectContent>
                        {INDUSTRY_TEMPLATES.map((template) => (
                          <SelectItem key={template.industry} value={template.industry}>
                            {template.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground self-center">
                      Start with an industry template and customize
                    </p>
                  </div>

                  <Textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={15}
                    placeholder="Describe how the assistant should behave..."
                    className="font-mono text-sm"
                  />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Voice Tab */}
        <TabsContent value="voice" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Voice & Language</CardTitle>
              <CardDescription>
                Choose the language and voice for your assistant
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Language</Label>
                <Select value={language} onValueChange={(v) => setLanguage(v as VoiceLanguage)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="es">Español (Spanish)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The assistant will conduct calls entirely in this language.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Voice</Label>
                <VoiceSelector value={voiceId} onChange={setVoiceId} language={language} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Transfers Tab */}
        <TabsContent value="transfers" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Phone className="h-5 w-5" />
                Call Transfers
              </CardTitle>
              <CardDescription>
                Configure when and where calls should be transferred to a human
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Enable Call Transfers</Label>
                  <p className="text-xs text-muted-foreground">
                    Allow callers to be transferred to a human when needed
                  </p>
                </div>
                <Switch
                  checked={transferEnabled}
                  onCheckedChange={setTransferEnabled}
                />
              </div>

              {transferEnabled && (
                <>
                  <div className="border-t pt-4 space-y-3">
                    <Label className="mb-2 block">Add Transfer Destination</Label>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Phone number"
                        value={newTransferPhone}
                        onChange={(e) => setNewTransferPhone(e.target.value)}
                        className="flex-1"
                      />
                      <Input
                        placeholder="Name (optional)"
                        value={newTransferName}
                        onChange={(e) => setNewTransferName(e.target.value)}
                        className="flex-1"
                      />
                      <Button onClick={addTransferRule}>
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1 space-y-1">
                        <Input
                          placeholder="Trigger keywords (comma-separated)"
                          value={newTriggerKeywords}
                          onChange={(e) => setNewTriggerKeywords(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          When the AI determines the caller needs help with these topics, it will transfer. Defaults to general phrases if empty.
                        </p>
                      </div>
                      <div className="flex-1 space-y-1">
                        <Input
                          placeholder="Category (optional)"
                          value={newTriggerIntent}
                          onChange={(e) => setNewTriggerIntent(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          e.g. billing_inquiry, emergency
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1 space-y-1">
                        <Input
                          placeholder="Announcement message (optional)"
                          value={newAnnouncement}
                          onChange={(e) => setNewAnnouncement(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          What the AI says before transferring. Uses a default if empty.
                        </p>
                      </div>
                      <div className="w-32 space-y-1">
                        <Input
                          type="number"
                          placeholder="Priority"
                          value={newPriority || ""}
                          onChange={(e) => setNewPriority(parseInt(e.target.value) || 0)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Higher = checked first
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={newRequireConfirmation}
                        onCheckedChange={setNewRequireConfirmation}
                      />
                      <Label className="text-sm">Ask caller to confirm before transferring</Label>
                    </div>
                  </div>

                  {transferRules.length > 0 && (
                    <div className="space-y-2">
                      {transferRules.map((rule) =>
                        editingRuleId === rule.id ? (
                          <div
                            key={rule.id}
                            className="p-3 border rounded-lg space-y-3 bg-muted/30"
                          >
                            <div className="flex gap-2">
                              <Input
                                placeholder="Rule name"
                                value={editForm.name}
                                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                                className="flex-1"
                              />
                              <Input
                                placeholder="Phone number"
                                value={editForm.transfer_to_phone}
                                onChange={(e) => setEditForm({ ...editForm, transfer_to_phone: e.target.value })}
                                className="flex-1"
                              />
                              <Input
                                placeholder="Name (optional)"
                                value={editForm.transfer_to_name}
                                onChange={(e) => setEditForm({ ...editForm, transfer_to_name: e.target.value })}
                                className="flex-1"
                              />
                            </div>
                            <div className="flex gap-2">
                              <div className="flex-1">
                                <Input
                                  placeholder="Trigger keywords (comma-separated)"
                                  value={editForm.trigger_keywords}
                                  onChange={(e) => setEditForm({ ...editForm, trigger_keywords: e.target.value })}
                                />
                              </div>
                              <div className="flex-1">
                                <Input
                                  placeholder="Category (optional)"
                                  value={editForm.trigger_intent}
                                  onChange={(e) => setEditForm({ ...editForm, trigger_intent: e.target.value })}
                                />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Input
                                placeholder="Announcement message (optional)"
                                value={editForm.announcement_message}
                                onChange={(e) => setEditForm({ ...editForm, announcement_message: e.target.value })}
                                className="flex-1"
                              />
                              <Input
                                type="number"
                                placeholder="Priority"
                                value={editForm.priority}
                                onChange={(e) => setEditForm({ ...editForm, priority: parseInt(e.target.value) || 0 })}
                                className="w-24"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Switch
                                  checked={editForm.require_confirmation}
                                  onCheckedChange={(v) => setEditForm({ ...editForm, require_confirmation: v })}
                                />
                                <Label className="text-sm">Ask caller to confirm before transferring</Label>
                              </div>
                              <p className="text-xs text-muted-foreground ml-11">
                                The AI asks once before dialing. Fallback numbers are tried automatically without re-asking.
                              </p>
                            </div>
                            <div className="space-y-2">
                              <Label className="text-sm">Fallback Destinations</Label>
                              <p className="text-xs text-muted-foreground">
                                If the primary number doesn&apos;t answer, these numbers are tried in order.
                                After all numbers are tried, the caller returns to the AI, which will offer to take a message or schedule a callback.
                              </p>
                              {editForm.destinations.map((dest, i) => (
                                <div key={i} className="flex gap-2">
                                  <Input
                                    placeholder="Phone"
                                    value={dest.phone}
                                    onChange={(e) => {
                                      const updated = [...editForm.destinations];
                                      updated[i] = { ...updated[i], phone: e.target.value };
                                      setEditForm({ ...editForm, destinations: updated });
                                    }}
                                    className="flex-1"
                                  />
                                  <Input
                                    placeholder="Name"
                                    value={dest.name}
                                    onChange={(e) => {
                                      const updated = [...editForm.destinations];
                                      updated[i] = { ...updated[i], name: e.target.value };
                                      setEditForm({ ...editForm, destinations: updated });
                                    }}
                                    className="flex-1"
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                      const updated = editForm.destinations.filter((_, idx) => idx !== i);
                                      setEditForm({ ...editForm, destinations: updated });
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              ))}
                              {editForm.destinations.length < 5 && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setEditForm({
                                    ...editForm,
                                    destinations: [...editForm.destinations, { phone: "", name: "" }],
                                  })}
                                >
                                  <Plus className="h-4 w-4 mr-1" /> Add Fallback
                                </Button>
                              )}
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingRuleId(null)}
                              >
                                <X className="h-4 w-4 mr-1" />
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                onClick={saveEditRule}
                                disabled={isEditSaving}
                              >
                                {isEditSaving ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <Save className="h-4 w-4 mr-1" />
                                )}
                                Save
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div
                            key={rule.id}
                            className="flex items-center justify-between p-3 border rounded-lg"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">
                                {rule.transfer_to_name || rule.transfer_to_phone}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {rule.transfer_to_phone}
                              </p>
                              {rule.trigger_keywords && rule.trigger_keywords.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {rule.trigger_keywords.map((kw, i) => (
                                    <Badge key={i} variant="secondary" className="text-xs">
                                      {kw}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              {(rule.require_confirmation || (rule.destinations && rule.destinations.length > 0)) && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {rule.destinations && rule.destinations.length > 0 && (
                                    <Badge variant="outline" className="text-xs">
                                      +{rule.destinations.length} fallback{rule.destinations.length > 1 ? "s" : ""}
                                    </Badge>
                                  )}
                                  {rule.require_confirmation && (
                                    <Badge variant="outline" className="text-xs">
                                      Confirmation required
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1 ml-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => startEditRule(rule)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => deleteTransferRule(rule.id)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Call Settings
              </CardTitle>
              <CardDescription>
                Configure call handling behavior
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Maximum Call Duration (seconds)</Label>
                <Input
                  type="number"
                  value={maxCallDuration}
                  onChange={(e) => setMaxCallDuration(parseInt(e.target.value) || 600)}
                  min={60}
                  max={3600}
                />
                <p className="text-xs text-muted-foreground">
                  Calls will automatically end after this duration (default: 10 minutes)
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <Label className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4" />
                    Spam Call Filtering
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically detect and filter spam calls
                  </p>
                </div>
                <Switch
                  checked={spamFilterEnabled}
                  onCheckedChange={setSpamFilterEnabled}
                />
              </div>

              <div className="border-t pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Call Recording</Label>
                    <p className="text-xs text-muted-foreground">
                      Record calls for quality assurance. A disclosure will be
                      played at the start of each call.
                    </p>
                  </div>
                  <Switch
                    checked={recordingEnabled}
                    onCheckedChange={setRecordingEnabled}
                  />
                </div>

                {recordingEnabled && (
                  <div className="space-y-2">
                    <Label htmlFor="recordingDisclosure">
                      Recording & AI Disclosure
                    </Label>
                    <Textarea
                      id="recordingDisclosure"
                      value={recordingDisclosure}
                      onChange={(e) => setRecordingDisclosure(e.target.value)}
                      rows={4}
                      placeholder="Disclosure message played before the greeting..."
                    />
                    <p className="text-xs text-muted-foreground">
                      This message is spoken before your greeting. Use{" "}
                      <code className="bg-muted px-1 rounded">
                        {"{business_name}"}
                      </code>{" "}
                      to insert your business name. Callers who decline
                      recording will be offered a transfer to a team member.
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <AnswerModeCard
            assistantId={assistant.id}
            initialSettings={{
              answerMode: assistant.settings?.answerMode || "ai_first",
              ringFirstNumber: assistant.settings?.ringFirstNumber || "",
              ringFirstTimeout: assistant.settings?.ringFirstTimeout || 20,
            }}
          />

          <PiiRedactionCard
            assistantId={assistant.id}
            initialEnabled={assistant.settings?.piiRedactionEnabled || false}
          />

          {promptConfig?.behaviors?.afterHoursHandling && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  After-Hours Settings
                </CardTitle>
                <CardDescription>
                  Customize how your AI handles calls outside business hours
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {(!hasTimezone || !hasBusinessHours) && (
                  <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
                    <div className="text-sm text-yellow-800 dark:text-yellow-200">
                      <p className="font-medium">
                        {!hasTimezone && !hasBusinessHours
                          ? "Timezone and business hours are not configured."
                          : !hasTimezone
                            ? "Timezone is not configured."
                            : "Business hours are not configured."}
                      </p>
                      <p className="mt-1 text-yellow-700 dark:text-yellow-400">
                        After-hours detection requires both to work correctly. Without them, all calls will be treated as during business hours.{" "}
                        <Link href="/settings" className="font-medium underline hover:no-underline">
                          Go to Business Settings
                        </Link>
                      </p>
                    </div>
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="afterHoursGreeting">After-Hours Greeting</Label>
                  <Textarea
                    id="afterHoursGreeting"
                    value={afterHoursGreeting}
                    onChange={(e) => setAfterHoursGreeting(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="Leave empty to auto-generate based on your tone setting..."
                  />
                  <p className="text-xs text-muted-foreground">
                    Custom greeting for after-hours calls. Use{" "}
                    <code className="bg-muted px-1 rounded">{"{business_name}"}</code>{" "}
                    to insert your business name. Leave empty for an auto-generated greeting.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="afterHoursInstructions">
                    Additional After-Hours Instructions
                  </Label>
                  <Textarea
                    id="afterHoursInstructions"
                    value={afterHoursInstructions}
                    onChange={(e) => setAfterHoursInstructions(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="e.g., For dental emergencies, provide the after-hours emergency number: 0400 123 456"
                  />
                  <p className="text-xs text-muted-foreground">
                    Extra instructions the AI should follow during after-hours calls
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <Label>Disable Scheduling After Hours</Label>
                    <p className="text-xs text-muted-foreground">
                      Prevent the AI from offering to book appointments outside business hours
                    </p>
                  </div>
                  <Switch
                    checked={afterHoursDisableScheduling}
                    onCheckedChange={setAfterHoursDisableScheduling}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                Knowledge Base
              </CardTitle>
              <CardDescription>
                Manage the business information your AI uses to answer questions
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/settings/knowledge">
                <Button variant="outline">Manage Knowledge Sources</Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Technical Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Assistant ID</span>
                <code className="bg-muted px-2 py-1 rounded">{assistant.id}</code>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
