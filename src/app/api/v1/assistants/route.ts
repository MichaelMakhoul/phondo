import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVapiClient, ensureCalendarTools, buildVapiServerConfig } from "@/lib/vapi";
import { buildAnalysisPlan, buildPromptFromConfig, buildSchedulingSection, promptConfigSchema } from "@/lib/prompt-builder";
import type { PromptContext } from "@/lib/prompt-builder";
import { RECORDING_DECLINE_SYSTEM_INSTRUCTION, buildFirstMessageWithDisclosure, resolveRecordingSettings } from "@/lib/templates";
import type { PromptConfig } from "@/lib/prompt-builder/types";
import { getOrgScheduleContext } from "@/lib/supabase/get-org-schedule-context";
import { getAggregatedKnowledgeBase } from "@/lib/knowledge-base";
import { z } from "zod";
import { resolveVoiceId, DEFAULT_VOICE_ID } from "@/lib/voices";
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
  settings: z.object({
    recordingEnabled: z.boolean().optional(),
    recordingDisclosure: z.string().optional(),
    maxCallDuration: z.number().optional(),
    spamFilterEnabled: z.boolean().optional(),
    industry: z.string().optional(),
  }).passthrough().optional(),
});

// Map common voice provider names to Vapi's expected values
function normalizeVoiceProvider(provider: string): string {
  const providerMap: Record<string, string> = {
    elevenlabs: "11labs",
    "eleven-labs": "11labs",
  };
  return providerMap[provider.toLowerCase()] || provider;
}

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
      return NextResponse.json({ error: error.message }, { status: 500 });
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
        vapi_assistant_id: null, // Will be updated if Vapi creation succeeds
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
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 2. Attempt Vapi creation silently (non-fatal — self-hosted is primary)
    try {
      const serverConfig = buildVapiServerConfig();
      const analysisPlan = validatedData.promptConfig
        ? buildAnalysisPlan(validatedData.promptConfig)
        : null;

      const { timezone: orgTimezone, businessHours: orgBusinessHours, defaultAppointmentDuration } =
        await getOrgScheduleContext(supabase, membership.organization_id, "assistant creation");

      const aggregatedKB = await getAggregatedKnowledgeBase(
        supabase,
        membership.organization_id
      );

      let vapiSystemPrompt = validatedData.systemPrompt;
      if (validatedData.promptConfig) {
        const config = validatedData.promptConfig as PromptConfig;
        const industry = validatedData.settings?.industry || "other";
        const promptContext: PromptContext = {
          businessName: validatedData.name,
          industry,
          knowledgeBase: aggregatedKB || undefined,
          timezone: orgTimezone,
          businessHours: orgBusinessHours,
          defaultAppointmentDuration,
        };
        vapiSystemPrompt = buildPromptFromConfig(config, promptContext);
      } else if (aggregatedKB) {
        if (validatedData.systemPrompt.includes("{knowledge_base}")) {
          vapiSystemPrompt = validatedData.systemPrompt.replace(
            /{knowledge_base}/g,
            aggregatedKB
          );
        } else {
          vapiSystemPrompt = `${validatedData.systemPrompt}\n\nBusiness Information:\n${aggregatedKB}`;
        }
      }

      if (!validatedData.promptConfig) {
        vapiSystemPrompt += `\n\n${buildSchedulingSection(orgTimezone, orgBusinessHours, defaultAppointmentDuration)}`;
      }

      const toolIds = await ensureCalendarTools();

      const { recordingEnabled, recordingDisclosure } = resolveRecordingSettings(validatedData.settings);
      const vapiFirstMessage = buildFirstMessageWithDisclosure(
        validatedData.firstMessage,
        recordingDisclosure,
        validatedData.name
      );
      if (recordingEnabled) {
        vapiSystemPrompt = `${vapiSystemPrompt}\n\n${RECORDING_DECLINE_SYSTEM_INSTRUCTION}`;
      }

      const vapi = getVapiClient();
      const vapiAssistant = await vapi.createAssistant({
        name: validatedData.name,
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: vapiSystemPrompt }],
          toolIds,
        },
        voice: {
          provider: normalizeVoiceProvider(validatedData.voiceProvider),
          voiceId: validatedData.voiceId,
        },
        firstMessage: vapiFirstMessage,
        transcriber: {
          provider: "deepgram",
          model: validatedData.language === "es" ? "nova-3" : "nova-2",
          language: validatedData.language,
        },
        server: serverConfig,
        recordingEnabled,
        ...(analysisPlan && { analysisPlan }),
        metadata: {
          organizationId: membership.organization_id,
        },
      });

      // 3. Update DB with Vapi assistant ID
      await (supabase as any)
        .from("assistants")
        .update({ vapi_assistant_id: vapiAssistant.id })
        .eq("id", assistant.id);
    } catch (vapiErr) {
      // Vapi creation failed — not a blocker, self-hosted works from DB
      console.warn("[Assistants] Vapi backup creation failed (non-fatal):", vapiErr);
    }

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
