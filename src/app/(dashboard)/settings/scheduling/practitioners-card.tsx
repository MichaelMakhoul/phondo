"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/use-toast";
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  X,
  Check,
  Users,
  Lock,
} from "lucide-react";
import Link from "next/link";

interface ServiceType {
  id: string;
  name: string;
  durationMinutes: number | null;
}

interface Practitioner {
  id: string;
  name: string;
  title: string | null;
  isActive: boolean;
  services: ServiceType[];
}

interface PractitionersCardProps {
  initialPractitioners: Practitioner[];
  serviceTypes: { id: string; name: string; duration_minutes: number }[];
  hasPractitionersAccess: boolean;
}

export function PractitionersCard({
  initialPractitioners,
  serviceTypes,
  hasPractitionersAccess,
}: PractitionersCardProps) {
  const [practitioners, setPractitioners] = useState<Practitioner[]>(initialPractitioners);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Practitioner | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newServiceIds, setNewServiceIds] = useState<string[]>([]);

  // Edit form state
  const [editName, setEditName] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editServiceIds, setEditServiceIds] = useState<string[]>([]);

  const { toast } = useToast();

  // If no access, show locked card
  if (!hasPractitionersAccess) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Staff Management</CardTitle>
          </div>
          <CardDescription>
            Upgrade to Professional to manage multiple practitioners and enable
            round-robin scheduling.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/billing">
            <Button variant="outline" size="sm">
              Upgrade Plan
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const resetAddForm = () => {
    setNewName("");
    setNewTitle("");
    setNewServiceIds([]);
    setIsAdding(false);
  };

  const startEditing = (p: Practitioner) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditTitle(p.title || "");
    setEditServiceIds(p.services.map((s) => s.id));
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditName("");
    setEditTitle("");
    setEditServiceIds([]);
  };

  const toggleService = (
    serviceId: string,
    current: string[],
    setter: (ids: string[]) => void
  ) => {
    if (current.includes(serviceId)) {
      setter(current.filter((id) => id !== serviceId));
    } else {
      setter([...current, serviceId]);
    }
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/v1/practitioners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          title: newTitle.trim() || undefined,
          serviceIds: newServiceIds.length > 0 ? newServiceIds : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create practitioner");
      }
      const created = await res.json();
      setPractitioners((prev) => [...prev, created]);
      resetAddForm();
      toast({ title: "Staff member added" });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add staff member",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/v1/practitioners/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          title: editTitle.trim() || undefined,
          serviceIds: editServiceIds,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update practitioner");
      }
      const updated = await res.json();
      setPractitioners((prev) => prev.map((p) => (p.id === id ? updated : p)));
      cancelEditing();
      toast({ title: "Staff member updated" });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update staff member",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/v1/practitioners/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to remove staff member");
      }
      setPractitioners((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast({ title: "Staff member removed" });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to remove staff member",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const ServiceCheckboxes = ({
    selected,
    onToggle,
  }: {
    selected: string[];
    onToggle: (id: string) => void;
  }) => (
    <div className="flex flex-wrap gap-2 mt-2">
      {serviceTypes.map((st) => (
        <label
          key={st.id}
          className="flex items-center gap-1.5 text-xs cursor-pointer"
        >
          <Checkbox
            checked={selected.includes(st.id)}
            onCheckedChange={() => onToggle(st.id)}
          />
          {st.name}
        </label>
      ))}
    </div>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              <CardTitle>Staff Members</CardTitle>
            </div>
            {practitioners.length > 0 && !isAdding && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsAdding(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add Staff Member
              </Button>
            )}
          </div>
          <CardDescription>
            Manage your team members. Assign them to services for automatic
            round-robin scheduling.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Empty state */}
          {practitioners.length === 0 && !isAdding && (
            <div className="text-center py-8 space-y-3">
              <Users className="h-10 w-10 mx-auto text-muted-foreground/50" />
              <div>
                <p className="text-sm text-muted-foreground">
                  Add your first team member to enable round-robin scheduling.
                </p>
              </div>
              <Button size="sm" onClick={() => setIsAdding(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Staff Member
              </Button>
            </div>
          )}

          {/* Practitioner list */}
          {practitioners.map((p) =>
            editingId === p.id ? (
              /* Inline edit form */
              <div
                key={p.id}
                className="p-3 border rounded-lg bg-muted/30 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Name"
                    className="flex-1"
                  />
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title (optional)"
                    className="flex-1 hidden sm:block"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleEdit(p.id)}
                    disabled={isSaving || !editName.trim()}
                    aria-label="Save changes"
                  >
                    {isSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={cancelEditing} aria-label="Cancel">
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                {serviceTypes.length > 0 && (
                  <ServiceCheckboxes
                    selected={editServiceIds}
                    onToggle={(id) =>
                      toggleService(id, editServiceIds, setEditServiceIds)
                    }
                  />
                )}
              </div>
            ) : (
              /* Display row */
              <div
                key={p.id}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {p.name}
                      {p.title && (
                        <span className="text-muted-foreground font-normal ml-1">
                          - {p.title}
                        </span>
                      )}
                    </p>
                    {p.services.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {p.services.map((s) => (
                          <Badge key={s.id} variant="secondary" className="text-xs">
                            {s.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => startEditing(p)}
                    aria-label={`Edit ${p.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(p)}
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          )}

          {/* Inline add form */}
          {isAdding && (
            <div className="p-3 border rounded-lg border-dashed bg-muted/30 space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name"
                  className="flex-1"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim()) handleAdd();
                    if (e.key === "Escape") resetAddForm();
                  }}
                />
                <Input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Title (optional)"
                  className="flex-1 hidden sm:block"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleAdd}
                  disabled={isSaving || !newName.trim()}
                  aria-label="Add staff member"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </Button>
                <Button size="icon" variant="ghost" onClick={resetAddForm} aria-label="Cancel">
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {serviceTypes.length > 0 && (
                <ServiceCheckboxes
                  selected={newServiceIds}
                  onToggle={(id) =>
                    toggleService(id, newServiceIds, setNewServiceIds)
                  }
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove staff member?</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove &ldquo;{deleteTarget?.name}
              &rdquo;? Their appointment history will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
