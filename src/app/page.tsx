import { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ROICalculator } from "@/components/marketing/roi-calculator";
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
    icon: "🦷",
    description: "Appointment booking, insurance queries, after-hours triage",
    stat: "35% fewer no-shows",
  },
  {
    name: "Legal",
    icon: "⚖️",
    description: "Client intake, consultation scheduling, case status updates",
    stat: "24/7 lead capture",
  },
  {
    name: "Home Services",
    icon: "🔧",
    description: "Job quotes, emergency dispatch, booking & scheduling",
    stat: "47% more bookings",
  },
  {
    name: "Real Estate",
    icon: "🏠",
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

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Phone className="h-5 w-5 text-primary" />
            <span className="text-xl font-bold">Hola Recep</span>
          </div>
          <nav className="hidden items-center gap-6 md:flex">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground">
              Features
            </a>
            <a href="#calculator" className="text-sm text-muted-foreground hover:text-foreground">
              ROI Calculator
            </a>
            <a href="#industries" className="text-sm text-muted-foreground hover:text-foreground">
              Industries
            </a>
            <Link href="/pricing" className="text-sm text-muted-foreground hover:text-foreground">
              Pricing
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost" size="sm">
                Log in
              </Button>
            </Link>
            <Link href="/signup">
              <Button size="sm">Start Free Trial</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="container mx-auto px-4 py-12 text-center sm:py-20 lg:py-28">
          <Badge variant="secondary" className="mb-6">
            Built for Australian businesses
          </Badge>
          <h1 className="mx-auto max-w-4xl text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
            Stop losing <span className="text-destructive">$450</span> every time
            <br className="hidden sm:block" />
            the phone rings and{" "}
            <span className="text-primary">nobody answers</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Hola Recep is an AI receptionist that answers every call, books
            appointments, and texts back missed callers — 24 hours a day, 7 days
            a week. Set up in under 5 minutes.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link href="/signup">
              <Button size="lg" className="gap-2">
                Start 14-Day Free Trial
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <a href="#calculator">
              <Button variant="outline" size="lg" className="gap-2">
                <Phone className="h-4 w-4" />
                Calculate Your ROI
              </Button>
            </a>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            No credit card required. Cancel anytime.
          </p>
        </section>

        {/* Stats Bar */}
        <section className="border-y bg-muted/50">
          <div className="container mx-auto grid grid-cols-2 gap-4 px-4 py-8 sm:gap-6 sm:py-10 md:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="text-2xl font-bold text-primary sm:text-3xl">{stat.value}</p>
                <p className="mt-1 text-xs text-muted-foreground sm:text-sm">{stat.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How It Works */}
        <section className="container mx-auto px-4 py-12 sm:py-20">
          <div className="text-center">
            <h2 className="text-3xl font-bold">Up and running in 3 steps</h2>
            <p className="mt-3 text-muted-foreground">
              No technical skills required. No hardware to install.
            </p>
          </div>
          <div className="mx-auto mt-12 grid max-w-4xl gap-8 md:grid-cols-3">
            {[
              {
                step: "1",
                title: "Tell us about your business",
                description:
                  "Enter your business details and we'll build a custom AI receptionist trained on your industry.",
              },
              {
                step: "2",
                title: "Get your phone number",
                description:
                  "We provision a local Australian or US number. Forward your existing line, or use it directly.",
              },
              {
                step: "3",
                title: "Go live",
                description:
                  "Your AI receptionist starts answering calls immediately. Monitor everything from your dashboard.",
              },
            ].map((item) => (
              <div key={item.step} className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground">
                  {item.step}
                </div>
                <h3 className="mt-4 text-lg font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="border-t bg-muted/50 py-12 sm:py-20">
          <div className="container mx-auto px-4">
            <div className="text-center">
              <h2 className="text-3xl font-bold">Everything your receptionist does, but better</h2>
              <p className="mt-3 text-muted-foreground">
                And it never calls in sick, takes holidays, or puts callers on hold.
              </p>
            </div>
            <div className="mx-auto mt-12 grid max-w-5xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
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
              ].map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-lg border bg-card p-6"
                >
                  <feature.icon className="h-8 w-8 text-primary" />
                  <h3 className="mt-4 font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ROI Calculator */}
        <section id="calculator" className="py-12 sm:py-20">
          <div className="container mx-auto px-4">
            <div className="mx-auto max-w-2xl">
              <div className="text-center">
                <h2 className="text-3xl font-bold">
                  Calculate your missed call cost
                </h2>
                <p className="mt-3 text-muted-foreground">
                  Slide to see how much revenue you&apos;re leaving on the table
                  — and how fast Hola Recep pays for itself.
                </p>
              </div>
              <div className="mt-10">
                <ROICalculator />
              </div>
            </div>
          </div>
        </section>

        {/* Industries */}
        <section id="industries" className="border-t bg-muted/50 py-12 sm:py-20">
          <div className="container mx-auto px-4">
            <div className="text-center">
              <h2 className="text-3xl font-bold">Built for your industry</h2>
              <p className="mt-3 text-muted-foreground">
                Pre-configured with industry-specific prompts, terminology, and workflows.
              </p>
            </div>
            <div className="mx-auto mt-12 grid max-w-4xl gap-6 sm:grid-cols-2">
              {INDUSTRIES.map((industry) => (
                <div
                  key={industry.name}
                  className="flex gap-4 rounded-lg border bg-card p-6"
                >
                  <span className="text-3xl">{industry.icon}</span>
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
              ))}
            </div>
          </div>
        </section>

        {/* Social Proof */}
        <section className="py-12 sm:py-20">
          <div className="container mx-auto px-4">
            <div className="text-center">
              <h2 className="text-3xl font-bold">The numbers speak for themselves</h2>
            </div>
            <div className="mx-auto mt-12 grid max-w-4xl gap-8 md:grid-cols-3">
              <div className="rounded-lg border bg-card p-6 text-center">
                <p className="text-4xl font-bold text-primary">24/7</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Always available. No sick days, no holidays, no breaks.
                </p>
              </div>
              <div className="rounded-lg border bg-card p-6 text-center">
                <p className="text-4xl font-bold text-primary">&lt;1s</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Average answer time. Your callers never wait.
                </p>
              </div>
              <div className="rounded-lg border bg-card p-6 text-center">
                <p className="text-4xl font-bold text-primary">10+</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Industries pre-configured. Up and running in minutes.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing Preview */}
        <section className="border-t bg-muted/50 py-12 sm:py-20">
          <div className="container mx-auto px-4">
            <div className="text-center">
              <h2 className="text-3xl font-bold">Simple, transparent pricing</h2>
              <p className="mt-3 text-muted-foreground">
                All prices in AUD. Start with a 14-day free trial. No credit card required.
              </p>
            </div>
            <div className="mx-auto mt-12 grid max-w-5xl gap-8 md:grid-cols-3">
              {PLANS.map((plan) => (
                <div
                  key={plan.id}
                  className={`relative rounded-xl border bg-card p-8 shadow-sm ${
                    plan.highlighted
                      ? "border-primary ring-2 ring-primary"
                      : "border-border"
                  }`}
                >
                  {plan.highlighted && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <Badge className="bg-primary text-primary-foreground">
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
                          <Check className="h-4 w-4 text-primary flex-shrink-0" />
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
              ))}
            </div>
            <div className="mt-8 text-center">
              <Link href="/pricing">
                <Button variant="outline" size="lg" className="gap-2">
                  View full pricing details
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-12 sm:py-20">
          <div className="container mx-auto px-4">
            <div className="mx-auto max-w-2xl rounded-2xl bg-primary p-8 text-center text-primary-foreground sm:p-12">
              <h2 className="text-3xl font-bold">
                Stop missing calls. Start recovering revenue.
              </h2>
              <p className="mt-4 text-primary-foreground/80">
                Join Australian businesses that never miss a call. Set up in
                under 5 minutes, 14-day free trial, cancel anytime.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link href="/signup">
                  <Button
                    size="lg"
                    variant="secondary"
                    className="gap-2"
                  >
                    Start Free Trial
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
                <a href="#calculator">
                  <Button
                    size="lg"
                    variant="outline"
                    className="gap-2 border-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/10"
                  >
                    <Phone className="h-4 w-4" />
                    Calculate Your ROI
                  </Button>
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t py-12">
        <div className="container mx-auto px-4">
          <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-primary" />
                <span className="font-semibold">Hola Recep</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                AI phone receptionist for Australian businesses.
              </p>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Product</h4>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>
                  <Link href="/pricing" className="hover:text-foreground">
                    Pricing
                  </Link>
                </li>
                <li>
                  <a href="#calculator" className="hover:text-foreground">
                    ROI Calculator
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Legal</h4>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>
                  <Link href="/privacy" className="hover:text-foreground">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="hover:text-foreground">
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold">Contact</h4>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>support@holarecep.com</li>
                <li>Sydney, Australia</li>
              </ul>
            </div>
          </div>
          <div className="mt-8 border-t pt-8 text-center text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} Hola Recep. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
