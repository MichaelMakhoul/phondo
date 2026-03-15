import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Phone, Play } from "lucide-react";

interface MarketingHeaderProps {
  /** Show landing page anchor links (#features, #calculator, #industries) */
  showAnchorLinks?: boolean;
}

const NAV_LINK_CLASS = "text-sm text-slate-300 hover:text-white transition-colors";

const ANCHOR_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#calculator", label: "ROI Calculator" },
  { href: "#industries", label: "Industries" },
] as const;

export function MarketingHeader({ showAnchorLinks = false }: MarketingHeaderProps): React.ReactElement {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#0F172A]/80 backdrop-blur supports-[backdrop-filter]:bg-[#0F172A]/60">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500">
            <Phone className="h-4 w-4 text-white" />
          </div>
          <span className="text-xl font-bold text-white">Phondo</span>
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {showAnchorLinks ? (
            ANCHOR_LINKS.map((link) => (
              <a key={link.href} href={link.href} className={NAV_LINK_CLASS}>
                {link.label}
              </a>
            ))
          ) : (
            <Link href="/#features" className={NAV_LINK_CLASS}>
              Features
            </Link>
          )}
          <Link href="/pricing" className={NAV_LINK_CLASS}>
            Pricing
          </Link>
          <Link href="/demo" className={NAV_LINK_CLASS}>
            Demo
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/demo" className="md:hidden">
            <Button variant="ghost" size="sm" className="gap-1.5 text-slate-300 hover:text-white hover:bg-white/10">
              <Play className="h-3.5 w-3.5" />
              Demo
            </Button>
          </Link>
          <Link href="/login">
            <Button variant="ghost" size="sm" className="text-slate-300 hover:text-white hover:bg-white/10">
              Log in
            </Button>
          </Link>
          <Link href="/signup">
            <Button size="sm" className="bg-orange-500 text-white hover:bg-orange-600">
              Start Free Trial
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}
