"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

export type NotificationType =
  | "missed_call"
  | "voicemail"
  | "appointment"
  | "spam"
  | "follow_up";

export interface Notification {
  id: string;
  type: NotificationType;
  description: string;
  createdAt: string;
}

const STORAGE_KEY_PREFIX = "phondo-notifications-last-seen-";

function getLastSeenKey(organizationId: string) {
  return `${STORAGE_KEY_PREFIX}${organizationId}`;
}

function classifyCall(call: {
  status: string;
  outcome: string | null;
  is_spam: boolean;
  follow_up_required: boolean;
  caller_name: string | null;
  caller_phone: string | null;
}): { type: NotificationType; description: string } | null {
  const name = call.caller_name || call.caller_phone || "Unknown";

  if (call.is_spam) {
    return {
      type: "spam",
      description: `Spam call blocked from ${call.caller_phone || "Unknown"}`,
    };
  }
  if (call.outcome === "voicemail") {
    return {
      type: "voicemail",
      description: `Voicemail from ${name}`,
    };
  }
  if (call.status === "no-answer" || call.status === "busy") {
    return {
      type: "missed_call",
      description: `Missed call from ${name}`,
    };
  }
  if (call.follow_up_required) {
    return {
      type: "follow_up",
      description: `Follow-up needed: ${name}`,
    };
  }
  return null;
}

export function useNotifications(organizationId: string) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    if (!organizationId) return;

    try {
      const supabase = createClient();
      const twentyFourHoursAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();

      const [callsResult, appointmentsResult] = await Promise.all([
        (supabase as any)
          .from("calls")
          .select(
            "id, status, outcome, is_spam, follow_up_required, caller_name, caller_phone, created_at"
          )
          .eq("organization_id", organizationId)
          .gte("created_at", twentyFourHoursAgo)
          .or(
            "status.in.(no-answer,busy),outcome.eq.voicemail,is_spam.eq.true,follow_up_required.eq.true"
          )
          .order("created_at", { ascending: false })
          .limit(20),
        (supabase as any)
          .from("appointments")
          .select("id, attendee_name, created_at")
          .eq("organization_id", organizationId)
          .gte("created_at", twentyFourHoursAgo)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      if (callsResult.error) {
        console.error("Failed to fetch call notifications:", callsResult.error);
      }
      if (appointmentsResult.error) {
        console.error("Failed to fetch appointment notifications:", appointmentsResult.error);
      }

      const items: Notification[] = [];

      if (callsResult.data) {
        for (const call of callsResult.data) {
          const classified = classifyCall(call);
          if (classified) {
            items.push({
              id: call.id,
              type: classified.type,
              description: classified.description,
              createdAt: call.created_at,
            });
          }
        }
      }

      if (appointmentsResult.data) {
        for (const apt of appointmentsResult.data) {
          items.push({
            id: apt.id,
            type: "appointment",
            description: `${apt.attendee_name} booked an appointment`,
            createdAt: apt.created_at,
          });
        }
      }

      items.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      setNotifications(items.slice(0, 20));
    } catch (err) {
      console.error("Notification fetch failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  // Initialize lastSeen from localStorage
  useEffect(() => {
    if (!organizationId) return;
    try {
      const key = getLastSeenKey(organizationId);
      const stored = localStorage.getItem(key);
      if (stored) {
        setLastSeen(stored);
      } else {
        const now = new Date().toISOString();
        localStorage.setItem(key, now);
        setLastSeen(now);
      }
    } catch (err) {
      // localStorage unavailable (private browsing, restricted environments)
      console.debug("[Notifications] localStorage unavailable:", err);
      setLastSeen(null);
    }
  }, [organizationId]);

  // Fetch on mount and poll every 60s
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 60_000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  const unreadCount = lastSeen
    ? notifications.filter((n) => new Date(n.createdAt) > new Date(lastSeen))
        .length
    : 0;

  const markAllRead = useCallback(() => {
    if (!organizationId) return;
    const now = new Date().toISOString();
    try {
      localStorage.setItem(getLastSeenKey(organizationId), now);
    } catch {
      // Ignore localStorage errors
    }
    setLastSeen(now);
  }, [organizationId]);

  return { notifications, unreadCount, markAllRead, isLoading };
}
