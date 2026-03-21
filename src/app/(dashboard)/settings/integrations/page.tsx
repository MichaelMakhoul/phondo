"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { IntegrationList } from "@/components/integrations/IntegrationList";
import { IntegrationGuide } from "@/components/integrations/IntegrationGuide";
import { ActivityLog } from "@/components/integrations/ActivityLog";
import { createClient } from "@/lib/supabase/client";
import { Info } from "lucide-react";

export default function IntegrationsPage() {
  const [industry, setIndustry] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      (supabase as any)
        .from("org_members")
        .select("organizations(industry)")
        .eq("user_id", user.id)
        .single()
        .then(({ data }: { data: any }) => {
          if (data?.organizations?.industry) {
            setIndustry(data.organizations.industry);
          }
        });
    });
  }, []);

  return (
    <div className="space-y-6">
      {/* Phase 2 — CRM integrations coming soon */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>CRM integrations coming soon</AlertTitle>
        <AlertDescription>
          Direct CRM integrations (Cliniko, ServiceM8, Clio) are on our roadmap and coming soon.
          Webhook integrations are available now — send call data to any tool.
        </AlertDescription>
      </Alert>

      <div>
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Send call data to your CRM, spreadsheets, or any tool via webhooks.
        </p>
      </div>

      <Tabs defaultValue="integrations">
        <TabsList>
          <TabsTrigger value="integrations">My Integrations</TabsTrigger>
          <TabsTrigger value="guide">Integration Guide</TabsTrigger>
          <TabsTrigger value="activity">Activity Log</TabsTrigger>
        </TabsList>

        <TabsContent value="integrations" className="mt-4">
          <IntegrationList />
        </TabsContent>

        <TabsContent value="guide" className="mt-4">
          <IntegrationGuide industry={industry} />
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityLog />
        </TabsContent>
      </Tabs>
    </div>
  );
}
