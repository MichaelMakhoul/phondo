"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { ArrowLeft, Bot } from "lucide-react";
import { DEFAULT_RECORDING_DISCLOSURE } from "@/lib/templates";
import { VoiceSelector } from "@/components/voice-selector";
import { DEFAULT_VOICE_ID } from "@/lib/voices";

const DEFAULT_SYSTEM_PROMPT = `You are a friendly and professional AI receptionist for {{business_name}}. Your role is to:

1. Greet callers warmly and professionally
2. Answer questions about the business
3. Schedule appointments when requested
4. Take messages for the team
5. Handle common inquiries

Always be helpful, courteous, and efficient. If you don't know something, offer to take a message or suggest calling back during business hours.

Business hours: Monday-Friday, 9 AM - 5 PM
Address: [Your address here]`;

export default function NewAssistantPage() {
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [firstMessage, setFirstMessage] = useState(
    "Hello! Thank you for calling. How can I help you today?"
  );
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [recordingDisclosure, setRecordingDisclosure] = useState(
    DEFAULT_RECORDING_DISCLOSURE
  );
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Get current user and organization
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: membership } = await supabase
        .from("org_members")
        .select("organization_id")
        .eq("user_id", user.id)
        .single();

      if (!membership) throw new Error("No organization found");

      // Create assistant via API route
      const vapiResponse = await fetch("/api/v1/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          systemPrompt,
          firstMessage,
          voiceId,
          voiceProvider: "11labs",
          settings: {
            recordingEnabled,
            recordingDisclosure,
          },
        }),
      });

      if (!vapiResponse.ok) {
        const error = await vapiResponse.json();
        throw new Error(error.error || error.message || "Failed to create assistant");
      }

      const assistant = await vapiResponse.json();

      toast({
        title: "Assistant created!",
        description: `${name} is ready to answer calls.`,
      });

      router.push(`/assistants/${assistant.id}`);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create assistant",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/assistants">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Create Assistant</h1>
          <p className="text-muted-foreground">
            Set up a new AI receptionist for your business
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Basic Information
            </CardTitle>
            <CardDescription>
              Give your assistant a name and configure its personality
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Assistant Name</Label>
              <Input
                id="name"
                placeholder="e.g., Sarah - Front Desk"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="firstMessage">Greeting Message</Label>
              <Textarea
                id="firstMessage"
                placeholder="What should the assistant say when answering?"
                value={firstMessage}
                onChange={(e) => setFirstMessage(e.target.value)}
                required
                rows={2}
              />
              <p className="text-xs text-muted-foreground">
                This is the first thing callers will hear
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="systemPrompt">Instructions (System Prompt)</Label>
              <Textarea
                id="systemPrompt"
                placeholder="Describe how the assistant should behave..."
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                required
                rows={10}
              />
              <p className="text-xs text-muted-foreground">
                Tell the AI how to behave, what information to provide, and how to handle different scenarios
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Voice */}
        <Card>
          <CardHeader>
            <CardTitle>Voice</CardTitle>
            <CardDescription>
              Choose the voice for your assistant
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Voice</Label>
              <VoiceSelector value={voiceId} onChange={setVoiceId} />
            </div>
          </CardContent>
        </Card>

        {/* Recording — configured at org level in Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Call Recording</CardTitle>
            <CardDescription>
              Recording disclosure is managed in your business settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Call recording and disclosure settings apply to all assistants and are configured in{" "}
              <a href="/settings" className="text-primary underline underline-offset-4 hover:text-primary/80">Settings</a>.
            </p>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex justify-end gap-4">
          <Link href="/assistants">
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? "Creating..." : "Create Assistant"}
          </Button>
        </div>
      </form>
    </div>
  );
}
