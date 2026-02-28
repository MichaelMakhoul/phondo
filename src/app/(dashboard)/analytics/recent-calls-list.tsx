"use client";

import Link from "next/link";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  PhoneCall,
  ShieldAlert,
  ChevronRight,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

interface Call {
  id: string;
  status: string;
  is_spam: boolean;
  duration_seconds: number | null;
  created_at: string;
  outcome: string | null;
  action_taken: string | null;
}

interface RecentCallsListProps {
  calls: Call[];
}

export function RecentCallsList({ calls }: RecentCallsListProps) {
  if (calls.length === 0) {
    return (
      <EmptyState
        icon={PhoneCall}
        title="No calls yet"
        description="Set up an assistant and phone number to start receiving calls"
        compact
      />
    );
  }

  return (
    <div className="space-y-2">
      {calls.map((call) => (
        <Link
          key={call.id}
          href={`/calls/${call.id}`}
          className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            {call.is_spam ? (
              <ShieldAlert className="h-4 w-4 text-orange-500" />
            ) : call.status === "completed" ? (
              <PhoneIncoming className="h-4 w-4 text-green-500" />
            ) : call.status === "no-answer" || call.status === "busy" ? (
              <PhoneMissed className="h-4 w-4 text-red-500" />
            ) : (
              <PhoneOutgoing className="h-4 w-4 text-blue-500" />
            )}

            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {format(new Date(call.created_at), "MMM d, h:mm a")}
                </span>
                <Badge
                  variant={
                    call.is_spam
                      ? "destructive"
                      : call.status === "completed"
                      ? "success"
                      : call.status === "no-answer"
                      ? "destructive"
                      : "secondary"
                  }
                  className="text-xs"
                >
                  {call.is_spam ? "Spam" : call.status}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {call.duration_seconds
                  ? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, "0")}`
                  : "0:00"}
                {call.action_taken && ` • ${call.action_taken.replace("_", " ")}`}
              </p>
            </div>
          </div>

          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
      ))}

      <div className="pt-4 text-center">
        <Link href="/calls">
          <Button variant="outline" size="sm">
            View All Calls
          </Button>
        </Link>
      </div>
    </div>
  );
}
