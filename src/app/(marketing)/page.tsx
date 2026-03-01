import { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ROICalculator } from "@/components/marketing/roi-calculator";
import { AnimateOnScroll } from "@/components/marketing/animate-on-scroll";
import { AnimatedStat } from "@/components/marketing/animated-stat";
import { FloatingDemoCta } from "@/components/marketing/floating-demo-cta";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import {
  Phone,
  Calendar,
  BarChart3,
  MessageSquare,
  Shield,
  Clock,
  Zap,
  ArrowRight,
  Check,
  PhoneForwarded,
  Globe,
  Lock,
  Server,
  Play,
  Headphones,
  Stethoscope,
  Scale,
  Wrench,
  Home,
  Building,
  Briefcase,
} from "lucide-react";
import { getDisplayPlans } from "@/lib/stripe/client";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Hola Recep | AI Receptionist for Australian Businesses",
  description:
    "Never miss a call again. AI-powered phone receptionist that answers calls, books appointments, and recovers missed revenue 24/7. Built for Australian SMBs. 14-day free trial.",
  keywords: [
    "AI receptionist",
    "AI receptionist Australia",
    "AI receptionist Sydney",
    "virtual receptionist",
    "AI phone answering",
    "missed call recovery",
    "dental receptionist AI",
    "legal receptionist AI",
    "appointment booking AI",
    "SMB phone answering service",
  ],
  openGraph: {
    title: "Hola Recep | AI Receptionist for Australian Businesses",
    description:
      "62% of SMB calls go unanswered. Each one costs $450 in lost revenue. Hola Recep answers every call, 24/7.",
    type: "website",
  },
};

const PLANS = getDisplayPlans();

const INDUSTRIES = [
  {
    name: "Dental & Medical",
    icon: Stethoscope,
    color: "bg-rose-500/10 text-rose-500",
    description: "Appointment booking, insurance queries, after-hours triage",
    stat: "35% fewer no-shows",
  },
  {
    name: "Legal",
    icon: Scale,
    color: "bg-blue-500/10 text-blue-500",
    description: "Client intake, consultation scheduling, case status updates",
    stat: "24/7 lead capture",
  },
  {
    name: "Home Services",
    icon: Wrench,
    color: "bg-amber-500/10 text-amber-500",
    description: "Job quotes, emergency dispatch, booking & scheduling",
    stat: "47% more bookings",
  },
  {
    name: "Real Estate",
    icon: Home,
    color: "bg-emerald-500/10 text-emerald-500",
    description: "Property enquiries, inspection scheduling, lead qualification",
    stat: "Never miss a lead",
  },
];

const STATS = [
  { value: "62%", label: "of SMB calls go unanswered" },
  { value: "$450", label: "average revenue lost per missed call" },
  { value: "85%", label: "of callers who reach voicemail never call back" },
  { value: "47%", label: "higher engagement with SMS text-back" },
];

const FEATURES = [
  {
    icon: Phone,
    title: "24/7 Call Answering",
    description: "Every call answered on the first ring. Nights, weekends, public holidays.",
  },
  {
    icon: Calendar,
    title: "Appointment Booking",
    description: "Books directly into Cal.com or your business hours. Sends SMS confirmation.",
  },
  {
    icon: MessageSquare,
    title: "SMS Text-Back",
    description: "Missed calls get an instant text with a booking link. 47% recovery rate.",
  },
  {
    icon: PhoneForwarded,
    title: "Call Transfers",
    description: "Transfers urgent calls to your mobile with context. No more phone tag.",
  },
  {
    icon: BarChart3,
    title: "Call Analytics",
    description: "Full transcripts, call summaries, and insights. Know what callers want.",
  },
  {
    icon: Shield,
    title: "Spam Filtering",
    description: "AI detects and filters spam calls. Only real enquiries reach your dashboard.",
  },
  {
    icon: Globe,
    title: "Australian Voices",
    description: "Natural-sounding Australian accents. Your callers won't know it's AI.",
  },
  {
    icon: Zap,
    title: "Industry-Trained",
    description: "Pre-trained for dental, legal, trades, and more. Understands your terminology.",
  },
  {
    icon: Clock,
    title: "5-Minute Setup",
    description: "Enter your details, get a number, go live. No IT team required.",
  },
];

