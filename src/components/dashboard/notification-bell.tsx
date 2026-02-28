"use client";

import { formatDistanceToNow } from "date-fns";
import {
  PhoneMissed,
  Voicemail,
  CalendarCheck,
  ShieldAlert,
  AlertTriangle,
} from "lucide-react";
import { Bell } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useNotifications,
  type NotificationType,
} from "@/hooks/use-notifications";

const iconMap: Record<
  NotificationType,
  { icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  missed_call: { icon: PhoneMissed, color: "text-orange-500" },
  voicemail: { icon: Voicemail, color: "text-blue-500" },
  appointment: { icon: CalendarCheck, color: "text-green-500" },
  spam: { icon: ShieldAlert, color: "text-red-500" },
  follow_up: { icon: AlertTriangle, color: "text-yellow-500" },
};

interface NotificationBellProps {
  organizationId: string;
}

export function NotificationBell({ organizationId }: NotificationBellProps) {
  const { notifications, unreadCount, markAllRead, isLoading } =
    useNotifications(organizationId);

  return (
    <DropdownMenu onOpenChange={(open) => open && markAllRead()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className={`h-5 w-5 ${unreadCount > 0 ? "animate-bell-ring" : ""}`} />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-destructive animate-pulse-dot" />
          )}
          <span className="sr-only">Notifications</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="px-4 py-3 font-semibold text-sm border-b">
          Notifications
        </div>
        <ScrollArea className="max-h-80">
          {isLoading ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : notifications.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No recent notifications
            </div>
          ) : (
            <div className="py-1">
              {notifications.map((notification) => {
                const { icon: Icon, color } = iconMap[notification.type];
                return (
                  <div
                    key={notification.id}
                    className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/50"
                  >
                    <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${color}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-snug truncate">
                        {notification.description}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(notification.createdAt), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
        <div className="border-t px-4 py-2">
          <Link
            href="/calls"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all calls
          </Link>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
