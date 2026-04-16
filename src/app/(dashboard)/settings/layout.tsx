"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const settingsTabs = [
  { name: "General", href: "/settings" },
  { name: "Notifications", href: "/settings/notifications" },
  { name: "Scheduling", href: "/settings/scheduling" },
  { name: "Profile", href: "/settings/profile" },
];

// Pages that have their own header — don't show the settings tabs for these
const standalonePages = ["/settings/team", "/settings/knowledge", "/settings/integrations"];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const isStandalonePage = standalonePages.some((p) => pathname.startsWith(p));

  if (isStandalonePage) {
    return <>{children}</>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Manage your business and account settings
        </p>
      </div>

      <nav className="flex gap-1 border-b overflow-x-auto scrollbar-hide">
        {settingsTabs.map((tab) => {
          const isActive =
            tab.href === "/settings"
              ? pathname === "/settings"
              : pathname.startsWith(tab.href);

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.name}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
