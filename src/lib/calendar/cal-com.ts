/**
 * Cal.com API Client
 *
 * Handles integration with Cal.com for appointment booking:
 * - OAuth flow for connecting accounts
 * - Fetching event types and availability
 * - Creating and managing bookings
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { safeEncrypt, safeDecrypt } from "@/lib/security/encryption";

// Cal.com v1 API — uses ?apiKey= query param auth, works with personal API keys
const CAL_COM_API_V1 = "https://api.cal.com/v1";

export interface CalComEventType {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  length: number; // duration in minutes
  hidden: boolean;
}

export interface CalComAvailability {
  date: string;
  slots: {
    time: string;
    attendees?: number;
  }[];
}

export interface CalComBooking {
  id: number;
  uid: string;
  title: string;
  startTime: string;
  endTime: string;
  status: string;
  attendees: {
    name: string;
    email: string;
  }[];
}

export interface BookingRequest {
  eventTypeId: number;
  start: string; // ISO datetime
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Get calendar integration settings for an organization
 */
export async function getCalendarIntegration(organizationId: string, assistantId?: string) {
  const supabase = createAdminClient();

  let query = (supabase as any)
    .from("calendar_integrations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "cal_com")
    .eq("is_active", true);

  if (assistantId) {
    query = query.eq("assistant_id", assistantId);
  }

  const { data, error } = await query.single();

  if (error || !data) {
    return null;
  }

  return data;
}

/**
 * Save calendar integration
 */
export async function saveCalendarIntegration(
  organizationId: string,
  data: {
    assistantId?: string;
    apiKey: string;
    eventTypeId?: string;
    bookingUrl?: string;
    settings?: Record<string, any>;
  }
) {
  const supabase = createAdminClient();

  // Check if integration already exists
  const { data: existing } = await (supabase as any)
    .from("calendar_integrations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "cal_com")
    .single();

  // Encrypt the API key before storing
  const encryptedApiKey = safeEncrypt(data.apiKey);

  if (existing) {
    // Update existing
    const { error } = await (supabase as any)
      .from("calendar_integrations")
      .update({
        assistant_id: data.assistantId || null,
        access_token: encryptedApiKey,
        calendar_id: data.eventTypeId || null,
        booking_url: data.bookingUrl || null,
        settings: data.settings || {},
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) {
      console.error("[CalCom] saveCalendarIntegration update failed:", {
        organizationId,
        integrationId: existing.id,
        error: error.message || error.code,
      });
    }

    return !error;
  } else {
    // Insert new
    const { error } = await (supabase as any)
      .from("calendar_integrations")
      .insert({
        organization_id: organizationId,
        assistant_id: data.assistantId || null,
        provider: "cal_com",
        access_token: encryptedApiKey,
        calendar_id: data.eventTypeId || null,
        booking_url: data.bookingUrl || null,
        settings: data.settings || {},
        is_active: true,
      });

    if (error) {
      console.error("[CalCom] saveCalendarIntegration insert failed:", {
        organizationId,
        error: error.message || error.code,
      });
    }

    return !error;
  }
}

/**
 * Delete calendar integration
 */
export async function deleteCalendarIntegration(organizationId: string) {
  const supabase = createAdminClient();

  const { error } = await (supabase as any)
    .from("calendar_integrations")
    .delete()
    .eq("organization_id", organizationId)
    .eq("provider", "cal_com");

  if (error) {
    console.error("[CalCom] deleteCalendarIntegration failed:", {
      organizationId,
      error: error.message || error.code,
    });
  }

  return !error;
}

/**
 * Cal.com API client class
 *
 * Uses v1 API with ?apiKey= query param auth. Cal.com's v2 API requires
 * OAuth/Platform keys which aren't available for personal API keys.
 */
export class CalComClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async requestV1<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const url = `${CAL_COM_API_V1}${endpoint}${separator}apiKey=${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (err) {
      // Strip URL (contains API key) from network-level errors
      throw new Error(`Cal.com API network error: ${err instanceof Error ? err.message : "fetch failed"}`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cal.com API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get the current user (to verify API key works)
   */
  async getMe() {
    return this.requestV1<{ user: { id: number; username: string; email: string } }>("/me");
  }

  /**
   * Get event types (appointment types)
   */
  async getEventTypes(): Promise<CalComEventType[]> {
    const response = await this.requestV1<{ event_types: CalComEventType[] }>("/event-types");
    return response.event_types || [];
  }

  /**
   * Get available slots for a specific date and event type
   */
  async getAvailability(params: {
    eventTypeId: number;
    startTime: string; // ISO date
    endTime: string; // ISO date
  }): Promise<CalComAvailability[]> {
    const query = new URLSearchParams({
      eventTypeId: params.eventTypeId.toString(),
      startTime: params.startTime,
      endTime: params.endTime,
    });

    const response = await this.requestV1<{ slots: Record<string, { time: string }[]> }>(
      `/slots?${query.toString()}`
    );

    const slots = response.slots || {};
    return Object.entries(slots).map(([date, times]) => ({
      date,
      slots: times.map((t) => ({ time: t.time })),
    }));
  }

  /**
   * Create a booking
   */
  async createBooking(booking: BookingRequest): Promise<CalComBooking> {
    const response = await this.requestV1<CalComBooking>("/bookings", {
      method: "POST",
      body: JSON.stringify({
        eventTypeId: booking.eventTypeId,
        start: booking.start,
        responses: {
          name: booking.name,
          email: booking.email || "noreply@phondo.com",
          phone: booking.phone,
          notes: booking.notes,
        },
        metadata: booking.metadata,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: "en",
      }),
    });

    return response;
  }

  /**
   * Cancel a booking
   */
  async cancelBooking(bookingId: number, reason?: string): Promise<boolean> {
    await this.requestV1(`/bookings/${bookingId}/cancel`, {
      method: "DELETE",
      body: JSON.stringify({
        cancellationReason: reason || "Cancelled by user",
      }),
    });

    return true;
  }

  /**
   * Reschedule a booking
   */
  async rescheduleBooking(
    bookingUid: string,
    newStart: string
  ): Promise<CalComBooking> {
    const response = await this.requestV1<CalComBooking>(
      `/bookings/${bookingUid}/reschedule`,
      {
        method: "PATCH",
        body: JSON.stringify({
          start: newStart,
        }),
      }
    );

    return response;
  }
}

/**
 * Get a Cal.com client for an organization
 */
export async function getCalComClient(
  organizationId: string,
  assistantId?: string
): Promise<CalComClient | null> {
  const integration = await getCalendarIntegration(organizationId, assistantId);

  if (!integration || !integration.access_token) {
    return null;
  }

  // Decrypt the API key before use
  const apiKey = safeDecrypt(integration.access_token);
  if (!apiKey) {
    console.error("Failed to decrypt Cal.com API key for organization:", organizationId);
    return null;
  }

  return new CalComClient(apiKey);
}

/**
 * Vapi tool definitions for calendar booking
 */
export const calendarTools = {
  checkAvailability: {
    type: "function" as const,
    function: {
      name: "check_availability",
      description: "Check available appointment slots for a specific date. Use this when a caller wants to schedule an appointment.",
      parameters: {
        type: "object" as const,
        properties: {
          date: {
            type: "string",
            description: "Date to check availability for, in YYYY-MM-DD format",
          },
          event_type: {
            type: "string",
            description: "Type of appointment (optional, uses default if not specified)",
          },
        },
        required: ["date"],
      },
    },
  },

  bookAppointment: {
    type: "function" as const,
    function: {
      name: "book_appointment",
      description: "Book an appointment for the caller. Collect their name, phone, and preferred time first.",
      parameters: {
        type: "object" as const,
        properties: {
          datetime: {
            type: "string",
            description: "The appointment date and time in ISO format (e.g., 2024-01-15T10:00:00)",
          },
          name: {
            type: "string",
            description: "The caller's full name",
          },
          email: {
            type: "string",
            description: "The caller's email address (optional)",
          },
          phone: {
            type: "string",
            description: "The caller's phone number",
          },
          notes: {
            type: "string",
            description: "Any additional notes or reason for the appointment",
          },
        },
        required: ["datetime", "name", "phone"],
      },
    },
  },

  cancelAppointment: {
    type: "function" as const,
    function: {
      name: "cancel_appointment",
      description: "Cancel an existing appointment. Need the caller's phone number to find the booking.",
      parameters: {
        type: "object" as const,
        properties: {
          phone: {
            type: "string",
            description: "The caller's phone number to look up their appointment",
          },
          reason: {
            type: "string",
            description: "Reason for cancellation (optional)",
          },
        },
        required: ["phone"],
      },
    },
  },

  getCurrentDatetime: {
    type: "function" as const,
    function: {
      name: "get_current_datetime",
      description: "Get the current date and time. Call this BEFORE interpreting any relative date references like 'today', 'tomorrow', 'next Monday', etc.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
  },
};

/**
 * Produce a reliable YYYY-MM-DD local date key using Intl.DateTimeFormat parts.
 * Does not rely on locale-specific toLocaleDateString output format.
 */
function toLocalDateKey(date: Date, tz?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  };
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(date);
  const y = parts.find(p => p.type === "year")?.value ?? "0000";
  const m = parts.find(p => p.type === "month")?.value ?? "01";
  const d = parts.find(p => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * Format availability slots for voice response.
 * Regroups slots by LOCAL date (in the business timezone) rather than UTC date,
 * which prevents confusing output like "Saturday March 22" when the caller
 * asked about Monday March 23 (AEDT morning = previous day in UTC).
 */
export function formatAvailabilityForVoice(availability: CalComAvailability[], timezone?: string): string {
  if (availability.length === 0 || availability.every((a) => a.slots.length === 0)) {
    return "I'm sorry, there are no available appointments on that date. Would you like to check a different day?";
  }

  // Validate timezone early — fall back to UTC if invalid
  let validTz = timezone;
  if (timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch (err) {
      if (err instanceof RangeError) {
        console.error(`[cal-com] Invalid timezone "${timezone}", falling back to UTC`);
      } else {
        console.error(`[cal-com] Unexpected error validating timezone "${timezone}":`, err);
      }
      validTz = undefined;
    }
  }
  const tzOption = validTz ? { timeZone: validTz } : {};

  // Flatten all slots and regroup by local date in the business timezone
  const allSlots: Date[] = [];
  for (const day of availability) {
    for (const slot of day.slots) {
      const parsed = new Date(slot.time);
      if (isNaN(parsed.getTime())) {
        console.warn(`[cal-com] Skipping invalid slot time: "${slot.time}"`);
        continue;
      }
      allSlots.push(parsed);
    }
  }

  // Group by local date key (explicit YYYY-MM-DD, not locale-dependent)
  const slotsByLocalDate = new Map<string, Date[]>();
  for (const slot of allSlots) {
    const key = toLocalDateKey(slot, validTz);
    if (!slotsByLocalDate.has(key)) {
      slotsByLocalDate.set(key, []);
    }
    slotsByLocalDate.get(key)!.push(slot);
  }

  // Sort by date key for chronological output
  const sortedEntries = [...slotsByLocalDate.entries()].sort(([a], [b]) => a.localeCompare(b));

  const parts: string[] = [];
  for (const [, slots] of sortedEntries) {
    if (slots.length === 0) continue;

    slots.sort((a, b) => a.getTime() - b.getTime());

    const dateStr = slots[0].toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      ...tzOption,
    });

    const slotsToShow = slots.slice(0, 5);
    const timeStrings = slotsToShow.map((slot) =>
      slot.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        ...tzOption,
      })
    );

    const moreSlots = slots.length > 5 ? ` and ${slots.length - 5} more` : "";
    parts.push(`On ${dateStr}, I have openings at ${timeStrings.join(", ")}${moreSlots}`);
  }

  if (parts.length === 0) {
    return "I'm sorry, I had trouble reading the available time slots. Would you like to try again or check a different day?";
  }

  return parts.join(". ") + ". Which time works best for you?";
}

/**
 * Format booking confirmation for voice response
 */
export function formatBookingConfirmation(booking: CalComBooking, timezone?: string): string {
  const startDate = new Date(booking.startTime);
  const tzOption = timezone ? { timeZone: timezone } : {};

  const dateStr = startDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...tzOption,
  });

  const timeStr = startDate.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...tzOption,
  });

  return `I've booked your appointment for ${dateStr} at ${timeStr}. You should receive a confirmation email shortly. Is there anything else I can help you with?`;
}
