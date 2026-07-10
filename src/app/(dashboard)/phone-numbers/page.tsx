import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Phone, ArrowUpRight } from "lucide-react";
import { PhoneNumberActions } from "@/components/phone-numbers/phone-number-actions";
import { PhoneNumberCard } from "@/components/phone-numbers/phone-number-card";
import { ForwardingGuideSection } from "@/components/phone-numbers/forwarding-guide-section";
import { checkResourceLimit } from "@/lib/stripe/billing-service";
import { EmptyState } from "@/components/ui/empty-state";
import { PhoneScene } from "@/components/ui/empty-state-scenes";
import type { PhoneNumber, Assistant } from "@/types/phone-number";
import { forwardingDestinations } from "@/lib/country-config/forwarding";

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
    } else if (orgError) {
      // SCRUM-528: the page proceeds with a defaulted "US" — at least make the
      // fallback visible in server logs until the page grows a real error
      // state. Country-sensitive children defend themselves: the forwarding
      // guide resolves the country from each number's own "+" prefix.
      console.error(`[PhoneNumbers] organizations lookup failed for org ${orgId} — defaulting country to US:`, orgError);
    }
  }

  // Get phone numbers
  const { data: phoneNumbers, error: phoneNumbersError } = orgId ? await supabase
    .from("phone_numbers")
    .select(`
      *,
      assistants (id, name)
    `)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false }) as unknown as { data: PhoneNumber[] | null; error: { message: string } | null } : { data: null, error: null };

  // Get assistants for assignment
  const { data: assistants } = orgId ? await supabase
    .from("assistants")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("is_active", true) as { data: Assistant[] | null } : { data: null };

  if (phoneNumbersError) {
    // SCRUM-538: a DB failure used to render "No phone numbers yet" — the
    // empty-state with purchase CTAs — to a customer who HAS numbers.
    console.error(`[PhoneNumbers] numbers lookup failed for org ${orgId}:`, phoneNumbersError);
  }

  // SCRUM-538: the card's "View Forwarding Instructions" item scrolls to the
  // guide — which only renders when at least one destination qualifies. Tell
  // the cards, so the item never scrolls to nothing.
  const hasForwardingGuide = forwardingDestinations(phoneNumbers ?? [], countryCode).length > 0;

  // Check resource limit for phone numbers
  const limitInfo = orgId ? await checkResourceLimit(orgId, "phoneNumbers") : null;
  const atLimit = limitInfo ? !limitInfo.allowed : false;
  const showLimitBadge = limitInfo && limitInfo.limit > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Phone Numbers</h1>
            {showLimitBadge && (
              <Badge variant={atLimit ? "destructive" : "secondary"}>
                {limitInfo.currentCount} of {limitInfo.limit}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            Manage phone numbers for your assistants
          </p>
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
      {phoneNumbersError ? (
        <Card className="p-12 text-center">
          <p className="font-medium">We couldn't load your phone numbers</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Your numbers are safe — this page just failed to load them. Refresh to try again.
          </p>
        </Card>
      ) : phoneNumbers && phoneNumbers.length > 0 ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {phoneNumbers.map((phoneNumber) => (
              <PhoneNumberCard
                key={phoneNumber.id}
                phoneNumber={phoneNumber}
                countryCode={countryCode}
                assistants={assistants || []}
                hasForwardingGuide={hasForwardingGuide}
              />
            ))}
          </div>

          {/* SCRUM-536: the forwarding guide lives here permanently. Before
              this it appeared once on the You're-Live screen and inside the
              "Add Number" wizard — nowhere an existing customer would look
              when they change carrier, get a new handset, or need the
              DISABLE code to switch forwarding off. */}
          <ForwardingGuideSection phoneNumbers={phoneNumbers} countryCode={countryCode} />
        </>
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
