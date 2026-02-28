import { Metadata } from "next";
import Link from "next/link";
import {
  Shield,
  Server,
  Lock,
  MapPin,
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
  title: "Australian Data Sovereignty | Hola Recep",
  description:
    "Your business data stays in Australia. Hola Recep hosts all data on Australian servers with enterprise-grade security, encryption, and compliance.",
};

const INFRASTRUCTURE = [
  {
    icon: Server,
    title: "Australian-Hosted Database",
    description:
      "All call data, transcripts, and business information stored on Supabase servers in Sydney (ap-southeast-2). Your data never leaves Australian soil.",
  },
  {
    icon: Globe,
    title: "Sydney Edge Network",
    description:
      "Application served from Australian edge nodes for the fastest possible response times. Sub-50ms latency for Australian users.",
  },
  {
    icon: Lock,
    title: "End-to-End Encryption",
    description:
      "TLS 1.3 encryption in transit. AES-256 encryption at rest. Your call recordings and transcripts are protected at every stage.",
  },
  {
    icon: MapPin,
    title: "Australian Voice Processing",
    description:
      "Voice calls processed through our Sydney-based voice server on Fly.io. Audio streams stay within the Australian network wherever possible.",
  },
];

const COMPLIANCE_POINTS = [
  "All data stored in Sydney, Australia (ap-southeast-2)",
  "Compliant with the Australian Privacy Act 1988",
  "Row-Level Security on all database tables",
  "No data shared with offshore third parties without consent",
  "Call recording consent handled per state requirements",
  "Regular security audits and penetration testing",
  "SOC 2 Type II compliant infrastructure (Supabase)",
  "GDPR-ready for international clients",
];

const VERTICALS = [
  {
    title: "Medical & Dental",
    description:
      "Patient data stays in Australia. Critical for AHPRA compliance and medical privacy requirements. No offshore data transfers.",
  },
  {
    title: "Legal Practices",
    description:
      "Client confidentiality is paramount. Australian-hosted data ensures solicitor-client privilege is maintained under Australian law.",
  },
  {
    title: "Financial Services",
    description:
      "Meet APRA and ASIC data residency expectations. All financial conversation data stored and processed domestically.",
  },
  {
    title: "Government & Education",
    description:
      "Australian data sovereignty is a procurement requirement for many government and educational institutions.",
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
              Your data stays in Australia
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400 sm:text-xl">
              Every call recording, transcript, and piece of business data is
              hosted on Australian servers. No exceptions. No offshore transfers.
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
                Our infrastructure is purpose-built to keep your data within
                Australian borders while delivering enterprise-grade performance.
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
                  Compliance & security
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
                Australian data sovereignty isn&apos;t just a feature — it&apos;s
                a requirement for many industries. We make compliance effortless.
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
                Start your 14-day free trial. No credit card required. Your data
                stays on Australian servers from day one.
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
