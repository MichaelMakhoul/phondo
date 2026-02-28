import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Phone, MoreVertical, Bot, PhoneForwarded, AlertCircle, ArrowUpRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatPhoneNumber } from "@/lib/utils";
import { PhoneNumberActions } from "@/components/phone-numbers/phone-number-actions";
import { checkResourceLimit } from "@/lib/stripe/billing-service";
import { EmptyState } from "@/components/ui/empty-state";

interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  is_active: boolean;
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
            <Card key={phoneNumber.id} className="card-hover">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      {phoneNumber.source_type === "forwarded" ? (
                        <PhoneForwarded className="h-5 w-5 text-primary" />
                      ) : (
                        <Phone className="h-5 w-5 text-primary" />
                      )}
                    </div>
                    <div>
                      <CardTitle className="text-lg">
                        {formatPhoneNumber(phoneNumber.phone_number, countryCode)}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        {phoneNumber.friendly_name || "Phone Number"}
                      </CardDescription>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Phone number options">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Assign Assistant</DropdownMenuItem>
                      {phoneNumber.source_type === "forwarded" && (
                        <DropdownMenuItem>
                          View Forwarding Instructions
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem className="text-destructive">
                        {phoneNumber.source_type === "forwarded"
                          ? "Remove Forwarding"
                          : "Release Number"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge variant={phoneNumber.is_active ? "success" : "secondary"}>
                    {phoneNumber.is_active ? "Active" : "Inactive"}
                  </Badge>
                  {phoneNumber.source_type === "forwarded" && (
                    <Badge variant="outline">Forwarded</Badge>
                  )}
                </div>

                {/* Forwarding info */}
                {phoneNumber.source_type === "forwarded" && phoneNumber.user_phone_number && (
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2.5">
                    <PhoneForwarded className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">
                      Forwards from{" "}
                      <span className="font-medium text-foreground">
                        {formatPhoneNumber(phoneNumber.user_phone_number, countryCode)}
                      </span>
                    </p>
                  </div>
                )}

                {/* Pending setup banner */}
                {phoneNumber.forwarding_status === "pending_setup" && (
                  <div className="flex items-center gap-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-2.5">
                    <AlertCircle className="h-3.5 w-3.5 text-yellow-600" />
                    <p className="text-xs text-yellow-600">
                      Forwarding not yet confirmed
                    </p>
                  </div>
                )}

                {phoneNumber.assistants ? (
                  <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">
                        {phoneNumber.assistants.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Assigned Assistant
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed p-3 text-center">
                    <p className="text-sm text-muted-foreground">
                      No assistant assigned
                    </p>
                    <Button variant="link" size="sm" className="mt-1 h-auto p-0">
                      Assign now
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="p-12">
          <EmptyState
            icon={Phone}
            title="No phone numbers yet"
            description="Use your existing business number with call forwarding, or buy a new number"
            action={
              <PhoneNumberActions assistants={assistants || []} countryCode={countryCode} disabled={atLimit} />
            }
          />
        </Card>
      )}
    </div>
  );
}
