"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Bot,
  Phone,
  PhoneCall,
  PhoneForwarded,
  CalendarDays,
  Settings,
  CreditCard,
  BookOpen,
  Users,
  Webhook,
  HelpCircle,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Organization {
  id: string;
  name: string;
  slug: string;
  type: string;
  logo_url: string | null;
  role: string;
}

interface DashboardSidebarProps {
  organizations: Organization[];
  currentOrgId?: string;
}

export const navigation = [
  {
    name: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    name: "Assistants",
    href: "/assistants",
    icon: Bot,
  },
  {
    name: "Phone Numbers",
    href: "/phone-numbers",
    icon: Phone,
  },
  {
    name: "Calls",
    href: "/calls",
    icon: PhoneCall,
  },
  {
    name: "Callbacks",
    href: "/callbacks",
    icon: PhoneForwarded,
  },
  {
    name: "Calendar",
    href: "/calendar",
    icon: CalendarDays,
  },
];

export const secondaryNavigation = [
  {
    name: "Knowledge Base",
    href: "/settings/knowledge",
    icon: BookOpen,
  },
  {
    name: "Team",
    href: "/settings/team",
    icon: Users,
  },
  {
    name: "Integrations",
    href: "/settings/integrations",
    icon: Webhook,
  },
  {
    name: "Billing",
    href: "/billing",
    icon: CreditCard,
  },
  {
    name: "Settings",
    href: "/settings",
    icon: Settings,
  },
];

function NavLink({ item, pathname }: { item: typeof navigation[number]; pathname: string }) {
  const isActive =
    item.href === "/settings"
      ? pathname === "/settings" ||
        pathname === "/settings/profile" ||
        pathname === "/settings/notifications" ||
        pathname === "/settings/calendar"
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
        isActive
          ? "bg-primary/10 text-primary border-l-2 border-l-primary shadow-sm shadow-primary/10"
          : "text-muted-foreground hover:bg-primary/5 hover:text-foreground"
      )}
    >
      <item.icon className="h-5 w-5" />
      {item.name}
    </Link>
  );
}

export function SidebarContent({ currentOrg }: { currentOrg?: { name: string; type: string } }) {
  const pathname = usePathname();

  return (
    <>
      {/* Logo */}
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md shadow-primary/30">
            <Phone className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">Hola Recep</span>
        </Link>
      </div>

      {/* Organization Selector */}
      <div className="border-b p-4">
        <div className="flex items-center gap-3 rounded-lg border border-primary/10 bg-muted p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold">
            {currentOrg?.name.charAt(0).toUpperCase() || "O"}
          </div>
          <div className="flex-1 truncate">
            <p className="truncate text-sm font-medium">
              {currentOrg?.name || "Organization"}
            </p>
            <p className="text-xs text-muted-foreground capitalize">
              {currentOrg?.type || "business"}
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-1">
          {navigation.map((item) => (
            <NavLink key={item.name} item={item} pathname={pathname} />
          ))}
        </nav>

        <div className="my-4 border-t" />

        <nav className="space-y-1">
          {secondaryNavigation.map((item) => (
            <NavLink key={item.name} item={item} pathname={pathname} />
          ))}
        </nav>
      </ScrollArea>

      {/* Footer */}
      <div className="border-t p-4">
        <Link href="/support" className="group block rounded-lg bg-muted p-3 transition-all hover:bg-primary/10 hover:shadow-sm hover:shadow-primary/10">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            <p className="text-xs font-medium">Need help?</p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Get support or browse our guides
          </p>
        </Link>
      </div>
    </>
  );
}

export function DashboardSidebar({
  organizations,
  currentOrgId,
}: DashboardSidebarProps) {
  const currentOrg = organizations.find((o) => o.id === currentOrgId);

  return (
    <div className="hidden md:flex h-full w-64 flex-col border-r bg-card">
      <SidebarContent currentOrg={currentOrg ? { name: currentOrg.name, type: currentOrg.type } : undefined} />
    </div>
  );
}
