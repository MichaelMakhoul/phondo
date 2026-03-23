import { createAdminClient } from "@/lib/supabase/admin";
import { Badge } from "@/components/ui/badge";
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
import { Users } from "lucide-react";

interface UserProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
}

interface OrgMemberRow {
  user_id: string;
  organization_id: string;
  role: string;
}

interface OrgNameRow {
  id: string;
  name: string;
}

export default async function AdminUsersPage() {
  const supabase = createAdminClient();

  const [profilesResult, membersResult] = await Promise.all([
    (supabase as any)
      .from("user_profiles")
      .select("id, email, full_name, created_at")
      .order("created_at", { ascending: false }),
    (supabase as any)
      .from("org_members")
      .select("user_id, organization_id, role"),
  ]);

  const profiles: UserProfileRow[] = profilesResult.data ?? [];
  const members: OrgMemberRow[] = membersResult.data ?? [];

  // Fetch org names for all unique org IDs
  const orgIds = [...new Set(members.map((m) => m.organization_id))];
  let orgNameMap: Record<string, string> = {};
  if (orgIds.length > 0) {
    const { data: orgs } = await (supabase as any)
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    if (orgs) {
      orgNameMap = Object.fromEntries(
        (orgs as OrgNameRow[]).map((o) => [o.id, o.name])
      );
    }
  }

  // Build a map: user_id -> { orgName, role }[]
  const userMembershipMap: Record<string, { orgName: string; role: string }[]> = {};
  for (const m of members) {
    if (!userMembershipMap[m.user_id]) {
      userMembershipMap[m.user_id] = [];
    }
    userMembershipMap[m.user_id].push({
      orgName: orgNameMap[m.organization_id] || "Unknown",
      role: m.role,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Users</h1>
        <p className="text-muted-foreground">
          All registered users across the platform
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Users className="h-5 w-5 text-amber-600" />
            {profiles.length} Users
          </CardTitle>
          <CardDescription>User accounts with their organization memberships</CardDescription>
        </CardHeader>
        <CardContent>
          {profiles.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Users className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No users yet
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((user) => {
                  const memberships = userMembershipMap[user.id] || [];
                  return (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">{user.email}</TableCell>
                      <TableCell>
                        {user.full_name || <span className="text-muted-foreground">--</span>}
                      </TableCell>
                      <TableCell>
                        {memberships.length === 0 ? (
                          <span className="text-muted-foreground">No org</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {memberships.map((m, i) => (
                              <span key={i} className="text-sm">{m.orgName}</span>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {memberships.length === 0 ? (
                          <span className="text-muted-foreground">--</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {memberships.map((m, i) => (
                              <Badge key={i} variant={m.role === "owner" ? "default" : "secondary"}>
                                {m.role}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(user.created_at).toLocaleDateString()}
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
