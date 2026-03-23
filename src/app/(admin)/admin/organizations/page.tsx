import { createAdminClient } from "@/lib/supabase/admin";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2 } from "lucide-react";

interface OrgRow {
  id: string;
  name: string;
  industry: string | null;
  country: string;
  created_at: string;
  subscriptions:
    | { plan_type: string; status: string; calls_used: number | null; calls_limit: number | null }
    | { plan_type: string; status: string; calls_used: number | null; calls_limit: number | null }[]
    | null;
}

export default async function AdminOrganizationsPage() {
  const supabase = createAdminClient();

  const { data: orgs } = await (supabase as any)
    .from("organizations")
    .select(`
      id, name, industry, country, created_at,
      subscriptions(plan_type, status, calls_used, calls_limit)
    `)
    .order("created_at", { ascending: false });

  const organizations: OrgRow[] = orgs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
        <p className="text-muted-foreground">
          All registered organizations on the platform
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Building2 className="h-5 w-5 text-amber-600" />
            {organizations.length} Organizations
          </CardTitle>
          <CardDescription>Click an organization name to view details</CardDescription>
        </CardHeader>
        <CardContent>
          {organizations.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Building2 className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No organizations yet
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.map((org) => {
                  const sub = Array.isArray(org.subscriptions)
                    ? org.subscriptions[0]
                    : org.subscriptions;
                  return (
                    <TableRow key={org.id}>
                      <TableCell>
                        <Link
                          href={`/admin/organizations/${org.id}`}
                          className="text-primary hover:underline font-medium"
                        >
                          {org.name}
                        </Link>
                      </TableCell>
                      <TableCell className="capitalize">
                        {org.industry || <span className="text-muted-foreground">--</span>}
                      </TableCell>
                      <TableCell>{org.country}</TableCell>
                      <TableCell className="capitalize">{sub?.plan_type || "none"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            sub?.status === "active"
                              ? "success"
                              : sub?.status === "trialing"
                                ? "warning"
                                : sub?.status === "past_due"
                                  ? "destructive"
                                  : "secondary"
                          }
                        >
                          {sub?.status || "none"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {sub?.calls_used ?? 0} / {sub?.calls_limit ?? "--"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(org.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
