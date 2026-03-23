"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Building2,
  Users,
  CreditCard,
  PhoneCall,
  Mail,
  Megaphone,
  Server,
  Phone,
  ArrowLeft,
  ShieldAlert,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

const adminNavigation = [
  { name: "Overview", href: "/admin", icon: LayoutDashboard },
  { name: "Organizations", href: "/admin/organizations", icon: Building2 },
  { name: "Users", href: "/admin/users", icon: Users },
  { name: "Billing", href: "/admin/billing", icon: CreditCard },
  { name: "Calls", href: "/admin/calls", icon: PhoneCall },
  { name: "Emails", href: "/admin/emails", icon: Mail },
  { name: "Marketing", href: "/admin/marketing", icon: Megaphone },
  { name: "System", href: "/admin/system", icon: Server },
  { name: "Phone Numbers", href: "/admin/numbers", icon: Phone },
];

function AdminNavLink({
  item,
  pathname,
}: {
  item: (typeof adminNavigation)[number];
  pathname: string;
}) {
  const isActive =
    item.href === "/admin"
      ? pathname === "/admin"
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
        isActive
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-l-2 border-l-amber-500 shadow-sm shadow-amber-500/10"
          : "text-muted-foreground hover:bg-amber-500/5 hover:text-foreground"
      )}
    >
      <item.icon className="h-5 w-5" />
      {item.name}
    </Link>
  );
}

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <div className="hidden md:flex h-full w-64 flex-col border-r bg-card">
      {/* Header */}
      <div className="flex h-16 items-center border-b px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-white shadow-md shadow-amber-500/30">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold">Phondo</span>
          <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400 border border-amber-500/20">
            Admin
          </span>
        </div>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-1">
          {adminNavigation.map((item) => (
            <AdminNavLink key={item.name} item={item} pathname={pathname} />
          ))}
        </nav>

        <div className="my-4 border-t" />

        <nav className="space-y-1">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
          >
            <ArrowLeft className="h-5 w-5" />
            Back to Dashboard
          </Link>
        </nav>
      </ScrollArea>

      {/* Footer */}
      <div className="border-t p-4">
        <div className="rounded-lg bg-amber-500/5 border border-amber-500/10 p-3">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Platform Admin Panel
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Service-role access. Changes affect all users.
          </p>
        </div>
      </div>
    </div>
  );
}
