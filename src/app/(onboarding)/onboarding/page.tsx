"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/use-toast";
import { BusinessInfo } from "./steps/BusinessInfo";
import { AssistantSetup } from "./steps/AssistantSetup";
import { TestCall } from "./steps/TestCall";
import { GoLive } from "./steps/GoLive";
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2 } from "lucide-react";
import { getCountryConfig } from "@/lib/country-config";
import { buildCustomInstructionsFromBusinessInfo } from "@/lib/scraper/build-custom-instructions";

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
  // Step 3: Test Call (no data, just completion state)
  testCallCompleted: boolean;
  // Step 4: Go Live
  areaCode: string;
  selectedPlan: string;
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
  testCallCompleted: false,
  areaCode: "",
  selectedPlan: "",
  createdOrgId: "",
  createdAssistantId: "",
};

const steps = [
  { id: 1, name: "Business Info", description: "Tell us about your business" },
  { id: 2, name: "AI Setup", description: "Configure your AI receptionist" },
  { id: 3, name: "Test Call", description: "Try out your AI" },
  { id: 4, name: "Go Live", description: "Choose your plan and phone number" },
];

export default function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState(1);
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
      }
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

      // Cache KB content for saving after org creation; reset scraped fields
      const updates: Partial<OnboardingData> = {
        scrapedKBContent: result.content,
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
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Import failed",
        description: error.message || "Could not scan the website. Please try again.",
      });
    } finally {
      setIsScraping(false);
    }
  };

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
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
        return true; // Test call is optional
      case 4: {
        const countryConfig = data.country ? getCountryConfig(data.country) : null;
        const requiredLen = countryConfig?.phone.areaCodeLength ?? 3;
        return data.areaCode.length === requiredLen && data.selectedPlan !== "";
      }
      default:
        return false;
    }
  };

  const handleNext = async () => {
    if (currentStep >= 4 || !canProceed() || isLoading) return;

    // When moving from step 2 → 3, create org + assistant so test call works
    if (currentStep === 2 && !data.createdAssistantId) {
      setIsLoading(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("You must be logged in.");

        // Create organization
        const slug = generateSlug(data.businessName);
        const { data: orgResult, error: orgError } = await (supabase.rpc as any)(
          "create_organization_with_owner",
          { org_name: data.businessName, org_slug: slug, org_type: "business" }
        ) as { data: any[] | null; error: any };

        if (orgError || !orgResult || orgResult.length === 0) {
          throw new Error(orgError?.message || "Failed to create organization");
        }

        const orgId = orgResult[0].id;

        // Update org with business info
        const countryConfig = data.country ? getCountryConfig(data.country) : null;
        await (supabase as any)
          .from("organizations")
          .update({
            industry: data.industry,
            business_phone: data.businessPhone || null,
            business_website: data.businessWebsite || null,
            business_address: data.scrapedAddress || null,
            country: data.country || "US",
            timezone: countryConfig?.defaultTimezone || "America/New_York",
          })
          .eq("id", orgId);

        // Save scraped KB content (if user imported from website)
        if (data.scrapedKBContent) {
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
                content: data.scrapedKBContent,
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

        // Create assistant
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
          }),
        });

        if (!assistantResponse.ok) {
          const errorData = await assistantResponse.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to create assistant");
        }

        const assistant = await assistantResponse.json();
        updateData({ createdOrgId: orgId, createdAssistantId: assistant.id });
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

      // Step 5: Create notification preferences with defaults
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

      toast({
        title: "Welcome to Hola Recep!",
        description: "Your AI receptionist is ready. Let's get you a phone number.",
      });

      // Redirect to phone numbers page
      router.push("/phone-numbers?setup=true");
      router.refresh();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Something went wrong. Please try again.",
      });
      setIsCompleting(false);
    }
  };

  const progress = (currentStep / 4) * 100;

  return (
    <div className="flex min-h-screen flex-col bg-muted/50">
      {/* Header with Progress */}
      <header className="border-b bg-background px-4 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-xl font-semibold">Set Up Your AI Receptionist</h1>
            <span className="text-sm text-muted-foreground">
              Step {currentStep} of 4
            </span>
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
                  }}
                  scrapedCustomInstructions={data.scrapedCustomInstructions}
                  onChange={(updates) => updateData(updates)}
                />
              )}

              {currentStep === 3 && (
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

              {currentStep === 4 && (
                <GoLive
                  data={{
                    areaCode: data.areaCode,
                    selectedPlan: data.selectedPlan,
                  }}
                  countryCode={data.country || "US"}
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

            {currentStep < 4 ? (
              currentStep === 3 ? (
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
