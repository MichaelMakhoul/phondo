import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Bot, MoreVertical, Phone, ArrowUpRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { checkResourceLimit } from "@/lib/stripe/billing-service";
import { EmptyState } from "@/components/ui/empty-state";

interface Assistant {
  id: string;
  name: string;
  system_prompt: string;
  is_active: boolean;
  phone_numbers?: { count: number }[];
}

export default async function AssistantsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Get user's current organization
  const { data: membership } = await supabase
    .from("org_members")
    .select("organization_id")
    .eq("user_id", user!.id)
    .single() as { data: { organization_id: string } | null };

  const orgId = membership?.organization_id || "";

  // Get assistants with phone number count
  const { data: assistants } = orgId ? await supabase
    .from("assistants")
    .select(`
      *,
      phone_numbers (count)
    `)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false }) as { data: Assistant[] | null } : { data: null };

  // Check resource limit for assistants
  const limitInfo = orgId ? await checkResourceLimit(orgId, "assistants") : null;
  const atLimit = limitInfo ? !limitInfo.allowed : false;
  const showLimitBadge = limitInfo && limitInfo.limit > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold">AI Assistants</h1>
            <p className="text-muted-foreground">
              Create and manage your AI receptionists
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
          {atLimit ? (
            <Button disabled>
              <Plus className="mr-2 h-4 w-4" />
              New Assistant
            </Button>
          ) : (
            <Link href="/assistants/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Assistant
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* Assistants Grid */}
      {assistants && assistants.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {assistants.map((assistant) => (
            <Card key={assistant.id} className="relative">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <Bot className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-lg">{assistant.name}</CardTitle>
                      <CardDescription className="text-xs">
                        AI Receptionist
                      </CardDescription>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Assistant options">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/assistants/${assistant.id}`}>Edit</Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/assistants/${assistant.id}/test`}>
                          Test Call
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive">
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {assistant.system_prompt.substring(0, 100)}...
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant={assistant.is_active ? "success" : "secondary"} className="gap-1.5">
                      {assistant.is_active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse-dot" />
                      )}
                      {assistant.is_active ? "Active" : "Inactive"}
                    </Badge>
                    {assistant.phone_numbers && assistant.phone_numbers[0]?.count > 0 && (
                      <Badge variant="outline" className="gap-1">
                        <Phone className="h-3 w-3" />
                        {assistant.phone_numbers[0].count}
                      </Badge>
                    )}
                  </div>
                  <Link href={`/assistants/${assistant.id}`}>
                    <Button variant="ghost" size="sm">
                      Configure
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="p-12">
          <EmptyState
            icon={Bot}
            title="No assistants yet"
            description="Create your first AI receptionist to start answering calls"
            action={
              <Link href="/assistants/new">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Assistant
                </Button>
              </Link>
            }
          />
        </Card>
      )}
    </div>
  );
}
