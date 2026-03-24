import { createAdminClient } from "@/lib/supabase/admin";
import { StatCard } from "@/components/admin/stat-card";
import { formatAdminDateShort } from "@/lib/admin/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Phone, Activity, Bot } from "lucide-react";

interface PhoneNumberRow {
  id: string;
  phone_number: string;
  is_active: boolean;
  ai_enabled: boolean;
  source_type: string | null;
  created_at: string;
  organization_id: string;
  assistant_id: string | null;
}

export default async function AdminNumbersPage() {
  const supabase = createAdminClient();

  const { data: numbersData, error: numbersError } = await (supabase as any)
    .from("phone_numbers")
    .select("id, phone_number, is_active, ai_enabled, source_type, created_at, organization_id, assistant_id")
    .order("created_at", { ascending: false });

  const numbers: PhoneNumberRow[] = numbersData ?? [];

  // Fetch org names
  const orgIds = [...new Set(numbers.map((n) => n.organization_id))];
  let orgNameMap: Record<string, string> = {};
  let orgQueryWarning: string | null = null;
  if (orgIds.length > 0) {
    const { data: orgs, error: orgsError } = await (supabase as any)
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    if (orgsError) {
      orgQueryWarning = `Could not load organization names: ${orgsError.message}`;
    } else if (orgs) {
      orgNameMap = Object.fromEntries(
        (orgs as { id: string; name: string }[]).map((o) => [o.id, o.name])
      );
    }
  }

  // Fetch assistant names
  const assistantIds = [
    ...new Set(numbers.filter((n) => n.assistant_id).map((n) => n.assistant_id!)),
  ];
  let assistantNameMap: Record<string, string> = {};
  let assistantQueryWarning: string | null = null;
  if (assistantIds.length > 0) {
    const { data: assistants, error: assistantsError } = await (supabase as any)
      .from("assistants")
      .select("id, name")
      .in("id", assistantIds);
    if (assistantsError) {
      assistantQueryWarning = `Could not load assistant names: ${assistantsError.message}`;
    } else if (assistants) {
      assistantNameMap = Object.fromEntries(
        (assistants as { id: string; name: string }[]).map((a) => [a.id, a.name])
      );
    }
  }

  const supplementaryWarnings = [orgQueryWarning, assistantQueryWarning].filter(Boolean);

  const totalNumbers = numbers.length;
  const activeCount = numbers.filter((n) => n.is_active).length;
  const aiEnabledCount = numbers.filter((n) => n.ai_enabled).length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Phone Numbers</h1>
        <p className="text-muted-foreground">
          All provisioned phone numbers across the platform
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Total Numbers" value={totalNumbers} icon={Phone} />
        <StatCard
          title="Active"
          value={activeCount}
          subtitle={`of ${totalNumbers}`}
          icon={Activity}
        />
        <StatCard
          title="AI Enabled"
          value={aiEnabledCount}
          subtitle={`of ${totalNumbers}`}
          icon={Bot}
        />
      </div>

      {/* Supplementary data warnings */}
      {supplementaryWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            Some supplementary data could not be loaded:
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-700 dark:text-amber-400">
            {supplementaryWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Phone Numbers Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Phone Numbers</CardTitle>
          <CardDescription>
            {totalNumbers} phone number{totalNumbers !== 1 ? "s" : ""} across all
            organizations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {numbersError ? (
            <p className="text-sm text-destructive">
              Failed to load phone numbers: {numbersError.message}
            </p>
          ) : numbers.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Phone className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No phone numbers provisioned yet.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Assistant</TableHead>
                  <TableHead>AI Enabled</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Source Type</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {numbers.map((num) => (
                  <TableRow key={num.id}>
                    <TableCell className="font-medium font-mono">
                      {num.phone_number}
                    </TableCell>
                    <TableCell>
                      {orgNameMap[num.organization_id] || "Unknown"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {num.assistant_id
                        ? assistantNameMap[num.assistant_id] || "Unknown"
                        : "-"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={num.ai_enabled ? "success" : "secondary"}
                      >
                        {num.ai_enabled ? "Yes" : "No"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={num.is_active ? "success" : "secondary"}
                      >
                        {num.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {num.source_type || "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAdminDateShort(num.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
