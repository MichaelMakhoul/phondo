import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Users } from "lucide-react";
import { TeamActions } from "./team-actions";
import { EmptyState } from "@/components/ui/empty-state";
import { TeamScene } from "@/components/ui/empty-state-scenes";

interface Membership {
  organization_id: string;
  role: string;
}

interface TeamMember {
  id: string;
  role: string;
  created_at: string;
  user_profiles: {
    id: string;
    email: string;
    full_name: string | null;
    avatar_url: string | null;
  };
}

export default async function TeamPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: membership } = await supabase
    .from("org_members")
    .select("organization_id, role")
    .eq("user_id", user!.id)
    .single() as { data: Membership | null };

  // Get all team members
  const { data: members } = membership?.organization_id ? await supabase
    .from("org_members")
    .select(`
      id,
      role,
      created_at,
      user_profiles (id, email, full_name, avatar_url)
    `)
    .eq("organization_id", membership.organization_id) as { data: TeamMember[] | null } : { data: null };

  const isOwner = membership?.role === "owner";
  const isAdmin = isOwner || membership?.role === "admin";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team</h1>
          <p className="text-muted-foreground">
            Manage your team members and their access
          </p>
        </div>
        {isAdmin && membership?.organization_id && (
          <TeamActions
            organizationId={membership.organization_id}
            members={(members || []).map((m) => ({
              id: m.id,
              role: m.role,
              userId: (m.user_profiles as any).id,
              email: (m.user_profiles as any).email,
              fullName: (m.user_profiles as any).full_name,
            }))}
          />
        )}
      </div>

      {/* Team Members */}
      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
          <CardDescription>
            People with access to this organization
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members && members.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  {isOwner && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => {
                  const profile = member.user_profiles as {
                    id: string;
                    email: string;
                    full_name: string | null;
                    avatar_url: string | null;
                  };
                  const initials = profile.full_name
                    ? profile.full_name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .toUpperCase()
                        .slice(0, 2)
                    : profile.email[0].toUpperCase();

                  return (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={profile.avatar_url || undefined} />
                            <AvatarFallback>{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">
                              {profile.full_name || profile.email}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {profile.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            member.role === "owner"
                              ? "default"
                              : member.role === "admin"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {member.role}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {new Date(member.created_at).toLocaleDateString()}
                      </TableCell>
                      {isOwner && (
                        <TableCell className="text-right">
                          {member.role !== "owner" && profile.id !== user!.id && (
                            <TeamActions
                              organizationId={membership!.organization_id}
                              memberId={member.id}
                              memberName={profile.full_name || profile.email}
                              showRemoveOnly
                              members={[]}
                            />
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={Users}
              title="No team members yet"
              description="Invite team members to help manage your AI receptionist"
              illustration={<TeamScene />}
              compact
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
