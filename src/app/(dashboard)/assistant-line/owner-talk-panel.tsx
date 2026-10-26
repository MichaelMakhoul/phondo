"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { useOwnerAssistant } from "@/components/owner-assistant/owner-assistant-provider";
import { isSessionLive } from "@/components/owner-assistant/bubble-state";
import {
  OwnerAssistantControls,
  OwnerAssistantError,
  OwnerAssistantTranscript,
} from "@/components/owner-assistant/owner-assistant-session-ui";

const EXAMPLE_ASKS = ["What's on today?", "Any messages for me?", "Move the 2pm to Thursday."];

interface OwnerTalkPanelProps {
  /** The org's first active assistant (its voice), or null when there is none. */
  assistantId: string | null;
  /** The assistants read failed: an error, not the "set one up" state. */
  loadFailed?: boolean;
}

/**
 * SCRUM-596: talk to the owner assistant in the browser. It is the phone line's
 * assistant, with the dashboard login instead of the PIN.
 */
export function OwnerTalkPanel({ assistantId, loadFailed = false }: OwnerTalkPanelProps) {
  // SCRUM-597: a session that's live (started from the bubble, which hides on this
  // page) always shows with its End button — whatever this page's own read found.
  const shared = useOwnerAssistant();
  if (isSessionLive(shared?.session.status)) {
    return (
      <PageShell>
        <OwnerTalk />
      </PageShell>
    );
  }
  if (loadFailed) {
    return (
      <PageShell>
        <LoadFailedAlert />
      </PageShell>
    );
  }
  if (!assistantId) {
    return (
      <PageShell>
        <Card className="space-y-3 p-6 text-center">
          <p className="font-medium">Your assistant needs an active AI receptionist</p>
          <p className="text-sm text-muted-foreground">
            It talks in your receptionist&apos;s voice. Set one up, or switch yours back on, in Assistants.
          </p>
          <Button asChild>
            <Link href="/assistants">Go to Assistants</Link>
          </Button>
        </Card>
      </PageShell>
    );
  }
  return (
    <PageShell>
      <OwnerTalk />
    </PageShell>
  );
}

/**
 * SCRUM-597: the session lives in the dashboard layout's OwnerAssistantProvider,
 * shared with the floating bubble (hidden on this page), so there is never a
 * second session. No provider means the layout couldn't load the assistant.
 */
function OwnerTalk() {
  const assistant = useOwnerAssistant();
  // No provider, or the layout found no assistant this render: nothing can start — but a live session stays on screen.
  if (!assistant || (!assistant.assistantId && !isSessionLive(assistant.session.status))) return <LoadFailedAlert />;

  const { session } = assistant;
  const { transcript, error } = session;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-sm font-medium">Things you can ask</p>
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {EXAMPLE_ASKS.map((ask) => (
            <li key={ask}>&ldquo;{ask}&rdquo;</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Changes are real: it reads every change back, asks whether to let the customer know, and waits for your yes.
          Each session lasts up to 8 minutes.
        </p>
      </div>

      <Card className="p-6">
        <OwnerAssistantControls session={session} />
      </Card>

      {transcript.length > 0 && (
        <Card className="p-4">
          <OwnerAssistantTranscript transcript={transcript} listClassName="max-h-64" />
        </Card>
      )}

      <OwnerAssistantError error={error} />
    </div>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="container max-w-2xl py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Your assistant</h1>
        <p className="text-muted-foreground">
          Ask about your bookings and messages, or move or cancel a job. It&apos;s the same assistant as your phone
          line, without the PIN.
        </p>
      </div>
      {children}
    </div>
  );
}

function LoadFailedAlert() {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>Couldn&apos;t load your assistant. Refresh the page to try again.</AlertDescription>
    </Alert>
  );
}
