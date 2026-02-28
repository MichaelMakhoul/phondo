"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { CheckCircle2, XCircle, Loader2, Phone } from "lucide-react";

interface CallbackActionsProps {
  callbackId: string;
  callerPhone?: string;
}

export function CallbackActions({ callbackId, callerPhone }: CallbackActionsProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState("");
  const router = useRouter();
  const { toast } = useToast();

  const updateStatus = async (status: "completed" | "cancelled", completionNotes?: string) => {
    setLoading(status);
    try {
      const body: Record<string, string> = { status };
      if (status === "completed" && completionNotes?.trim()) {
        body.notes = completionNotes.trim();
      }

      const res = await fetch(`/api/v1/callbacks/${callbackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update callback");
      }

      toast({
        title: status === "completed" ? "Callback completed" : "Callback cancelled",
        description: status === "completed"
          ? "The callback has been marked as completed."
          : "The callback has been cancelled.",
      });

      setShowNotes(false);
      setNotes("");
      router.refresh();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update callback status.",
      });
    } finally {
      setLoading(null);
    }
  };

  if (showNotes) {
    return (
      <div className="flex flex-col gap-2 min-w-[200px]">
        <Textarea
          placeholder="Add notes (optional)..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="text-sm resize-none"
          disabled={loading !== null}
        />
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowNotes(false);
              setNotes("");
            }}
            disabled={loading !== null}
            className="text-muted-foreground"
          >
            Back
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateStatus("completed", notes)}
            disabled={loading !== null}
            className="text-green-600 hover:text-green-700 hover:bg-green-50"
          >
            {loading === "completed" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            <span className="ml-1">Confirm</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end gap-1">
      {callerPhone && (
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="text-primary hover:text-primary hover:bg-primary/10"
        >
          <a href={`tel:${callerPhone}`}>
            <Phone className="h-4 w-4" />
            <span className="ml-1">Call</span>
          </a>
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowNotes(true)}
        disabled={loading !== null}
        className="text-green-600 hover:text-green-700 hover:bg-green-50"
      >
        {loading === "completed" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="h-4 w-4" />
        )}
        <span className="ml-1">Done</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => updateStatus("cancelled")}
        disabled={loading !== null}
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
      >
        {loading === "cancelled" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <XCircle className="h-4 w-4" />
        )}
        <span className="ml-1">Cancel</span>
      </Button>
    </div>
  );
}
