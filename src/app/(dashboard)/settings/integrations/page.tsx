"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntegrationList } from "@/components/integrations/IntegrationList";
import { IntegrationGuide } from "@/components/integrations/IntegrationGuide";
import { ActivityLog } from "@/components/integrations/ActivityLog";
import { ClinikoCard } from "@/components/integrations/cliniko-card";
import { createClient } from "@/lib/supabase/client";

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
      <div>
        <h2 className="text-lg font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect your practice software, or send call data anywhere via webhooks.
        </p>
      </div>

      {/* SCRUM-12: native CRM integrations */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Practice management</h3>
        <ClinikoCard />
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Webhooks</h3>
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
