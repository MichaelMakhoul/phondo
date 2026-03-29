import { Search } from "lucide-react";
import { LeadDiscoveryPanel } from "./lead-discovery-panel";

export default function LeadDiscoveryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <Search className="h-8 w-8 text-amber-600" />
          Business Discovery &amp; Lead Qualification
        </h1>
        <p className="text-muted-foreground mt-1">
          Find businesses by area and profession, detect what CRM they use, and
          export qualified leads for outreach.
        </p>
      </div>
      <LeadDiscoveryPanel />
    </div>
  );
}
