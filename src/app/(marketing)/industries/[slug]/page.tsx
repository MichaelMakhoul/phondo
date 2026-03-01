import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  BarChart3,
  Calendar,
  Clock,
  ClipboardList,
  FileText,
  Home,
  Lock,
  MapPin,
  MessageSquare,
  Phone,
  PhoneForwarded,
  Scale,
  Shield,
  Stethoscope,
  Users,
  Wrench,
  Zap,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { AnimateOnScroll } from "@/components/marketing/animate-on-scroll";
import { INDUSTRY_PAGES, getIndustryBySlug } from "@/lib/industry-pages";

const ICON_MAP: Record<string, LucideIcon> = {
  ArrowRight,
  BarChart3,
  Calendar,
  Clock,
  ClipboardList,
  FileText,
  Home,
  Lock,
  MapPin,
  MessageSquare,
  Phone,
  PhoneForwarded,
  Scale,
  Shield,
  Stethoscope,
  Users,
  Wrench,
  Zap,
};

const COLOR_MAP: Record<string, { badge: string; icon: string; glow: string }> = {
  rose: {
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
    icon: "bg-rose-500/10 text-rose-500",
    glow: "bg-rose-500/10",
  },
  blue: {
    badge: "border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20",
    icon: "bg-blue-500/10 text-blue-500",
    glow: "bg-blue-500/10",
  },
  amber: {
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
    icon: "bg-amber-500/10 text-amber-500",
    glow: "bg-amber-500/10",
  },
  emerald: {
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
    icon: "bg-emerald-500/10 text-emerald-500",
    glow: "bg-emerald-500/10",
  },
};

export function generateStaticParams() {
  return INDUSTRY_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const industry = getIndustryBySlug(slug);
  if (!industry) return {};

  return {
    title: `AI Receptionist for ${industry.name} | Hola Recep`,
    description: industry.heroSubtitle,
    keywords: [
      `AI receptionist ${industry.name.toLowerCase()}`,
      `${industry.name.toLowerCase()} phone answering`,
      `${industry.name.toLowerCase()} virtual receptionist`,
      `AI receptionist Australia`,
      "missed call recovery",
      "appointment booking AI",
    ],
    openGraph: {
      title: `AI Receptionist for ${industry.name} | Hola Recep`,
      description: industry.heroSubtitle,
      type: "website",
    },
  };
}

export default async function IndustryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const industry = getIndustryBySlug(slug);
  if (!industry) notFound();

  const colors = COLOR_MAP[industry.color] ?? COLOR_MAP.rose;
  const HeroIcon = ICON_MAP[industry.icon] ?? Phone;

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 text-center sm:py-24">
            <div
              className={`mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl ${colors.icon} ring-1 ring-white/10`}
            >
              <HeroIcon className="h-8 w-8" />
            </div>
            <Badge
              className={`mb-6 ${colors.badge}`}
            >
              Built for {industry.name}
            </Badge>
            <h1 className="mx-auto max-w-4xl text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
              {industry.heroTitle}
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
              {industry.heroSubtitle}
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href="/signup">
                <Button
                  size="lg"
                  className="gap-2 bg-orange-500 text-white hover:bg-orange-600"
                >
                  Start 14-Day Free Trial
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link href="/demo">
                <Button
                  size="lg"
                  variant="outline"
                  className="border-slate-600 text-slate-200 hover:bg-white/10 hover:text-white"
                >
                  Try Live Demo
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="container mx-auto px-4 py-16 sm:py-24">
          <AnimateOnScroll className="text-center">
            <h2 className="text-3xl font-bold">
              Everything your {industry.name.toLowerCase()} practice needs
            </h2>
            <p className="mt-3 text-muted-foreground">
              Pre-configured with industry-specific prompts, terminology, and
              workflows.
            </p>
          </AnimateOnScroll>
          <div className="mx-auto mt-14 grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {industry.features.map((feature) => {
              const FeatureIcon = ICON_MAP[feature.icon] ?? Phone;
              return (
                <AnimateOnScroll key={feature.title}>
                  <div className="rounded-xl border bg-card p-6 transition-colors hover:border-orange-500/50">
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                      <FeatureIcon className="h-5 w-5 text-orange-500" />
                    </div>
                    <h3 className="font-semibold">{feature.title}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {feature.description}
                    </p>
                  </div>
                </AnimateOnScroll>
              );
            })}
          </div>
        </section>

        {/* Stats */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 sm:py-24">
            <AnimateOnScroll className="text-center">
              <h2 className="text-3xl font-bold text-white">
                The numbers speak for themselves
              </h2>
            </AnimateOnScroll>
            <div className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-8 md:grid-cols-4">
              {industry.stats.map((stat) => (
                <AnimateOnScroll key={stat.label}>
                  <div className="text-center">
                    <p className="text-3xl font-bold text-orange-400 sm:text-4xl">
                      {stat.value}
                    </p>
                    <p className="mt-2 text-sm text-slate-400">{stat.label}</p>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="container mx-auto px-4 py-16 sm:py-24">
          <AnimateOnScroll className="text-center">
            <h2 className="text-3xl font-bold">Frequently asked questions</h2>
            <p className="mt-3 text-muted-foreground">
              Common questions from {industry.name.toLowerCase()} professionals.
            </p>
          </AnimateOnScroll>
          <div className="mx-auto mt-14 max-w-3xl space-y-4">
            {industry.faqs.map((faq) => (
              <AnimateOnScroll key={faq.question}>
                <details className="group rounded-xl border bg-card">
                  <summary className="flex cursor-pointer items-center justify-between p-6 font-medium">
                    {faq.question}
                    <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="px-6 pb-6 text-sm text-muted-foreground">
                    {faq.answer}
                  </div>
                </details>
              </AnimateOnScroll>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="container mx-auto px-4 pb-16 sm:pb-24">
          <AnimateOnScroll>
            <div className="rounded-2xl border bg-card p-8 text-center sm:p-12">
              <h2 className="text-2xl font-bold sm:text-3xl">
                {industry.ctaTitle}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
                {industry.ctaDescription}
              </p>
              <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                <Link href="/signup">
                  <Button
                    size="lg"
                    className="gap-2 bg-orange-500 text-white hover:bg-orange-600"
                  >
                    Start Free Trial
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <Link href="/demo">
                  <Button size="lg" variant="outline">
                    Try Live Demo
                  </Button>
                </Link>
              </div>
            </div>
          </AnimateOnScroll>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
