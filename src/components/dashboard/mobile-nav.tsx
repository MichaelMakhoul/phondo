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
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SidebarContent } from "@/components/dashboard/sidebar";
import { navigation, secondaryNavigation } from "@/components/dashboard/sidebar";

const MOBILE_NAV_ITEMS = [
  { name: "Home", href: "/dashboard", icon: LayoutDashboard },
  { name: "Assistants", href: "/assistants", icon: Bot },
  { name: "Calls", href: "/calls", icon: PhoneCall },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
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

interface MobileBottomNavProps {
  currentOrg?: { name: string; type: string } | null;
}

export function MobileBottomNav({ currentOrg }: MobileBottomNavProps) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const allNavItems = [...navigation, ...secondaryNavigation];
  const isMoreActive = allNavItems
    .filter((item) => !MOBILE_NAV_ITEMS.some((m) => m.href === item.href))
    .some((item) => isPathActive(item.href, pathname));

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
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

      {/* More drawer — reuses sidebar design */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="left"
          className="w-64 p-0"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) {
              setMoreOpen(false);
            }
          }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-full flex-col">
            <SidebarContent
              currentOrg={currentOrg ? { name: currentOrg.name, type: currentOrg.type } : undefined}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
