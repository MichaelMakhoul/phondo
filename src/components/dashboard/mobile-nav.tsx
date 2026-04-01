"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Bot,
  PhoneCall,
  BarChart3,
  MoreHorizontal,
  Phone,
  PhoneForwarded,
  CalendarDays,
  ClipboardList,
  BookOpen,
  Users,
  Webhook,
  CreditCard,
  Settings,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const MOBILE_NAV_ITEMS = [
  { name: "Home", href: "/dashboard", icon: LayoutDashboard },
  { name: "Assistants", href: "/assistants", icon: Bot },
  { name: "Calls", href: "/calls", icon: PhoneCall },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
];

const MORE_NAV_ITEMS = [
  { name: "Phone Numbers", href: "/phone-numbers", icon: Phone },
  { name: "Callbacks", href: "/callbacks", icon: PhoneForwarded },
  { name: "Calendar", href: "/calendar", icon: CalendarDays },
  { name: "Appointments", href: "/appointments", icon: ClipboardList },
  { name: "Knowledge Base", href: "/settings/knowledge", icon: BookOpen },
  { name: "Team", href: "/settings/team", icon: Users },
  { name: "Integrations", href: "/settings/integrations", icon: Webhook },
  { name: "Billing", href: "/billing", icon: CreditCard },
  { name: "Settings", href: "/settings", icon: Settings },
];

function isPathActive(href: string, pathname: string): boolean {
  if (href === "/settings") {
    return (
      pathname === "/settings" ||
      pathname === "/settings/profile" ||
      pathname === "/settings/notifications" ||
      pathname === "/settings/calendar"
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileBottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const isMoreActive = MORE_NAV_ITEMS.some((item) =>
    isPathActive(item.href, pathname)
  );

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card md:hidden">
        <div className="flex items-center justify-around">
          {MOBILE_NAV_ITEMS.map((item) => {
            const isActive = isPathActive(item.href, pathname);

            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground"
                )}
              >
                <item.icon className={cn("h-5 w-5", isActive && "text-primary")} />
                {item.name}
              </Link>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setMoreOpen(true)}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition-colors",
              isMoreActive
                ? "text-primary"
                : "text-muted-foreground"
            )}
          >
            <MoreHorizontal className={cn("h-5 w-5", isMoreActive && "text-primary")} />
            More
          </button>
        </div>
      </nav>

      {/* More sheet */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-xl pb-8">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-left">More</SheetTitle>
          </SheetHeader>
          <nav className="grid grid-cols-4 gap-3">
            {MORE_NAV_ITEMS.map((item) => {
              const isActive = isPathActive(item.href, pathname);

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg p-3 text-center transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted"
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  <span className="text-[10px] font-medium leading-tight">{item.name}</span>
                </Link>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
