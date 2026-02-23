import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS, getDisplayPlans } from "@/lib/stripe/client";
import type { PlanType } from "@/lib/stripe/client";

// Allowed plan types for self-service trial creation
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

    const body = await request.json();
    const { organizationId, planType } = body as {
      organizationId: string;
      planType: string;
    };

    if (!organizationId || !planType) {
      return NextResponse.json(
        { error: "Missing organizationId or planType" },
        { status: 400 }
      );
    }

    // Validate plan is one of the allowed SMB plans (not agency tiers)
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

    // Look up plan config from server-side constants (not client input)
    const planConfig = PLANS[planType as PlanType];

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);

    // Use admin client (service_role) to bypass RLS — only server can write subscriptions
    const admin = createAdminClient();

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
        stripe_price_id: `price_trial_${planType}`,
        stripe_subscription_id: `sub_trial_${Date.now()}`,
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
