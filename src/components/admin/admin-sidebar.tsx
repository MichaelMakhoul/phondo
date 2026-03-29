"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
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
  Menu,
  Search,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

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
  { name: "Lead Discovery", href: "/admin/lead-discovery", icon: Search },
];

function AdminNavLink({
  item,
  pathname,
  onClick,
}: {
  item: (typeof adminNavigation)[number];
  pathname: string;
  onClick?: () => void;
}) {
  const isActive =
    item.href === "/admin"
      ? pathname === "/admin"
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <Link
      href={item.href}
      onClick={onClick}
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

function SidebarNav({ onLinkClick }: { onLinkClick?: () => void }) {
  const pathname = usePathname();

  return (
    <>
      <nav className="space-y-1">
        {adminNavigation.map((item) => (
          <AdminNavLink
            key={item.name}
            item={item}
            pathname={pathname}
            onClick={onLinkClick}
          />
        ))}
      </nav>

      <div className="my-4 border-t" />

      <nav className="space-y-1">
        <Link
          href="/"
          onClick={onLinkClick}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
        >
          <ArrowLeft className="h-5 w-5" />
          Back to Dashboard
        </Link>
      </nav>
    </>
  );
}

export function AdminSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b bg-card px-4 md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500 text-white shadow-md shadow-amber-500/30">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <span className="text-base font-semibold">Admin</span>
        </div>
      </div>

      {/* Mobile sheet drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="flex h-16 items-center border-b px-6">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-white shadow-md shadow-amber-500/30">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <SheetTitle className="text-lg font-semibold">Phondo</SheetTitle>
              <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-400 border border-amber-500/20">
                Admin
              </span>
            </div>
          </SheetHeader>

          <ScrollArea className="flex-1 px-3 py-4">
            <SidebarNav onLinkClick={() => setMobileOpen(false)} />
          </ScrollArea>

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
        </SheetContent>
      </Sheet>

      {/* Desktop sidebar (unchanged) */}
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
          <SidebarNav />
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
    </>
  );
}
