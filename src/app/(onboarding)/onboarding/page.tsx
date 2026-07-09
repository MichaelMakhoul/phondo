"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { createOrResumeOrganization } from "@/lib/onboarding/create-org";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/use-toast";
import { BusinessInfo } from "./steps/BusinessInfo";
import { AssistantSetup } from "./steps/AssistantSetup";
import { Forwarding } from "./steps/Forwarding";
import { validateForwarding } from "./steps/forwarding-save";
import { TestCall } from "./steps/TestCall";
import { GoLive } from "./steps/GoLive";
import { Success } from "./steps/Success";
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, Clock } from "lucide-react";
import { getCountryConfig } from "@/lib/country-config";
import { buildCustomInstructionsFromBusinessInfo } from "@/lib/scraper/build-custom-instructions";
import { parsePhoneToE164, type SupportedCountry } from "@/lib/phone/normalize";
import {
  trackOnboardingStart,
  trackOnboardingStepComplete,
  trackOnboardingWebsiteScan,
  trackOnboardingPlanSelected,
  trackOnboardingComplete,
} from "@/lib/analytics";

interface OnboardingData {
  // Step 1: Business Info
  country: string;
  businessName: string;
  industry: string;
  businessPhone: string;
  businessWebsite: string;
  // Scraped website content (cached until org creation)
  scrapedKBContent: string;
  scrapedSourceUrl: string;
  scrapedAddress: string; // Persisted to organizations.business_address
  scrapedCustomInstructions: string; // Injected into prompt config, not persisted directly
  // Step 2: Assistant Setup
  assistantName: string;
  systemPrompt: string;
  firstMessage: string;
  voiceId: string;
  promptConfig: Record<string, any> | null;
  // Step 3: Forwarding (SCRUM-284)
  // transferNumber → a transfer_rule created when leaving this step (assistant
  // exists by then). fallbackForwardNumber → stashed here and applied to the
  // provisioned phone number at handleComplete (the number doesn't exist until
  // Go Live, two steps later). transferRuleCreated guards against double-create
  // if the user navigates back and forward.
  transferNumber: string;
  fallbackForwardNumber: string;
  transferRuleCreated: boolean;
  // Step 4: Test Call (no data, just completion state)
  testCallCompleted: boolean;
  // Step 5: Go Live
  areaCode: string;
  selectedPlan: string;
  selectedPhoneNumber: string;
  // Created resources (persisted so we don't re-create)
  createdOrgId: string;
  createdAssistantId: string;
}

const initialData: OnboardingData = {
  country: "",
  businessName: "",
  industry: "",
  businessPhone: "",
  businessWebsite: "",
  scrapedKBContent: "",
  scrapedSourceUrl: "",
  scrapedAddress: "",
  scrapedCustomInstructions: "",
  assistantName: "",
  systemPrompt: "",
  firstMessage: "",
  voiceId: "",
  promptConfig: null,
  transferNumber: "",
  fallbackForwardNumber: "",
  transferRuleCreated: false,
  testCallCompleted: false,
  areaCode: "",
  selectedPlan: "",
  selectedPhoneNumber: "",
  createdOrgId: "",
  createdAssistantId: "",
};

// Pre-launch lockdown (SCRUM-215): mirrors the server-side PROVISIONING_ENABLED
// gate. When off (default), the Go Live step hides paid plans + number search and
// everyone completes on the 14-day free trial; set to "true" at launch to restore
// the full number + plan selection flow.
const PROVISIONING_ENABLED = process.env.NEXT_PUBLIC_PROVISIONING_ENABLED === "true";

const steps = [
  { id: 1, name: "Business Info", description: "Tell us about your business", minutes: 2 },
  { id: 2, name: "AI Setup", description: "Configure your AI receptionist", minutes: 2 },
  { id: 3, name: "Forwarding", description: "Where calls go when the AI can't help", minutes: 1 },
  { id: 4, name: "Test Call", description: "Try out your AI", minutes: 1 },
  { id: 5, name: "Go Live", description: "Launch your AI receptionist", minutes: 1 },
];

