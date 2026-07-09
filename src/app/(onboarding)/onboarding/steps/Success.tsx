"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import confetti from "canvas-confetti";
import { Button } from "@/components/ui/button";
import { ForwardingInstructions } from "@/components/phone-numbers/forwarding-instructions";
import { FORWARDING_MODE_LABELS } from "@/lib/country-config/forwarding";
import { formatPhoneNumber } from "@/lib/utils";
import {
  CheckCircle2,
  Phone,
  ArrowRight,
  Sparkles,
  Calendar,
  Shield,
  Lightbulb,
} from "lucide-react";

interface SuccessProps {
  businessName: string;
  planName: string;
  // Provisioned number (E.164) if one was bought during onboarding. When set,
  // the screen reflects the live number instead of prompting to get one.
  phoneNumber?: string;
  countryCode?: string;
}

export function Success({ businessName, planName, phoneNumber, countryCode }: SuccessProps) {
  const router = useRouter();
  const formattedNumber = phoneNumber ? formatPhoneNumber(phoneNumber, countryCode) : "";

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Fire confetti from both sides
    const end = Date.now() + 1500;
    const frame = () => {
      confetti({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.6 },
        colors: ["#F97316", "#FB923C", "#FDBA74"],
      });
      confetti({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.6 },
        colors: ["#F97316", "#FB923C", "#FDBA74"],
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  }, []);

  const completedItems = [
    { icon: Sparkles, label: "AI receptionist created and trained" },
    { icon: Shield, label: "14-day free trial activated" },
    ...(phoneNumber
      ? [{ icon: Phone, label: `Phone number active: ${formattedNumber}` }]
      : []),
    { icon: Calendar, label: "Notification preferences configured" },
  ];

  // Once a number is provisioned, "get a phone number" no longer belongs in the
  // next steps — lead with forwarding instead.
  const nextSteps = phoneNumber
    ? [
        {
          label: "Forward or share your number",
          description: `Redirect your existing line to ${formattedNumber}, or share it with customers.`,
        },
        { label: "Receive your first call", description: "Your AI receptionist handles it from here." },
      ]
    : [
        { label: "Get a phone number", description: "Provision an Australian or US number for your AI to answer." },
        {
          label: "Forward or share your number",
          description: "Redirect your existing line or share the new number with customers.",
        },
        { label: "Receive your first call", description: "Your AI receptionist handles it from here." },
      ];

  return (
    <div className="space-y-8 text-center">
      {/* Hero */}
      <div className="space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
          <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="text-2xl font-bold">You&apos;re Live!</h2>
        <p className="text-muted-foreground">
          {businessName ? `${businessName}'s` : "Your"} AI receptionist is ready to take calls
          {phoneNumber ? (
            <>
              {" "}on <span className="font-medium text-foreground">{formattedNumber}</span>
            </>
          ) : null}{" "}
          on the <span className="font-medium text-foreground">{planName}</span> plan.
        </p>
      </div>

      {/* What was set up */}
      <div className="mx-auto max-w-sm space-y-3">
        {completedItems.map((item) => (
          <div key={item.label} className="flex items-center gap-3 text-left">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <item.icon className="h-4 w-4 text-green-600 dark:text-green-400" />
            </div>
            <span className="text-sm">{item.label}</span>
          </div>
        ))}
      </div>

      {/* Next steps */}
      <div className="rounded-lg border bg-muted/50 p-6 text-left">
        <h3 className="mb-4 text-sm font-semibold">Next steps</h3>
        <div className="space-y-4">
          {nextSteps.map((step, i) => (
            <div key={step.label} className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
                {i + 1}
              </div>
              <div>
                <p className="text-sm font-medium">{step.label}</p>
                <p className="text-xs text-muted-foreground">{step.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SCRUM-516: forwarding is the one step between finishing setup and the
          product doing anything. Telling the owner to "redirect your existing
          line" without giving them the code is where they stall. */}
      {phoneNumber && (
        <ForwardingInstructions
          destinationPhone={phoneNumber}
          countryCode={countryCode ?? "US"}
        />
      )}

      {/* Phased rollout tip */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-left">
        <div className="flex gap-3">
          <Lightbulb className="h-5 w-5 shrink-0 text-primary" />
          <div>
            <p className="text-sm font-medium">Pro tip: start with the calls you miss</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {phoneNumber ? (
                <>
                  Choose &quot;{FORWARDING_MODE_LABELS.conditional.title}&quot; above so your
                  phone still rings first and only the calls you miss reach your AI.
                </>
              ) : (
                <>
                  Once you have a number, forward only the calls you miss at first, so your
                  phone still rings first.
                </>
              )}{" "}
              Once you&apos;re confident it handles your common questions, switch to
              &quot;{FORWARDING_MODE_LABELS.unconditional.title}&quot;. Most businesses go
              fully live within a week.
            </p>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="flex flex-col items-center gap-3">
        {phoneNumber ? (
          <Button size="lg" className="gap-2" onClick={() => router.push("/dashboard")}>
            Go to Dashboard
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <>
            <Button
              size="lg"
              className="gap-2"
              onClick={() => router.push("/phone-numbers?setup=true")}
            >
              <Phone className="h-4 w-4" />
              Get Your Phone Number
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard")}>
              Go to Dashboard
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
