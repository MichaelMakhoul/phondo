"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChevronDown, Link2 } from "lucide-react";
import { CalendarSettings } from "./calendar-settings";

interface CalendarIntegration {
  id: string;
  calendar_id: string | null;
  booking_url: string | null;
  assistant_id: string | null;
  is_active: boolean;
  settings: Record<string, any>;
}

interface Assistant {
  id: string;
  name: string;
}

interface CalendarIntegrationCollapsibleProps {
  organizationId: string;
  initialIntegration: CalendarIntegration | null;
  assistants: Assistant[];
}

export function CalendarIntegrationCollapsible({
  organizationId,
  initialIntegration,
  assistants,
}: CalendarIntegrationCollapsibleProps) {
  return (
    <Collapsible>
      <Card>
        <CollapsibleTrigger className="w-full text-left">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Link2 className="h-5 w-5 text-muted-foreground" />
                <CardTitle>Calendar Integrations (Advanced)</CardTitle>
              </div>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
            </div>
            <CardDescription className="text-left">
              Optionally connect an external calendar for two-way sync.
            </CardDescription>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-6 pb-6">
            <CalendarSettings
              organizationId={organizationId}
              initialIntegration={initialIntegration}
              assistants={assistants}
            />
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
