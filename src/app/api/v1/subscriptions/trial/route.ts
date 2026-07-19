import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLANS, getDisplayPlans } from "@/lib/stripe/client";
import type { PlanType } from "@/lib/stripe/client";
import { isValidUUID } from "@/lib/security/validation";
import { getClientIp, rateLimitDistributed } from "@/lib/security/rate-limiter";

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

    // SCRUM-412: gate trial creation on a verified email (anti-abuse — stops
    // throwaway / plus-addressed emails from claiming no-card trials at scale).
    if (!user.email_confirmed_at) {
      return NextResponse.json(
        { error: "Please verify your email before starting a trial." },
        { status: 403 }
      );
    }

    // SCRUM-412: per-IP rate limit (fail-open) as defense-in-depth against
    // scripted trial creation. The per-user owned-org cap (migration 00148) is
    // the primary guard; this just bounds rapid retries from one source.
    const admin = createAdminClient();
    const ip = getClientIp(request.headers);
    const rl = await rateLimitDistributed(admin, ip, "subscriptions-trial", "auth");
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again shortly." },
        { status: 429 }
      );
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

    // Verify user is an owner or admin of the organization (matches checkout route)
    const { data: membership } = await supabase
      .from("org_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", user.id)
      .single() as { data: { role: string } | null };

    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return NextResponse.json(
        { error: "Insufficient permissions" },
        { status: 403 }
      );
    }

    // `admin` (service_role) created above — bypasses RLS for the subscriptions write.
    // Check for existing subscription (idempotent — double-clicks return success)
    const { data: existing, error: existingError } = await (admin as any)
      .from("subscriptions")
      .select("id, plan_type, status")
      .eq("organization_id", organizationId)
      .single();

    if (existingError && existingError.code !== "PGRST116") {
      console.error("Failed to check existing subscription:", {
        organizationId,
        error: existingError,
      });
      return NextResponse.json(
        { error: "Failed to verify subscription status" },
        { status: 500 }
      );
    }

    if (existing) {
      return NextResponse.json({ success: true });
    }

    // Look up plan config from server-side constants (not client input)
    const plan: PlanType = planType as PlanType;
    const planConfig = PLANS[plan];

    const trialDays = "trialDays" in planConfig ? planConfig.trialDays : 30;
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + trialDays);

    // Upsert with onConflict for true idempotency (handles rare race between
    // the existence check above and this insert from concurrent requests)
    const { error: subError } = await (admin as any)
      .from("subscriptions")
      .upsert({
        organization_id: organizationId,
        plan_type: plan,
        status: "trialing",
        current_period_start: new Date().toISOString(),
        current_period_end: trialEnd.toISOString(),
        trial_end: trialEnd.toISOString(),
        calls_limit: planConfig.callsLimit,
        calls_used: 0,
        assistants_limit: planConfig.assistants,
        phone_numbers_limit: planConfig.phoneNumbers,
        // Placeholder IDs for trial — replaced by real Stripe IDs when user converts to paid
        stripe_price_id: `price_trial_${plan}`,
        stripe_subscription_id: `trial_${organizationId}`,
      }, {
        onConflict: "organization_id",
        ignoreDuplicates: true,
      });

    if (subError) {
      console.error("Failed to create trial subscription:", {
        organizationId,
        plan,
        error: subError,
      });
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
