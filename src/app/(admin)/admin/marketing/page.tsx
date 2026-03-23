import { createAdminClient } from "@/lib/supabase/admin";
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
import { Badge } from "@/components/ui/badge";
import { Megaphone, Users } from "lucide-react";
import Link from "next/link";
import { ContactsSection } from "./contacts-section";

interface CampaignRow {
  id: string;
  name: string;
  subject: string;
  status: string;
  sent_count: number;
  sent_at: string | null;
  created_at: string;
}

function getCampaignStatusVariant(status: string) {
  switch (status) {
    case "sent":
      return "success" as const;
    case "draft":
      return "secondary" as const;
    case "sending":
      return "warning" as const;
    case "failed":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

export default async function AdminMarketingPage() {
  const supabase = createAdminClient();

  const [contactsResult, campaignsResult] = await Promise.all([
    (supabase as any)
      .from("admin_contacts")
      .select("id, name, email, company, industry, tags, source, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    (supabase as any)
      .from("admin_email_campaigns")
      .select("id, name, subject, status, sent_count, sent_at, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const contacts = contactsResult.data ?? [];
  const campaigns: CampaignRow[] = campaignsResult.data ?? [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Marketing &amp; Contacts
        </h1>
        <p className="text-muted-foreground">
          Manage contacts and email campaigns
        </p>
      </div>

      {/* Contacts Section */}
      <ContactsSection initialContacts={contacts} />

      {/* Campaigns Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Megaphone className="h-5 w-5 text-amber-600" />
                Campaigns
              </CardTitle>
              <CardDescription>Email campaigns</CardDescription>
            </div>
            <Link
              href="/admin/marketing/campaigns/new"
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
            >
              New Campaign
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <Megaphone className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-muted-foreground">
                No campaigns yet.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent Count</TableHead>
                  <TableHead>Sent At</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((campaign) => (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">
                      {campaign.name}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">
                      {campaign.subject}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={getCampaignStatusVariant(campaign.status)}
                      >
                        {campaign.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{campaign.sent_count}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {campaign.sent_at
                        ? new Date(campaign.sent_at).toLocaleString()
                        : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(campaign.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
