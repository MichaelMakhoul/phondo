"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Plus } from "lucide-react";
import { trackTeamMemberInvited, trackTeamMemberRemoved } from "@/lib/analytics";

interface TeamActionsProps {
  organizationId: string;
  members: Array<{
    id: string;
    role: string;
    userId: string;
    email: string;
    fullName: string | null;
  }>;
  memberId?: string;
  memberName?: string;
  showRemoveOnly?: boolean;
}

export function TeamActions({
  organizationId,
  members,
  memberId,
  memberName,
  showRemoveOnly,
}: TeamActionsProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleInvite() {
    if (!email.trim()) return;
    setLoading(true);
    try {
      // Check if user already exists
      const existingMember = members.find(
        (m) => m.email.toLowerCase() === email.trim().toLowerCase()
      );
      if (existingMember) {
        toast({
          title: "Already a member",
          description: "This person is already part of your team.",
          variant: "destructive",
        });
        return;
      }

      // Look up user by email in user_profiles (subject to RLS)
      const supabase = createClient();
      const { data: profile, error: lookupError } = await (supabase as any)
        .from("user_profiles")
        .select("id")
        .eq("email", email.trim().toLowerCase())
        .single();

      if (lookupError && lookupError.code !== "PGRST116") {
        console.error("[TeamActions] Profile lookup failed:", lookupError);
        throw lookupError;
      }

      if (!profile) {
        toast({
          title: "User not found",
          description: "This email is not registered. They need to sign up first.",
          variant: "destructive",
        });
        return;
      }

      // Add to organization
      const { error } = await (supabase as any)
        .from("org_members")
        .insert({
          organization_id: organizationId,
          user_id: profile.id,
          role,
        });

      if (error) {
        if (error.code === "23505") {
          toast({
            title: "Already a member",
            description: "This person is already part of your team.",
            variant: "destructive",
          });
        } else {
          throw error;
        }
      } else {
        trackTeamMemberInvited();
        toast({ title: "Member added", description: `${email} has been added to your team.` });
        setEmail("");
        setRole("member");
        setInviteOpen(false);
        router.refresh();
      }
    } catch (error) {
      console.error("[TeamActions] Failed to invite team member:", error);
      toast({
        title: "Error",
        description: "Failed to add team member. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove() {
    if (!memberId) return;
    setRemoving(true);
    try {
      const supabase = createClient();
      const { data, error } = await (supabase as any)
        .from("org_members")
        .delete()
        .eq("id", memberId)
        .select();

      if (error) throw error;

      if (!data || data.length === 0) {
        toast({ title: "Already removed", description: "This member was already removed from your team." });
      } else {
        trackTeamMemberRemoved();
        toast({ title: "Member removed", description: `${memberName} has been removed from your team.` });
      }
      router.refresh();
    } catch (error) {
      console.error("[TeamActions] Failed to remove member:", memberId, error);
      toast({
        title: "Error",
        description: "Failed to remove team member.",
        variant: "destructive",
      });
    } finally {
      setRemoving(false);
    }
  }

  if (showRemoveOnly) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleRemove}
        disabled={removing}
      >
        {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
      </Button>
    );
  }

  return (
    <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Invite Member
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>
            Add a team member by their email address. They must have an existing account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin — Full access</SelectItem>
                <SelectItem value="member">Member — View and manage calls</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setInviteOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleInvite} disabled={loading || !email.trim()}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add Member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
