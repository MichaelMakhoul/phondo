import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVapiClient } from "@/lib/vapi";
import { getCountryConfig } from "@/lib/country-config";

interface Membership {
  organization_id: string;
}

// POST /api/v1/phone-numbers/search - Search available phone numbers
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Look up org's country
    const { data: membership } = await supabase
      .from("org_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .single() as { data: Membership | null };

    if (!membership) {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }

    const { data: org, error: orgError } = await (supabase as any)
      .from("organizations")
      .select("country")
      .eq("id", membership.organization_id)
      .single();

    if (orgError || !org) {
      return NextResponse.json({ error: "Failed to load organization" }, { status: 500 });
    }

    const countryCode = org.country || "US";

    const config = getCountryConfig(countryCode);
    const body = await request.json();
    const { areaCode, limit = 10 } = body;

    if (config.phoneProvider === "telnyx") {
      const { searchAvailableNumbers } = await import("@/lib/telnyx/client");
      const numbers = await searchAvailableNumbers(config.twilioCountryCode, areaCode, limit);
      return NextResponse.json(
        numbers.map((n) => ({
          number: n.number,
          locality: n.locality,
          region: n.region,
          areaCode: areaCode || undefined,
        }))
      );
    }

    if (config.phoneProvider === "twilio") {
      const { searchAvailableNumbers } = await import("@/lib/twilio/client");
      const numbers = await searchAvailableNumbers(config.twilioCountryCode, areaCode, limit);
      return NextResponse.json(
        numbers.map((n) => ({
          number: n.number,
          locality: n.locality,
          region: n.region,
          areaCode: areaCode || undefined,
        }))
      );
    }

    // Vapi has no search endpoint — returns placeholder; actual number provisioned at purchase
    const vapi = getVapiClient();
    const availableNumbers = await vapi.searchPhoneNumbers({
      areaCode,
      country: countryCode,
      limit,
    });

    return NextResponse.json(availableNumbers);
  } catch (error: any) {
    console.error("Error searching phone numbers:", error);
    const message = error?.message || "Internal server error";
    // Surface provider config errors clearly
    if (message.includes("TWILIO_ACCOUNT_SID") || message.includes("TWILIO_AUTH_TOKEN")) {
      return NextResponse.json(
        { error: "Twilio is not configured. Please add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to your environment variables." },
        { status: 503 }
      );
    }
    if (message.includes("TELNYX_API_KEY")) {
      return NextResponse.json(
        { error: "Telnyx is not configured. Please add TELNYX_API_KEY to your environment variables." },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
