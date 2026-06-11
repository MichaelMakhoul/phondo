import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { promptConfigSchema } from "@/lib/prompt-builder";
import { z } from "zod";
import { resolveVoiceId, DEFAULT_VOICE_ID } from "@/lib/voices";
import { assistantSettingsSchema } from "@/lib/validation/assistant-settings";
import { checkResourceLimit } from "@/lib/stripe/billing-service";
import { PLANS } from "@/lib/stripe/client";

interface Membership {
  organization_id: string;
}

const createAssistantSchema = z.object({
  name: z.string().min(1).max(100),
  systemPrompt: z.string().min(1),
  firstMessage: z.string().min(1),
  voiceId: z.string().default(DEFAULT_VOICE_ID),
  voiceProvider: z.string().default("11labs"),
  model: z.string().default("gpt-4.1-nano"),
  modelProvider: z.string().default("openai"),
  language: z.enum(["en", "es"]).default("en"),
  knowledgeBase: z.any().optional(),
  tools: z.any().optional(),
  promptConfig: promptConfigSchema.optional(),
  // SCRUM-347 (L4): strict, shared settings allow-list (stops mass-assignment).
  // Shared with the PATCH route so the two schemas can't drift.
  settings: assistantSettingsSchema.optional(),
});

// GET /api/v1/assistants - List all assistants
export async function GET() {
  try {
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

    const { data: assistants, error } = await (supabase
      .from("assistants") as any)
      .select("*")
      .eq("organization_id", membership.organization_id)
      .order("created_at", { ascending: false });

    if (error) {
      // SCRUM-430 (finding #40): log detail server-side, return generic.
      console.error("Assistants list DB error:", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    return NextResponse.json(assistants);
  } catch (error) {
    console.error("Error listing assistants:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/assistants - Create a new assistant
export async function POST(request: Request) {
  try {
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

    // Enforce plan assistant limit
    const limitCheck = await checkResourceLimit(membership.organization_id, "assistants");
    if (!limitCheck.allowed) {
      const planName = limitCheck.plan ? PLANS[limitCheck.plan].name : "current";
      return NextResponse.json({
        error: `Your ${planName} plan allows up to ${limitCheck.limit} assistant${limitCheck.limit === 1 ? "" : "s"}. Upgrade your plan to add more.`,
        code: "RESOURCE_LIMIT_REACHED",
        limit: limitCheck.limit,
        current: limitCheck.currentCount,
      }, { status: 403 });
    }

    const body = await request.json();
    const validatedData = createAssistantSchema.parse(body);

    // Resolve legacy short-name voice IDs (e.g. "rachel") to ElevenLabs IDs
    validatedData.voiceId = resolveVoiceId(validatedData.voiceId);

    // 1. Insert into DB FIRST (self-hosted voice server reads from DB)
    const { data: assistant, error } = await (supabase
      .from("assistants") as any)
      .insert({
        organization_id: membership.organization_id,
        name: validatedData.name,
        vapi_assistant_id: null, // legacy column, kept; no longer written (Vapi removed, SCRUM-411)
        system_prompt: validatedData.systemPrompt,
        first_message: validatedData.firstMessage,
        voice_id: validatedData.voiceId,
        voice_provider: validatedData.voiceProvider,
        model: validatedData.model,
        model_provider: validatedData.modelProvider,
        knowledge_base: validatedData.knowledgeBase,
        tools: validatedData.tools,
        is_active: true,
        prompt_config: validatedData.promptConfig || null,
        settings: validatedData.settings || {},
        language: validatedData.language,
      })
      .select()
      .single();

    if (error) {
      // SCRUM-347 (L1): log DB detail server-side, return a generic message.
      console.error("Error creating assistant (query):", error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    // SCRUM-411: Vapi backup/dual-write removed — self-hosted voice server is the sole pipeline (reads the assistant from the DB).


    return NextResponse.json(assistant, { status: 201 });
  } catch (error) {
    console.error("Error creating assistant:", error);
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
