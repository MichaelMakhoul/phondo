import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createBillingPortalSession } from "@/lib/stripe";

interface Membership {
  organization_id: string;
  role: string;
  organizations: { stripe_customer_id: string | null };
}

// POST /api/billing/portal - Create a billing portal session
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from("org_members")
      .select(`
        organization_id,
        role,
        organizations (stripe_customer_id)
      `)
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    // The Stripe billing portal exposes invoices, payment methods, and plan
    // changes — owner/admin only, not every org member (SCRUM-422, finding #6).
    if (membership.role !== "owner" && membership.role !== "admin") {
      return NextResponse.json(
        { error: "Only organization owners and admins can manage billing" },
        { status: 403 }
      );
    }

    const organization = membership.organizations;

    if (!organization.stripe_customer_id) {
      return NextResponse.json(
        { error: "No billing account found. Please subscribe to a plan first." },
        { status: 400 }
      );
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const session = await createBillingPortalSession(
      organization.stripe_customer_id,
      `${baseUrl}/billing`
    );

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Portal error:", error);
    return NextResponse.json(
      { error: "Failed to create billing portal session" },
      { status: 500 }
    );
  }
}