const HOW_IT_WORKS = [
  {
    icon: Building,
    step: "1",
    title: "Tell us about your business",
    description:
      "Enter your business details and we'll build a custom AI receptionist trained on your industry.",
  },
  {
    icon: Phone,
    step: "2",
    title: "Get your phone number",
    description:
      "We provision a local Australian or US number. Forward your existing line, or use it directly.",
  },
  {
    icon: Briefcase,
    step: "3",
    title: "Go live",
    description:
      "Your AI receptionist starts answering calls immediately. Monitor everything from your dashboard.",
  },
];

const SOCIAL_PROOF = [
  { value: "24/7", desc: "Always available. No sick days, no holidays, no breaks." },
  { value: "<1s", desc: "Average answer time. Your callers never wait." },
  { value: "10+", desc: "Industries pre-configured. Up and running in minutes." },
];

const FADE_IN_UP_DELAYS = [
  "animate-fade-in-up",
  "animate-fade-in-up-delay-1",
  "animate-fade-in-up-delay-2",
  "animate-fade-in-up-delay-3",
  "animate-fade-in-up-delay-4",
];

function staggeredFadeIn(index: number, groupSize: number = 3): string {
  return FADE_IN_UP_DELAYS[index % groupSize] ?? FADE_IN_UP_DELAYS[0];
}

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader showAnchorLinks />

      <main className="flex-1">
        {/* Hero — dark gradient with radial glow */}
        <section className="relative overflow-hidden bg-hero-gradient">
          {/* Grid pattern overlay */}
          <div className="absolute inset-0 bg-grid-pattern" />
          {/* Radial glow */}
          <div className="absolute left-1/2 top-0 -translate-x-1/2 h-[600px] w-[800px] rounded-full bg-orange-500/10 blur-3xl" />

          <div className="relative container mx-auto px-4 py-16 text-center sm:py-24 lg:py-32">
            <Badge className="mb-6 animate-fade-in-up border-orange-500/30 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20">
              Built for Australian businesses
            </Badge>

            <h1 className="mx-auto max-w-4xl text-4xl font-bold tracking-tight text-white animate-fade-in-up-delay-1 sm:text-5xl lg:text-6xl">
              Stop losing{" "}
              <span className="text-gradient-hero">$450</span> every time
              <br className="hidden sm:block" />
              the phone rings and{" "}
              <span className="text-slate-300">nobody answers</span>
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400 animate-fade-in-up-delay-2">
              Hola Recep is an AI receptionist that answers every call, books
              appointments, and texts back missed callers — 24 hours a day, 7 days
              a week. Set up in under 5 minutes.
            </p>

            <div className="mt-10 flex flex-col items-center justify-center gap-4 animate-fade-in-up-delay-3 sm:flex-row">
              <Link href="/signup">
                <Button size="lg" className="gap-2 bg-orange-500 text-white hover:bg-orange-600 animate-glow-pulse">
                  Start 14-Day Free Trial
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <Link href="/demo">
                <Button variant="outline" size="lg" className="gap-2 border-slate-600 text-slate-200 hover:bg-white/10 hover:text-white">
                  <Play className="h-4 w-4" />
                  Try Live Demo
                </Button>
              </Link>
            </div>

            <p className="mt-4 text-sm text-slate-500 animate-fade-in-up-delay-4">
              No credit card required. Cancel anytime.
            </p>

            {/* Stats bar — embedded in hero */}
            <div className="mt-16 grid grid-cols-2 gap-6 border-t border-white/10 pt-10 sm:gap-8 md:grid-cols-4">
              {STATS.map((stat) => (
                <div key={stat.label} className="text-center">
                  <AnimatedStat
                    value={stat.value}
                    className="text-2xl font-bold text-white sm:text-3xl"
                  />
                  <p className="mt-1 text-xs text-slate-400 sm:text-sm">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Demo Banner */}
        <section className="border-b bg-orange-500/5">
          <div className="container mx-auto flex flex-col items-center justify-center gap-3 px-4 py-4 sm:flex-row sm:gap-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Headphones className="h-4 w-4 text-orange-500" />
              Hear it for yourself — talk to our AI receptionist right now
            </div>
            <Link href="/demo">
              <Button size="sm" className="gap-1.5 bg-orange-500 text-white hover:bg-orange-600">
                Try Live Demo
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        </section>

        {/* How It Works */}
        <section className="container mx-auto px-4 py-16 sm:py-24">
          <AnimateOnScroll className="text-center">
            <h2 className="text-3xl font-bold">Up and running in 3 steps</h2>
            <p className="mt-3 text-muted-foreground">
              No technical skills required. No hardware to install.
            </p>
          </AnimateOnScroll>
          <div className="mx-auto mt-14 grid max-w-4xl gap-8 md:grid-cols-3">
            {HOW_IT_WORKS.map((item, i) => (
              <AnimateOnScroll
                key={item.step}
                animation={staggeredFadeIn(i)}
              >
                <div className="relative text-center">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500/10">
                    <item.icon className="h-6 w-6 text-orange-500" />
                  </div>
                  <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-orange-500">
                    Step {item.step}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {item.description}
                  </p>
                  {/* Connector line (desktop only, not on last) */}
                  {i < 2 && (
                    <div className="absolute right-0 top-7 hidden h-px w-[calc(50%-2rem)] bg-border md:block" style={{ left: "calc(50% + 2rem)" }} />
                  )}
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="relative border-t py-16 sm:py-24">
          <div className="absolute inset-0 bg-dot-pattern opacity-50" />
          <div className="relative container mx-auto px-4">
            <AnimateOnScroll className="text-center">
              <h2 className="text-3xl font-bold">Everything your receptionist does, but better</h2>
              <p className="mt-3 text-muted-foreground">
                And it never calls in sick, takes holidays, or puts callers on hold.
              </p>
            </AnimateOnScroll>
            <div className="mx-auto mt-14 grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature, i) => (
                <AnimateOnScroll
                  key={feature.title}
                  animation={staggeredFadeIn(i)}
                >
                  <div className="rounded-lg border bg-card p-6 transition-all border-glow-hover">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                      <feature.icon className="h-5 w-5 text-orange-500" />
                    </div>
                    <h3 className="mt-4 font-semibold">{feature.title}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {feature.description}
                    </p>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
          </div>
        </section>

        {/* ROI Calculator */}
        <section id="calculator" className="py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <div className="mx-auto max-w-2xl">
              <AnimateOnScroll className="text-center">
                <h2 className="text-3xl font-bold">
                  Calculate your missed call cost
                </h2>
                <p className="mt-3 text-muted-foreground">
                  Slide to see how much revenue you&apos;re leaving on the table
                  — and how fast Hola Recep pays for itself.
                </p>
              </AnimateOnScroll>
              <AnimateOnScroll className="mt-10">
                <ROICalculator />
              </AnimateOnScroll>
            </div>
          </div>
        </section>

        {/* Industries */}
        <section id="industries" className="border-t bg-slate-50 dark:bg-slate-900 py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <AnimateOnScroll className="text-center">
              <h2 className="text-3xl font-bold">Built for your industry</h2>
              <p className="mt-3 text-muted-foreground">
                Pre-configured with industry-specific prompts, terminology, and workflows.
              </p>
            </AnimateOnScroll>
            <div className="mx-auto mt-14 grid max-w-4xl gap-6 sm:grid-cols-2">
              {INDUSTRIES.map((industry, i) => (
                <AnimateOnScroll
                  key={industry.name}
                  animation={i % 2 === 0 ? "animate-slide-in-left" : "animate-slide-in-right"}
                >
                  <div className="flex gap-4 rounded-lg border bg-card p-6 transition-transform hover:-translate-y-1">
                    <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl ${industry.color}`}>
                      <industry.icon className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{industry.name}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {industry.description}
                      </p>
                      <Badge variant="secondary" className="mt-2">
                        {industry.stat}
                      </Badge>
                    </div>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
          </div>
        </section>

        {/* Trust & Compliance */}
        <section className="border-t py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <AnimateOnScroll className="text-center">
              <h2 className="text-3xl font-bold">Built on trust and security</h2>
              <p className="mt-3 text-muted-foreground">
                Australian data sovereignty. Enterprise-grade security. Privacy by design.
              </p>
            </AnimateOnScroll>
            <div className="mx-auto mt-14 grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  icon: Server,
                  title: "Australian Data Hosting",
                  description: "Your data stays in Australia. Hosted on Australian infrastructure with local data sovereignty.",
                },
                {
                  icon: Shield,
                  title: "Enterprise Security",
                  description: "Bank-grade encryption for all calls, transcripts, and personal data.",
                },
                {
                  icon: Lock,
                  title: "Privacy Compliant",
                  description: "Compliant with Australian Privacy Act and state-aware recording consent laws.",
                },
                {
                  icon: Zap,
                  title: "99.9% Uptime",
                  description: "Enterprise-grade reliability so you never miss a call.",
                },
              ].map((item, i) => (
                <AnimateOnScroll
                  key={item.title}
                  animation={staggeredFadeIn(i, 4)}
                >
                  <div className="rounded-lg border bg-card p-6 text-center transition-all border-glow-hover">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500/10">
                      <item.icon className="h-6 w-6 text-orange-500" />
                    </div>
                    <h3 className="mt-4 font-semibold">{item.title}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
            <div className="mt-10 text-center">
              <Link href="/data-sovereignty" className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-500 hover:text-orange-600 transition-colors">
                Learn more about our security
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* Social Proof */}
        <section className="py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <AnimateOnScroll className="text-center">
              <h2 className="text-3xl font-bold">The numbers speak for themselves</h2>
            </AnimateOnScroll>
            <div className="mx-auto mt-14 grid max-w-4xl gap-8 md:grid-cols-3">
              {SOCIAL_PROOF.map((item, i) => (
                <AnimateOnScroll
                  key={item.value}
                  animation={staggeredFadeIn(i)}
                >
                  <div className="group rounded-lg border bg-card p-6 text-center transition-transform hover:-translate-y-1">
                    <p className="text-4xl font-bold text-orange-500 transition-transform group-hover:scale-110">
                      {item.value}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {item.desc}
                    </p>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing Preview */}
        <section className="border-t bg-slate-50 dark:bg-slate-900 py-16 sm:py-24">
          <div className="container mx-auto px-4">
            <AnimateOnScroll className="text-center">
              <h2 className="text-3xl font-bold">Simple, transparent pricing</h2>
              <p className="mt-3 text-muted-foreground">
                All prices in AUD. Start with a 14-day free trial. No credit card required.
              </p>
            </AnimateOnScroll>
            <div className="mx-auto mt-14 grid max-w-5xl gap-8 md:grid-cols-3">
              {PLANS.map((plan) => (
                <AnimateOnScroll key={plan.id} animation="animate-fade-in-up">
                  <div
                    className={`relative rounded-xl border bg-card p-8 shadow-sm transition-transform hover:-translate-y-1 ${
                      plan.highlighted
                        ? "border-orange-500 ring-2 ring-orange-500"
                        : "border-border"
                    }`}
                  >
                    {plan.highlighted && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <Badge className="bg-orange-500 text-white hover:bg-orange-600">
                          Most Popular
                        </Badge>
                      </div>
                    )}
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-lg font-semibold">{plan.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {plan.description}
                        </p>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-bold">
                          {formatCurrency(plan.price)}
                        </span>
                        <span className="text-muted-foreground">/month</span>
                      </div>
                      <ul className="space-y-2">
                        {plan.features.slice(0, 4).map((feature) => (
                          <li
                            key={feature}
                            className="flex items-center gap-2 text-sm"
                          >
                            <Check className="h-4 w-4 flex-shrink-0 text-orange-500" />
                            {feature}
                          </li>
                        ))}
                        {plan.features.length > 4 && (
                          <li className="text-xs text-muted-foreground">
                            ...and {plan.features.length - 4} more
                          </li>
                        )}
                      </ul>
                    </div>
                  </div>
                </AnimateOnScroll>
              ))}
            </div>
            <div className="mt-10 text-center">
              <Link href="/pricing">
                <Button variant="outline" size="lg" className="gap-2">
                  View full pricing details
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Final CTA — dark full-bleed */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[600px] rounded-full bg-orange-500/10 blur-3xl" />

          <div className="relative container mx-auto px-4 py-16 text-center sm:py-24">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">
              Stop missing calls. Start recovering revenue.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-slate-400">
              Join Australian businesses that never miss a call. Set up in
              under 5 minutes, 14-day free trial, cancel anytime.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href="/signup">
                <Button size="lg" className="gap-2 bg-orange-500 text-white hover:bg-orange-600 animate-glow-pulse">
                  Start Free Trial
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <a href="#calculator">
                <Button
                  size="lg"
                  variant="outline"
                  className="gap-2 border-slate-600 text-slate-200 hover:bg-white/10 hover:text-white"
                >
                  <Phone className="h-4 w-4" />
                  Calculate Your ROI
                </Button>
              </a>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />

      {/* Floating demo CTA */}
      <FloatingDemoCta />
    </div>
  );
}
