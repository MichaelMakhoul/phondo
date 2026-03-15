import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CalComClient } from "@/lib/calendar/cal-com";
import { withRateLimit } from "@/lib/security/rate-limiter";

/**
 * POST /api/v1/calendar/test-connection
 *
 * Test Cal.com API key and fetch account info + event types
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limit - external API calls are expensive
    const { allowed, headers } = withRateLimit(request, "/api/v1/calendar/test-connection", "expensive");
    if (!allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers }
      );
    }

    const supabase = await createClient();

    // Check authentication
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { apiKey } = body;

    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 }
      );
    }

    // Create client and test connection
    const calClient = new CalComClient(apiKey);

    // Get account info
    const meResponse = await calClient.getMe();
    const account = meResponse.user;

    // Get event types
    const eventTypes = await calClient.getEventTypes();

    // Filter to only visible event types
    const visibleEventTypes = eventTypes.filter((et) => !et.hidden);

    return NextResponse.json({
      success: true,
      account: {
        id: account.id,
        username: account.username,
        email: account.email,
      },
      eventTypes: visibleEventTypes.map((et) => ({
        id: et.id,
        slug: et.slug,
        title: et.title,
        length: et.length,
      })),
    });
  } catch (error: any) {
    console.error("Cal.com test connection error:", error);

    // Parse common error types
    let errorMessage = "Failed to connect to Cal.com";
    if (error.message?.includes("401") || error.message?.includes("Unauthorized")) {
      errorMessage = "Invalid API key. Please check your Cal.com API key.";
    } else if (error.message?.includes("403")) {
      errorMessage = "Access denied. Make sure your API key has the correct permissions.";
    } else if (error.message?.includes("network") || error.message?.includes("fetch")) {
      errorMessage = "Network error. Please check your internet connection.";
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: 400 }
    );
  }
}
