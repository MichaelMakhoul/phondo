import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS, getDisplayPlans } from "@/lib/stripe/client";
import type { PlanType } from "@/lib/stripe/client";
import { isValidUUID } from "@/lib/security/validation";

// Restrict to SMB plans only — prevents self-service creation of agency-tier trials
const ALLOWED_TRIAL_PLANS = new Set(getDisplayPlans().map((p) => p.id));

// POST /api/v1/subscriptions/trial — Create a trial subscription (server-side)
export async function POST(request: Request) {
  try {
    // Authenticate user via session cookie
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: { organizationId?: string; planType?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { organizationId, planType } = body;

    if (!organizationId || !planType) {
      return NextResponse.json(
        { error: "Missing organizationId or planType" },
        { status: 400 }
      );
    }

    if (!isValidUUID(organizationId)) {
      return NextResponse.json(
        { error: "Invalid organizationId" },
        { status: 400 }
      );
    }

    // Only SMB plans allowed (no agency tiers)
    if (!ALLOWED_TRIAL_PLANS.has(planType as PlanType)) {
      return NextResponse.json(
        { error: "Invalid plan type" },
        { status: 400 }
      );
    }

    // Verify user is a member of the organization
    const { data: membership } = await supabase
      .from("org_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      return NextResponse.json(
        { error: "Not a member of this organization" },
        { status: 403 }
      );
    }

    // Use admin client (service_role) to bypass RLS — only server can write subscriptions
    const admin = createAdminClient();

    // Check for existing subscription (idempotent — double-clicks return success)
    const { data: existing } = await (admin as any)
      .from("subscriptions")
      .select("id, plan_type, status")
      .eq("organization_id", organizationId)
      .single();

    if (existing) {
      return NextResponse.json({ success: true });
    }

    // Look up plan config from server-side constants (not client input)
    const planConfig = PLANS[planType as PlanType];

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    const { error: subError } = await (admin as any)
      .from("subscriptions")
      .insert({
        organization_id: organizationId,
        plan_type: planType,
        status: "trialing",
        current_period_start: new Date().toISOString(),
        current_period_end: trialEnd.toISOString(),
        trial_end: trialEnd.toISOString(),
        calls_limit: planConfig.callsLimit,
        calls_used: 0,
        assistants_limit: planConfig.assistants,
        phone_numbers_limit: planConfig.phoneNumbers,
        // Placeholder IDs for trial — replaced by real Stripe IDs when user converts to paid
        stripe_price_id: `price_trial_${planType}`,
        stripe_subscription_id: `trial_${organizationId}`,
      });

    if (subError) {
      console.error("Failed to create trial subscription:", subError);
      return NextResponse.json(
        { error: "Failed to create subscription" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Trial subscription error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