const TOTAL_STEPS = steps.length; // 5 wizard steps; step 6 is the celebration screen

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [provisionedNumber, setProvisionedNumber] = useState("");
  const [data, setData] = useState<OnboardingData>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<{
    businessInfo: Record<string, any>;
    totalPages: number;
  } | null>(null);
  const router = useRouter();
  const { toast } = useToast();
  const supabase = createClient();

  // Load saved progress from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("onboarding_progress");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setData(parsed.data || initialData);
        setCurrentStep(parsed.step || 1);
      } catch {
        // Invalid saved data, start fresh
        trackOnboardingStart();
      }
    } else {
      trackOnboardingStart();
    }
  }, []);

  // Save progress to localStorage
  useEffect(() => {
    localStorage.setItem(
      "onboarding_progress",
      JSON.stringify({ data, step: currentStep })
    );
  }, [data, currentStep]);

  const updateData = (updates: Partial<OnboardingData>) => {
    setData((prev) => ({ ...prev, ...updates }));
  };

  const handleScrape = async (url: string) => {
    setIsScraping(true);
    setScrapeResult(null);
    try {
      const res = await fetch("/api/v1/scrape-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to scan website");
      }

      const result = await res.json();

      // Cache KB content for saving after org creation; reset scraped fields.
      // Cap to the KB API's 50k limit — a large multi-page scrape would
      // otherwise 400 on save ("String must contain at most 50000 characters").
      const MAX_KB_CONTENT = 50_000;
      const scrapedContent: string = result.content || "";
      const wasTruncated = scrapedContent.length > MAX_KB_CONTENT;
      const updates: Partial<OnboardingData> = {
        scrapedKBContent: scrapedContent.slice(0, MAX_KB_CONTENT),
        scrapedSourceUrl: url,
        scrapedAddress: "",
        scrapedCustomInstructions: "",
      };

      // Auto-fill fields from scraped data (user clicked Import, so overwrite)
      if (result.businessInfo?.name) {
        updates.businessName = result.businessInfo.name;
      }
      if (result.businessInfo?.phone) {
        updates.businessPhone = result.businessInfo.phone;
      }
      if (result.businessInfo?.address) {
        updates.scrapedAddress = result.businessInfo.address;
      }

      // Build custom instructions from scraped business info
      const instructions = buildCustomInstructionsFromBusinessInfo(result.businessInfo || {});
      if (instructions) {
        const MAX_CUSTOM_INSTRUCTIONS = 2000;
        updates.scrapedCustomInstructions = instructions.length > MAX_CUSTOM_INSTRUCTIONS
          ? instructions.substring(0, MAX_CUSTOM_INSTRUCTIONS)
          : instructions;
      }

      updateData(updates);
      setScrapeResult({
        businessInfo: result.businessInfo || {},
        totalPages: result.totalPages || 0,
      });
      // Truncation used to be silent, so the AI would later be unable to answer
      // from the dropped tail with nothing to explain why. Say so plainly.
      if (wasTruncated) {
        toast({
          title: "Imported the first 50,000 characters",
          description:
            "Your website is large, so we saved the first 50,000 characters. You can add anything we missed in Knowledge Base later.",
        });
      }
      trackOnboardingWebsiteScan(true);
    } catch (error: any) {
      trackOnboardingWebsiteScan(false);
      toast({
        variant: "destructive",
        title: "Import failed",
        description: error.message || "Could not scan the website. Please try again.",
      });
    } finally {
      setIsScraping(false);
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 1:
        return data.country !== "" && data.businessName.trim() !== "" && data.industry !== "";
      case 2:
        return (
          data.assistantName.trim() !== "" &&
          data.systemPrompt.trim() !== "" &&
          data.firstMessage.trim() !== "" &&
          data.voiceId !== ""
        );
      case 3:
        return true; // Forwarding is optional — both numbers can be skipped
      case 4:
        return true; // Test call is optional
      case 5: {
        // Early access (provisioning off): no number/plan required — everyone
        // completes on the 14-day trial. Full requirement returns at launch.
        return PROVISIONING_ENABLED
          ? data.selectedPhoneNumber !== "" && data.selectedPlan !== ""
          : true;
      }
      default:
        return false;
    }
  };

  const handleNext = async () => {
    if (currentStep >= TOTAL_STEPS || !canProceed() || isLoading) return;

    // SCRUM-295: block step 1 → 2 if the phone is non-empty but won't
    // normalise to E.164. Without this guard the bad value silently becomes
    // null at the step 2 → 3 write below, and the user finishes onboarding
    // thinking they configured a forwarding number when they didn't.
    if (currentStep === 1 && data.businessPhone.trim()) {
      const c: SupportedCountry = data.country === "US" ? "US" : "AU";
      if (!parsePhoneToE164(data.businessPhone, c)) {
        const example = c === "US" ? "+14155551234" : "+61412345678";
        toast({
          variant: "destructive",
          title: "Invalid business phone",
          description: `"${data.businessPhone}" isn't a valid ${c} phone number. Use international format (e.g. ${example}).`,
        });
        return;
      }
    }

    // When moving from step 2 → 3, create org + assistant so test call works.
    // SCRUM-426: idempotent resume — if a previous attempt failed AFTER org
    // creation, data.createdOrgId (persisted immediately below) lets the
    // retry reuse the org instead of creating a second one / hitting the
    // owned-org cap. Slug collisions retry with a suffix inside
    // createOrResumeOrganization.
    if (currentStep === 2 && !data.createdAssistantId) {
      setIsLoading(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("You must be logged in.");

        let orgId = data.createdOrgId;
        let resumedExisting = false;

        // SCRUM-426 review: a persisted id can be STALE — localStorage isn't
        // keyed by user (shared browser / logout), and support may delete a
        // half-org to free the owned-org cap. Trust it only if THIS user is a
        // member; otherwise clear it and fall through to create/resume —
        // never wedge onboarding on an id that no longer resolves.
        if (orgId) {
          const { data: membership } = await (supabase as any)
            .from("org_members")
            .select("organization_id")
            .eq("organization_id", orgId)
            .eq("user_id", user.id)
            .maybeSingle();
          if (membership) {
            resumedExisting = true;
          } else {
            console.warn("[Onboarding] Persisted createdOrgId is stale — creating fresh:", orgId);
            orgId = "";
            updateData({ createdOrgId: "" });
          }
        }

        if (!orgId) {
          const created = await createOrResumeOrganization(supabase as any, user.id, data.businessName);
          if (!created.ok) {
            // User owns an org we couldn't locate — the pre-existing fallback.
            router.push("/dashboard");
            return;
          }
          orgId = created.orgId;
          resumedExisting = created.resumed;
          // Persist BEFORE the fallible steps below — this is what makes a
          // retry resume instead of re-creating (audit finding #24). Written
          // synchronously too: the React save-effect flushes a render later,
          // and a tab close in that window would lose the id.
          updateData({ createdOrgId: orgId });
          localStorage.setItem(
            "onboarding_progress",
            JSON.stringify({ data: { ...data, createdOrgId: orgId }, step: currentStep })
          );
        }

        // Update org with business info
        const countryConfig = data.country ? getCountryConfig(data.country) : null;
        // SCRUM-295: normalise to E.164 before write. If we can't normalise,
        // fall back to null rather than writing garbage — the DB CHECK
        // constraint would reject it anyway. The form's own validate() should
        // have caught this, so a null here means the user truly skipped it.
        const targetCountry: SupportedCountry = data.country === "US" ? "US" : "AU";
        const normalisedBusinessPhone = data.businessPhone?.trim()
          ? parsePhoneToE164(data.businessPhone, targetCountry)
          : null;
        // supabase-js resolves with { error } instead of throwing — without
        // this check a failed write (e.g. a future column missing from the
        // 00150 UPDATE allowlist → 42501) would let the user finish
        // onboarding with default country/timezone and no industry, silently
        // (SCRUM-421 review). Throwing routes it to the catch + toast below.
        const { error: orgUpdateError } = await (supabase as any)
          .from("organizations")
          .update({
            // name: a resumed org keeps the FIRST attempt's name otherwise —
            // the user may have fixed a typo between attempts (SCRUM-426
            // review). slug intentionally stays as created (cosmetic, and
            // locked to service-role by migration 00150 anyway).
            name: data.businessName,
            industry: data.industry,
            business_phone: normalisedBusinessPhone,
            business_website: data.businessWebsite || null,
            business_address: data.scrapedAddress || null,
            country: data.country || "US",
            timezone: countryConfig?.defaultTimezone || "America/New_York",
          })
          .eq("id", orgId);
        if (orgUpdateError) {
          throw new Error(`Failed to save business details: ${orgUpdateError.message}`);
        }

        // SCRUM-426: when resuming into an existing org, adopt an existing
        // assistant rather than creating a duplicate (a prior attempt — or a
        // second tab — may have gotten further than the persisted state knew).
        let adoptedAssistantId: string | null = null;
        if (resumedExisting) {
          const { data: existingAssistants } = await (supabase as any)
            .from("assistants")
            .select("id")
            .eq("organization_id", orgId)
            .limit(1);
          if (existingAssistants && existingAssistants.length > 0) {
            adoptedAssistantId = existingAssistants[0].id;
            console.log("[Onboarding] Resumed — adopting existing assistant:", adoptedAssistantId);
          }
        }

        // Save scraped KB content (if user imported from website; skipped
        // when adopting — the prior attempt already imported it)
        if (!adoptedAssistantId && data.scrapedKBContent) {
          const kbTitle = (() => {
            try { return new URL(data.scrapedSourceUrl).hostname.replace(/^www\./, ""); }
            catch { return "Website Import"; }
          })();

          try {
            const kbRes = await fetch("/api/v1/knowledge-base", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: kbTitle,
                sourceType: "website",
                // Guard resumed sessions whose cached content predates the cap.
                content: data.scrapedKBContent.slice(0, 50_000),
                sourceUrl: data.scrapedSourceUrl,
              }),
            });
            if (!kbRes.ok) {
              console.error("KB save failed:", kbRes.status);
              toast({ title: "Website import saved partially", description: "Your assistant was created but the knowledge base import failed. You can re-import later from settings.", variant: "destructive" });
            }
          } catch (err) {
            console.error("Failed to save scraped KB:", err);
            toast({ title: "Website import saved partially", description: "Your assistant was created but the knowledge base import failed. You can re-import later from settings.", variant: "destructive" });
          }
        }

        // Create assistant (unless one was adopted on resume)
        if (!adoptedAssistantId) {
          const piiIndustries = ["medical", "dental", "legal"];
          const assistantSettings: Record<string, any> = {};
          if (piiIndustries.includes(data.industry)) {
            assistantSettings.piiRedactionEnabled = true;
          }
          const assistantResponse = await fetch("/api/v1/assistants", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: data.assistantName,
              systemPrompt: data.systemPrompt,
              firstMessage: data.firstMessage,
              voiceId: data.voiceId || "EXAVITQu4vr4xnSDxMaL",
              voiceProvider: "11labs",
              promptConfig: data.promptConfig || undefined,
              settings: Object.keys(assistantSettings).length > 0 ? assistantSettings : undefined,
            }),
          });

          if (!assistantResponse.ok) {
            const errorData = await assistantResponse.json().catch(() => ({}));
            throw new Error(errorData.error || "Failed to create assistant");
          }

          const assistant = await assistantResponse.json();
          adoptedAssistantId = assistant.id;

          // Seed industry-default service types (non-fatal)
          try {
            const seedRes = await fetch("/api/v1/service-types/seed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ organizationId: orgId, industry: data.industry }),
            });
            if (!seedRes.ok) {
              console.warn("Service type seeding returned non-OK status:", seedRes.status);
            }
          } catch (seedErr) {
            console.warn("Service type seeding failed (non-fatal):", seedErr);
          }
        }

        // adoptedAssistantId is always set by here (adopted on resume, or
        // assigned from the create response above) — ?? "" is for the type.
        updateData({ createdOrgId: orgId, createdAssistantId: adoptedAssistantId ?? "" });
      } catch (error: any) {
        toast({
          variant: "destructive",
          title: "Error",
          description: error.message || "Failed to set up. Please try again.",
        });
        setIsLoading(false);
        return;
      } finally {
        setIsLoading(false);
      }
    }

    // SCRUM-284: leaving the Forwarding step (3) — create the mid-call transfer
    // rule now (the assistant exists). The emergency fallback number is stashed
    // in onboarding data (normalised) and applied to the phone number at
    // handleComplete, since the number isn't provisioned until Go Live. Both
    // are optional. validateForwarding rejects a half-valid pair up front.
    if (currentStep === 3) {
      const country: SupportedCountry = data.country === "US" ? "US" : "AU";
      const result = validateForwarding(data.transferNumber, data.fallbackForwardNumber, country);
      if (!result.ok) {
        const example = country === "US" ? "+14155551234" : "+61412345678";
        toast({
          variant: "destructive",
          title: result.errorField === "fallback" ? "Invalid fallback number" : "Invalid transfer number",
          description: `That isn't a valid ${country} phone number. Use international format (e.g. ${example}).`,
        });
        return;
      }

      // Persist the normalised values so the transfer rule + the fallback PATCH
      // at handleComplete both use clean E.164.
      updateData({
        transferNumber: result.transfer ?? "",
        fallbackForwardNumber: result.fallback ?? "",
      });

      if (result.transfer && data.createdAssistantId && !data.transferRuleCreated) {
        setIsLoading(true);
        try {
          const res = await fetch("/api/v1/transfer/rules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              assistantId: data.createdAssistantId,
              name: "Default Transfer",
              transferToPhone: result.transfer,
              priority: 100,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || "Failed to save transfer number");
          }
          updateData({ transferRuleCreated: true });
        } catch (error: any) {
          toast({
            variant: "destructive",
            title: "Couldn't save transfer number",
            description: error?.message || "Please try again, or skip and set it up later from settings.",
          });
          setIsLoading(false);
          return;
        } finally {
          setIsLoading(false);
        }
      }
    }

    const stepNames = ["", "Business Info", "Assistant Setup", "Forwarding", "Test Call", "Go Live"];
    trackOnboardingStepComplete(currentStep, stepNames[currentStep] || `Step ${currentStep}`);
    setCurrentStep((prev) => prev + 1);
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "You must be logged in to complete onboarding.",
        });
        setIsCompleting(false);
        return;
      }

      // Org + assistant already created in step 2→3 transition
      const orgId = data.createdOrgId;
      if (!orgId) {
        throw new Error("Organization not found. Please go back and try again.");
      }

      // Create subscription record via server-side API (validates plan + sets limits server-side)
      const subRes = await fetch("/api/v1/subscriptions/trial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: orgId,
          planType: data.selectedPlan || "starter",
        }),
      });

      if (!subRes.ok) {
        const rawText = await subRes.text();
        let subErr: { error?: string } = {};
        try {
          subErr = JSON.parse(rawText);
        } catch {
          // Non-JSON response (e.g. reverse proxy error page)
        }
        throw new Error(subErr.error || `Failed to create subscription (status ${subRes.status})`);
      }

      // Step 5: Provision the selected phone number
      if (data.selectedPhoneNumber) {
        const phoneRes = await fetch("/api/v1/phone-numbers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            areaCode: data.areaCode,
            assistantId: data.createdAssistantId || undefined,
          }),
        });

        if (!phoneRes.ok) {
          const phoneErr = await phoneRes.json().catch(() => ({}));
          console.error("Phone number provisioning failed:", phoneErr);

          // PROVISIONING_DISABLED is the pre-launch kill switch. Block advancement
          // entirely and surface a clear blocking error — never advance to the
          // "You're Live!" celebration screen with a trial subscription created
          // but no phone number behind it.
          if (phoneRes.status === 503 && phoneErr?.code === "PROVISIONING_DISABLED") {
            toast({
              variant: "destructive",
              title: "We're in private beta",
              description:
                "Phondo isn't accepting new signups just yet. Drop us a line at hello@phondo.ai and we'll get you early access.",
            });
            setIsCompleting(false);
            return;
          }

          // Any other provisioning failure: also block advancement so the user
          // doesn't land in a half-configured state where they have a live
          // subscription but no phone number.
          toast({
            variant: "destructive",
            title: "Phone number setup failed",
            description:
              phoneErr?.error ||
              "We couldn't provision your number. Please try again in a moment or contact support.",
          });
          setIsCompleting(false);
          return;
        }

        // Capture the provisioned number for the "You're Live!" screen. The buy
        // route selects the actual number (which may differ from the picker
        // choice), so read it from the response — and read the body only once,
        // since it can't be re-read for the fallback PATCH below.
        // A 2xx with an unreadable body means the number IS provisioned but we
        // can't see it: don't fail go-live, but never let it pass silently — it
        // downgrades the success screen and skips the fallback PATCH below.
        const phoneRecord = await phoneRes.json().catch((parseErr) => {
          console.error("Provisioning succeeded but the response body was unreadable:", parseErr);
          return null;
        });
        if (phoneRecord?.phone_number) {
          setProvisionedNumber(phoneRecord.phone_number);
        } else {
          console.error("Provisioning response is missing phone_number; success screen will not show the number.");
        }

        // SCRUM-284: apply the emergency fallback number captured in the
        // Forwarding step. The number only exists now (just provisioned), so
        // we PATCH it on. Non-fatal — a failure here shouldn't block go-live;
        // the owner can set it later from settings.
        if (data.fallbackForwardNumber.trim()) {
          const fallbackToast = () =>
            toast({
              title: "Number is live. One thing to finish",
              description: "We couldn't set your emergency fallback number. You can add it any time from Settings → Phone Numbers.",
            });
          try {
            if (phoneRecord?.id) {
              const patchRes = await fetch(`/api/v1/phone-numbers/${phoneRecord.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fallbackForwardNumber: data.fallbackForwardNumber.trim() }),
              });
              if (!patchRes.ok) {
                console.error("Fallback forward number setup failed:", await patchRes.json().catch(() => ({})));
                // Non-blocking: the number is live and the AI works; the owner
                // can set the emergency fallback in Settings. Surface it so it
                // isn't a silent gap on a routing-critical field.
                fallbackToast();
              }
            } else {
              // No id to PATCH: the fallback the user explicitly entered was
              // never applied. Same routing-critical gap, so same warning.
              console.error("Cannot apply fallback forward number: provisioning response had no id.");
              fallbackToast();
            }
          } catch (fbErr) {
            console.error("Failed to apply fallback forward number (non-fatal):", fbErr);
            fallbackToast();
          }
        }
      }

      // Step 6: Create notification preferences with defaults
      const { error: notifError } = await (supabase as any)
        .from("notification_preferences")
        .insert({
          organization_id: orgId,
          email_on_missed_call: true,
          email_on_voicemail: true,
          email_daily_summary: true,
          sms_on_missed_call: false,
          sms_on_voicemail: false,
        });

      if (notifError) {
        console.error("Failed to create notification preferences:", notifError);
        // Non-fatal, continue
      }

      // Clear onboarding progress
      localStorage.removeItem("onboarding_progress");

      // Show celebration screen (one past the last wizard step)
      trackOnboardingStepComplete(TOTAL_STEPS, "Go Live");
      trackOnboardingPlanSelected(data.selectedPlan || "starter");
      trackOnboardingComplete(data.selectedPlan || "starter", data.industry || "unknown");
      setCurrentStep(TOTAL_STEPS + 1);
      setIsCompleting(false);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Something went wrong. Please try again.",
      });
      setIsCompleting(false);
    }
  };

  const progress = (currentStep / TOTAL_STEPS) * 100;
  const minutesRemaining = steps
    .filter((s) => s.id >= currentStep)
    .reduce((sum, s) => sum + s.minutes, 0);

  // Celebration screen (after successful completion) — one past the last wizard step
  if (currentStep === TOTAL_STEPS + 1) {
    const planLabel =
      data.selectedPlan === "business" ? "Business" :
      data.selectedPlan === "professional" ? "Professional" : "Starter";

    return (
      <div className="flex min-h-screen flex-col bg-muted/50">
        <main className="flex flex-1 items-center justify-center px-4 py-12">
          <div className="w-full max-w-lg">
            <Card>
              <CardContent className="pt-8 pb-6">
                <Success
                  businessName={data.businessName}
                  planName={planLabel}
                  phoneNumber={provisionedNumber || undefined}
                  countryCode={data.country}
                />
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/50">
      {/* Header with Progress */}
      <header className="border-b bg-background px-4 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-xl font-semibold">Set Up Your AI Receptionist</h1>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                ~{minutesRemaining} min left
              </span>
              <span className="text-sm text-muted-foreground">
                Step {currentStep} of {TOTAL_STEPS}
              </span>
            </div>
          </div>
          <Progress value={progress} className="h-2" />
          <div className="mt-3 flex justify-between">
            {steps.map((step) => (
              <div
                key={step.id}
                className={`flex items-center gap-2 text-sm ${
                  step.id === currentStep
                    ? "font-medium text-primary"
                    : step.id < currentStep
                    ? "text-muted-foreground"
                    : "text-muted-foreground/50"
                }`}
              >
                {step.id < currentStep ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : (
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                      step.id === currentStep
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    {step.id}
                  </span>
                )}
                <span className="hidden sm:inline">{step.name}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto max-w-3xl">
          <Card>
            <CardHeader>
              <CardTitle>{steps[currentStep - 1].name}</CardTitle>
              <CardDescription>
                {steps[currentStep - 1].description}
                {" — "}
                <span className="text-primary">~{steps[currentStep - 1].minutes} min</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {currentStep === 1 && (
                <BusinessInfo
                  data={{
                    country: data.country,
                    businessName: data.businessName,
                    industry: data.industry,
                    businessPhone: data.businessPhone,
                    businessWebsite: data.businessWebsite,
                  }}
                  onChange={(updates) => updateData(updates)}
                  onScrape={handleScrape}
                  isScraping={isScraping}
                  scrapeResult={scrapeResult}
                />
              )}

              {currentStep === 2 && (
                <AssistantSetup
                  data={{
                    assistantName: data.assistantName,
                    systemPrompt: data.systemPrompt,
                    firstMessage: data.firstMessage,
                    voiceId: data.voiceId,
                  }}
                  businessInfo={{
                    businessName: data.businessName,
                    industry: data.industry,
                    country: data.country,
                  }}
                  scrapedCustomInstructions={data.scrapedCustomInstructions}
                  onChange={(updates) => updateData(updates)}
                />
              )}

              {currentStep === 3 && (
                <Forwarding
                  data={{
                    transferNumber: data.transferNumber,
                    fallbackForwardNumber: data.fallbackForwardNumber,
                  }}
                  countryCode={data.country || "US"}
                  onChange={(updates) => updateData(updates)}
                />
              )}

              {currentStep === 4 && (
                <TestCall
                  assistantData={{
                    assistantId: data.createdAssistantId,
                    assistantName: data.assistantName,
                    systemPrompt: data.systemPrompt,
                    firstMessage: data.firstMessage,
                    voiceId: data.voiceId,
                  }}
                  onTestComplete={() => {
                    updateData({ testCallCompleted: true });
                    handleNext();
                  }}
                />
              )}

              {currentStep === 5 && (
                <GoLive
                  data={{
                    areaCode: data.areaCode,
                    selectedPlan: data.selectedPlan,
                    selectedPhoneNumber: data.selectedPhoneNumber,
                  }}
                  countryCode={data.country || "US"}
                  provisioningEnabled={PROVISIONING_ENABLED}
                  onChange={(updates) => updateData(updates)}
                />
              )}
            </CardContent>
          </Card>

          {/* Navigation Buttons */}
          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={handleBack}
              disabled={currentStep === 1 || isCompleting}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>

            {currentStep < TOTAL_STEPS ? (
              currentStep === 4 ? (
                // On test call step, show skip button (main continue is in the component)
                <Button
                  variant="ghost"
                  onClick={handleNext}
                  disabled={isCompleting}
                >
                  Skip for now
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={handleNext} disabled={!canProceed() || isCompleting || isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Setting up...
                    </>
                  ) : (
                    <>
                      Continue
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </>
                  )}
                </Button>
              )
            ) : (
              <Button
                onClick={handleComplete}
                disabled={!canProceed() || isCompleting}
                className="min-w-[140px]"
              >
                {isCompleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Setting up...
                  </>
                ) : (
                  <>
                    Complete Setup
                    <CheckCircle2 className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
