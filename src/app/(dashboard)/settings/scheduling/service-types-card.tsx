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
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { Plus, Pencil, Trash2, Loader2, X, Check, CalendarClock } from "lucide-react";

interface ServiceType {
  id: string;
  name: string;
  duration_minutes: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

interface ServiceTypesCardProps {
  initialServiceTypes: ServiceType[];
}

const DURATION_OPTIONS = [10, 15, 20, 30, 45, 60, 90, 120];

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export function ServiceTypesCard({ initialServiceTypes }: ServiceTypesCardProps) {
  const [serviceTypes, setServiceTypes] = useState<ServiceType[]>(initialServiceTypes);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServiceType | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newDuration, setNewDuration] = useState("30");
  const [newDescription, setNewDescription] = useState("");

  // Edit form state
  const [editName, setEditName] = useState("");
  const [editDuration, setEditDuration] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const { toast } = useToast();

  const resetAddForm = () => {
    setNewName("");
    setNewDuration("30");
    setNewDescription("");
    setIsAdding(false);
  };

  const startEditing = (st: ServiceType) => {
    setEditingId(st.id);
    setEditName(st.name);
    setEditDuration(st.duration_minutes.toString());
    setEditDescription(st.description || "");
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditName("");
    setEditDuration("");
    setEditDescription("");
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/v1/service-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          durationMinutes: parseInt(newDuration),
          description: newDescription.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create service type");
      }
      const created = await res.json();
      setServiceTypes((prev) => [...prev, created]);
      resetAddForm();
      toast({ title: "Service type added" });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to add service type",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/v1/service-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          durationMinutes: parseInt(editDuration),
          description: editDescription.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update service type");
      }
      const updated = await res.json();
      setServiceTypes((prev) => prev.map((st) => (st.id === id ? updated : st)));
      cancelEditing();
      toast({ title: "Service type updated" });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update service type",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/v1/service-types/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete service type");
      }
      setServiceTypes((prev) => prev.filter((st) => st.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast({ title: "Service type deleted" });
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to delete service type",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              <CardTitle>Appointment Types</CardTitle>
            </div>
            {serviceTypes.length > 0 && !isAdding && (
              <Button size="sm" variant="outline" onClick={() => setIsAdding(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Service Type
              </Button>
            )}
          </div>
          <CardDescription>
            Define the types of appointments your AI can book. Each type has a name and
            default duration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Empty state */}
          {serviceTypes.length === 0 && !isAdding && (
            <div className="text-center py-8 space-y-3">
              <CalendarClock className="h-10 w-10 mx-auto text-muted-foreground/50" />
              <div>
                <p className="text-sm text-muted-foreground">
                  No appointment types configured. Add your first service to enable smart booking.
                </p>
              </div>
              <Button size="sm" onClick={() => setIsAdding(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Service Type
              </Button>
            </div>
          )}

          {/* Service type list */}
          {serviceTypes.map((st) =>
            editingId === st.id ? (
              /* Inline edit row */
              <div key={st.id} className="flex items-center gap-2 p-3 border rounded-lg bg-muted/30">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Service name"
                  className="flex-1"
                />
                <Select value={editDuration} onValueChange={setEditDuration}>
                  <SelectTrigger className="w-[120px]" aria-label="Duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_OPTIONS.map((d) => (
                      <SelectItem key={d} value={d.toString()}>
                        {formatDuration(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Description (optional)"
                  className="flex-1 hidden sm:block"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => handleEdit(st.id)}
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
            ) : (
              /* Display row */
              <div
                key={st.id}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{st.name}</p>
                    {st.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {st.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="secondary">{formatDuration(st.duration_minutes)}</Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => startEditing(st)}
                    aria-label={`Edit ${st.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => setDeleteTarget(st)}
                    aria-label={`Delete ${st.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          )}

          {/* Inline add form */}
          {isAdding && (
            <div className="flex items-center gap-2 p-3 border rounded-lg border-dashed bg-muted/30">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Service name"
                className="flex-1"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) handleAdd();
                  if (e.key === "Escape") resetAddForm();
                }}
              />
              <Select value={newDuration} onValueChange={setNewDuration}>
                <SelectTrigger className="w-[120px]" aria-label="Duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d.toString()}>
                      {formatDuration(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional)"
                className="flex-1 hidden sm:block"
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={handleAdd}
                disabled={isSaving || !newName.trim()}
                aria-label="Add service type"
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
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete service type?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
