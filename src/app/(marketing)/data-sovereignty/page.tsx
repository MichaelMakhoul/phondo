import { Metadata } from "next";
import Link from "next/link";
import {
  Shield,
  Server,
  Lock,
  Cpu,
  CheckCircle2,
  ArrowRight,
  Globe,
  FileCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { AnimateOnScroll } from "@/components/marketing/animate-on-scroll";

export const metadata: Metadata = {
  title: "Data Security & Australian Hosting | Phondo",
  description:
    "Your business data is stored in Australia. Phondo hosts call transcripts and business data in our Sydney region with encryption and row-level isolation, and is transparent about how conversations are processed.",
};

const INFRASTRUCTURE = [
  {
    icon: Server,
    title: "Australian Data Residency",
    description:
      "Call transcripts, appointment details, and business data are stored at rest in Sydney, Australia, on SOC 2 Type II certified managed infrastructure. Your records stay in Australia.",
  },
  {
    icon: Globe,
    title: "Sydney Region Hosting",
    description:
      "The Phondo app and API run in our Australian region for fast, reliable, low-latency access for Australian users.",
  },
  {
    icon: Lock,
    title: "End-to-End Encryption",
    description:
      "TLS 1.3 encryption in transit. AES-256 encryption at rest. Your transcripts and business data are protected at every stage.",
  },
  {
    icon: Cpu,
    title: "Transparent AI Processing",
    description:
      "Natural conversations are powered by leading speech and language AI. That real-time processing is performed by vetted providers under commercial terms that prohibit training on your data. We're transparent about the providers involved and where your data is handled, and the full list is available on request.",
  },
];

const COMPLIANCE_POINTS = [
  "Call transcripts and business data stored at rest in Sydney, Australia",
  "Built to support your obligations under the Australian Privacy Act 1988",
  "Row-Level Security isolates every organisation's data",
  "Real-time voice AI is processed by vetted providers under commercial terms that prohibit training on your data",
  "AI processing may occur outside Australia; we disclose the providers involved and where your data is handled",
  "State-aware call recording consent, so your callers are always informed",
  "Encryption in transit (TLS 1.3) and at rest (AES-256)",
  "Hosted on SOC 2 Type II certified managed infrastructure",
];

const VERTICALS = [
  {
    title: "Medical & Dental",
    description:
      "Patient records are stored in Australia, with call recording consent handled per state rules. We're transparent about the AI that powers conversations, which is important context for your AHPRA and privacy obligations.",
  },
  {
    title: "Legal Practices",
    description:
      "Client matter details are stored in Australia and isolated per firm with row-level security. We disclose exactly how conversations are processed so you can meet your confidentiality obligations.",
  },
  {
    title: "Financial Services",
    description:
      "Conversation data is stored in Australia. We provide the transparency on data handling and sub-processors that APRA- and ASIC-regulated firms expect.",
  },
  {
    title: "Government & Education",
    description:
      "Australian data storage supports procurement requirements around data residency. Talk to us about your specific sovereignty needs.",
  },
];

export default function DataSovereigntyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 text-center sm:py-24">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-500/20 ring-1 ring-orange-500/40">
              <Shield className="h-8 w-8 text-orange-400" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
              Your data is stored in Australia
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400 sm:text-xl">
              Call transcripts and business data are stored at rest in our
              Sydney region. And we&apos;re transparent about the thing most AI
              vendors gloss over: exactly how and where your conversations are
              processed.
            </p>
            <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <Link href="/signup">
                <Button
                  size="lg"
                  className="bg-orange-500 text-white hover:bg-orange-600"
                >
                  Start Free Trial
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/demo">
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/20 text-slate-300 hover:bg-white/10 hover:text-white"
                >
                  Try Live Demo
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Infrastructure Grid */}
        <section className="container mx-auto px-4 py-16 sm:py-24">
          <AnimateOnScroll>
            <div className="text-center">
              <h2 className="text-3xl font-bold sm:text-4xl">
                Built for Australian businesses
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
                Our infrastructure stores your data in Australia and gives you
                clear visibility into how it&apos;s handled, with no vague promises.
              </p>
            </div>
          </AnimateOnScroll>

          <div className="mt-12 grid gap-8 sm:grid-cols-2">
            {INFRASTRUCTURE.map((item) => (
              <AnimateOnScroll key={item.title}>
                <div className="rounded-xl border bg-card p-6 transition-colors hover:border-orange-500/50">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-orange-500/10">
                    <item.icon className="h-6 w-6 text-orange-500" />
                  </div>
                  <h3 className="text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {item.description}
                  </p>
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </section>

        {/* Compliance Checklist */}
        <section className="relative overflow-hidden bg-hero-gradient">
          <div className="absolute inset-0 bg-grid-pattern" />
          <div className="relative container mx-auto px-4 py-16 sm:py-24">
            <AnimateOnScroll>
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500/20">
                  <FileCheck className="h-6 w-6 text-orange-400" />
                </div>
                <h2 className="text-3xl font-bold text-white sm:text-4xl">
                  Security & data handling
                </h2>
                <p className="mx-auto mt-4 max-w-2xl text-slate-400">
                  We take security seriously so you can focus on your patients,
                  clients, and customers.
                </p>
              </div>
            </AnimateOnScroll>

            <AnimateOnScroll>
              <div className="mx-auto mt-12 max-w-2xl">
                <ul className="space-y-4">
                  {COMPLIANCE_POINTS.map((point) => (
                    <li key={point} className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-orange-400" />
                      <span className="text-slate-300">{point}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-8 text-center text-sm text-slate-400">
                  Read the full detail in our{" "}
                  <Link
                    href="/privacy"
                    className="text-orange-400 hover:underline"
                  >
                    Privacy Policy
                  </Link>
                  , including where your data is stored and processed.
                </p>
              </div>
            </AnimateOnScroll>
          </div>
        </section>

        {/* Industry Verticals */}
        <section className="container mx-auto px-4 py-16 sm:py-24">
          <AnimateOnScroll>
            <div className="text-center">
              <h2 className="text-3xl font-bold sm:text-4xl">
                Trusted by regulated industries
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
                Australian data residency isn&apos;t just a feature; it&apos;s a
                requirement for many industries. We&apos;re built to help you
                meet it, and we&apos;re honest about the trade-offs.
              </p>
            </div>
          </AnimateOnScroll>

          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {VERTICALS.map((vertical) => (
              <AnimateOnScroll key={vertical.title}>
                <div className="rounded-xl border bg-card p-6">
                  <h3 className="text-lg font-semibold">{vertical.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {vertical.description}
                  </p>
                </div>
              </AnimateOnScroll>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="container mx-auto px-4 pb-16 sm:pb-24">
          <AnimateOnScroll>
            <div className="rounded-2xl border bg-card p-8 text-center sm:p-12">
              <h2 className="text-2xl font-bold sm:text-3xl">
                Ready to keep your data in Australia?
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
                Start your 30-day free trial. No credit card required. Your
                business data is stored on Australian servers from day one.
              </p>
              <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                <Link href="/signup">
                  <Button
                    size="lg"
                    className="bg-orange-500 text-white hover:bg-orange-600"
                  >
                    Start Free Trial
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
                <Link href="/privacy">
                  <Button size="lg" variant="outline">
                    Read Privacy Policy
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
