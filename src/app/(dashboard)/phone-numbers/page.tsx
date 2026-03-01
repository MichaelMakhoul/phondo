import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Phone, ArrowUpRight } from "lucide-react";
import { PhoneNumberActions } from "@/components/phone-numbers/phone-number-actions";
import { PhoneNumberCard } from "@/components/phone-numbers/phone-number-card";
import { checkResourceLimit } from "@/lib/stripe/billing-service";
import { EmptyState } from "@/components/ui/empty-state";
import { PhoneScene } from "@/components/ui/empty-state-scenes";

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  source_type: "purchased" | "forwarded";
  user_phone_number: string | null;
  forwarding_status: "pending_setup" | "active" | "paused" | null;
  carrier: string | null;
  assistants: { id: string; name: string } | null;
}

interface Assistant {
  id: string;
  name: string;
}

export default async function PhoneNumbersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: membership } = await supabase
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user!.id)
    .single() as { data: { organization_id: string } | null };

  const orgId = membership?.organization_id || "";

  // Get org's country
  let countryCode = "US";
  if (orgId) {
    const { data: org, error: orgError } = await (supabase as any)
      .from("organizations")
      .select("country")
      .eq("id", orgId)
      .single();
    if (!orgError && org?.country) {
      countryCode = org.country;
    }
  }

  // Get phone numbers
  const { data: phoneNumbers } = orgId ? await supabase
    .from("phone_numbers")
    .select(`
      *,
      assistants (id, name)
    `)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false }) as { data: PhoneNumber[] | null } : { data: null };

  // Get assistants for assignment
  const { data: assistants } = orgId ? await supabase
    .from("assistants")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("is_active", true) as { data: Assistant[] | null } : { data: null };

  // Check resource limit for phone numbers
  const limitInfo = orgId ? await checkResourceLimit(orgId, "phoneNumbers") : null;
  const atLimit = limitInfo ? !limitInfo.allowed : false;
  const showLimitBadge = limitInfo && limitInfo.limit > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold">Phone Numbers</h1>
            <p className="text-muted-foreground">
              Manage phone numbers for your assistants
            </p>
          </div>
          {showLimitBadge && (
            <Badge variant={atLimit ? "destructive" : "secondary"} className="ml-2">
              {limitInfo.currentCount} of {limitInfo.limit}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {atLimit && (
            <Link href="/billing">
              <Button variant="outline" size="sm">
                Upgrade <ArrowUpRight className="ml-1 h-3 w-3" />
              </Button>
            </Link>
          )}
          <PhoneNumberActions assistants={assistants || []} countryCode={countryCode} disabled={atLimit} />
        </div>
      </div>

      {/* Phone Numbers List */}
      {phoneNumbers && phoneNumbers.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {phoneNumbers.map((phoneNumber) => (
            <PhoneNumberCard
              key={phoneNumber.id}
              phoneNumber={phoneNumber}
              countryCode={countryCode}
            />
          ))}
        </div>
      ) : (
        <Card className="p-12">
          <EmptyState
            icon={Phone}
            title="No phone numbers yet"
            description="Use your existing business number with call forwarding, or buy a new number"
            illustration={<PhoneScene />}
            action={
              <PhoneNumberActions assistants={assistants || []} countryCode={countryCode} disabled={atLimit} />
            }
          />
        </Card>
      )}
    </div>
  );
}
