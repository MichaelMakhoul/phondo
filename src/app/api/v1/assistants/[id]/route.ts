import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { promptConfigSchema, afterHoursConfigSchema } from "@/lib/prompt-builder";
import { z } from "zod";
import { resolveVoiceId } from "@/lib/voices";
import { assistantSettingsSchema } from "@/lib/validation/assistant-settings";

interface Membership {
  organization_id: string;
  role?: string;
}

interface Assistant {
  id: string;
  name: string;
  vapi_assistant_id: string | null;
  model_provider: string;
  model: string;
  system_prompt: string;
  first_message: string;
  voice_provider: string;
  voice_id: string;
  prompt_config: Record<string, any> | null;
  settings: Record<string, any> | null;
}

const updateAssistantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  systemPrompt: z.string().min(1).optional(),
  firstMessage: z.string().min(1).optional(),
  voiceId: z.string().optional(),
  voiceProvider: z.string().optional(),
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  language: z.enum(["en", "es"]).optional(),
  knowledgeBase: z.any().optional(),
  tools: z.any().optional(),
  isActive: z.boolean().optional(),
  promptConfig: promptConfigSchema.nullable().optional(),
  afterHoursConfig: afterHoursConfigSchema.nullable().optional(),
  // SCRUM-347 (L4): strict, shared settings allow-list (stops mass-assignment
  // into the settings JSON the prompt builder consumes). Single source of truth
  // shared with the create route so they can't drift.
  settings: assistantSettingsSchema.optional(),
});

// GET /api/v1/assistants/[id] - Get a single assistant
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's organization
    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const { data: assistant, error } = await (supabase
      .from("assistants") as any)
      .select("*")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single();

    if (error || !assistant) {
      return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
    }

    return NextResponse.json(assistant);
  } catch (error) {
    console.error("Error getting assistant:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH /api/v1/assistants/[id] - Update an assistant
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's organization
    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // Get current assistant
    const { data: currentAssistant } = await (supabase
      .from("assistants") as any)
      .select("*")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single() as { data: Assistant | null };

    if (!currentAssistant) {
      return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
    }

    const body = await request.json();
    const validatedData = updateAssistantSchema.parse(body);

    // Resolve legacy short-name voice IDs (e.g. "rachel") to ElevenLabs IDs
    if (validatedData.voiceId) {
      validatedData.voiceId = resolveVoiceId(validatedData.voiceId);
    }

    // Merge incoming settings with existing to preserve fields like industry
    const mergedSettings: Record<string, any> = {
      ...(currentAssistant.settings || {}),
      ...(validatedData.settings || {}),
    };
    // Strip null values so stale ring-first fields are removed when switching to ai_first
    for (const key of Object.keys(mergedSettings)) {
      if (mergedSettings[key] === null) delete mergedSettings[key];
    }
    // SCRUM-411: Vapi sync removed — self-hosted reads the assistant from the DB.

    // Update in database (primary — self-hosted voice server reads from here)
    const updateData: Record<string, unknown> = {};
    if (validatedData.name) updateData.name = validatedData.name;
    if (validatedData.systemPrompt) updateData.system_prompt = validatedData.systemPrompt;
    if (validatedData.firstMessage) updateData.first_message = validatedData.firstMessage;
    if (validatedData.voiceId) updateData.voice_id = validatedData.voiceId;
    if (validatedData.voiceProvider) updateData.voice_provider = validatedData.voiceProvider;
    if (validatedData.model) updateData.model = validatedData.model;
    if (validatedData.modelProvider) updateData.model_provider = validatedData.modelProvider;
    if (validatedData.knowledgeBase !== undefined) updateData.knowledge_base = validatedData.knowledgeBase;
    if (validatedData.tools !== undefined) updateData.tools = validatedData.tools;
    if (validatedData.isActive !== undefined) updateData.is_active = validatedData.isActive;
    if (validatedData.promptConfig !== undefined) updateData.prompt_config = validatedData.promptConfig;
    if (validatedData.afterHoursConfig !== undefined) updateData.after_hours_config = validatedData.afterHoursConfig;
    if (validatedData.settings !== undefined) updateData.settings = mergedSettings;
    if (validatedData.language !== undefined) updateData.language = validatedData.language;

    // SCRUM-429 (finding #56): optimistic concurrency — the read-merge-write
    // above silently lost fields when two edits raced (last write clobbered
    // the first's merged settings). The update only applies if the row is
    // still at the version we read; the BEFORE UPDATE trigger bumps
    // updated_at on every write, so a concurrent edit makes this match 0
    // rows and the caller gets a 409 to reload + retry.
    const { data: updatedRows, error } = await (supabase
      .from("assistants") as any)
      .update(updateData)
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .eq("updated_at", (currentAssistant as any).updated_at)
      .select();

    if (error) {
      // SCRUM-347 (L1): log DB detail server-side, return a generic message.
      console.error("Error updating assistant (query):", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json(
        { error: "This assistant was modified by someone else while you were editing. Please reload and try again." },
        { status: 409 }
      );
    }

    return NextResponse.json(updatedRows[0]);
  } catch (error) {
    console.error("Error updating assistant:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/assistants/[id] - Delete an assistant
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user's organization and check admin role
    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    if (!["owner", "admin"].includes(membership.role || "")) {
      return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
    }

    // Get assistant
    const { data: assistant } = await (supabase
      .from("assistants") as any)
      .select("id")
      .eq("id", id)
      .eq("organization_id", membership.organization_id)
      .single() as { data: { id: string } | null };

    if (!assistant) {
      return NextResponse.json({ error: "Assistant not found" }, { status: 404 });
    }

    // SCRUM-411: Vapi delete removed.

    // Delete from database
    const { error } = await (supabase
      .from("assistants") as any)
      .delete()
      .eq("id", id)
      .eq("organization_id", membership.organization_id);

    if (error) {
      // SCRUM-347 (L1): log DB detail server-side, return a generic message.
      console.error("Error deleting assistant (query):", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting assistant:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
