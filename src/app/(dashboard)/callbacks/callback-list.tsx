"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface CallbackActionsProps {
  callbackId: string;
}

export function CallbackActions({ callbackId }: CallbackActionsProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();

  const updateStatus = async (status: "completed" | "cancelled") => {
    setLoading(status);
    try {
      const res = await fetch(`/api/v1/callbacks/${callbackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
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

  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => updateStatus("completed")}
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
