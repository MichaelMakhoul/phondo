export interface PlatformGuide {
  platformId: string;
  name: string;
  steps: string[];
  description: string;
  payloadNote?: string;
}

export interface IndustryRecommendation {
  industry: string;
  label: string;
  tools: string[];
  tip: string;
}

export const INTEGRATION_GUIDES: PlatformGuide[] = [
  {
    platformId: "zapier",
    name: "Zapier",
    description:
      "Zapier connects Phondo to 5,000+ apps like Google Sheets, HubSpot, Slack, and more — no coding required.",
    steps: [
      'Go to zapier.com and create a new Zap.',
      'For the Trigger, choose "Webhooks by Zapier".',
      'Select "Catch Hook" as the trigger event.',
      "Zapier will give you a unique webhook URL — copy it.",
      'Come back here, click "Add Integration", paste the URL, and save.',
      'Click "Test" on your integration to send a sample payload to Zapier.',
      "Back in Zapier, click \"Test trigger\" to see the sample data.",
      'Now add your Action (e.g., "Create Spreadsheet Row in Google Sheets").',
      "Map the fields from the webhook data to your action fields.",
      "Turn on your Zap — you're all set!",
    ],
  },
  {
    platformId: "make",
    name: "Make (Integromat)",
    description:
      "Make is a powerful automation platform for building complex workflows with branching logic and multiple steps.",
    steps: [
      "Go to make.com and create a new Scenario.",
      'Add a "Webhooks" module and choose "Custom webhook".',
      'Click "Add" to create a new webhook — Make will generate a URL.',
      "Copy the webhook URL.",
      'Come back here, click "Add Integration", paste the URL, and save.',
      'Click "Test" to send a sample payload.',
      'In Make, click "Re-determine data structure" to parse the payload.',
      "Add your next module (e.g., Google Sheets, CRM, email).",
      "Map the incoming data fields to your destination.",
      "Save and activate your Scenario.",
    ],
  },
  {
    platformId: "google_sheets",
    name: "Google Sheets",
    description:
      "Log every call automatically to a Google Sheet. Set this up through Zapier or Make for a no-code solution.",
    steps: [
      "First, set up a Zapier or Make account (see those guides above).",
      'Create a Google Sheet with columns: Date, Caller Phone, Caller Name, Summary, Duration, Outcome.',
      "In Zapier: Trigger = Webhooks by Zapier (Catch Hook), Action = Google Sheets (Create Spreadsheet Row).",
      "In Make: Trigger = Webhooks (Custom Webhook), Action = Google Sheets (Add a Row).",
      "Map the webhook fields to your spreadsheet columns.",
      "Test to verify a row appears in your sheet.",
    ],
  },
  {
    platformId: "webhook",
    name: "Custom Webhook",
    description:
      "For developers: send raw JSON call data to any URL. Includes HMAC-SHA256 signature verification.",
    steps: [
      'Click "Add Integration" and enter your server\'s endpoint URL.',
      "A signing secret will be auto-generated — use it to verify payloads.",
      'Each delivery includes an "X-Phondo-Signature" header (HMAC-SHA256 of the body).',
      "Verify the signature server-side to ensure the payload is authentic.",
      'Click "Test" to send a sample payload and verify your endpoint responds with 2xx.',
    ],
    payloadNote: `Example payload:
{
  "event": "call.completed",
  "timestamp": "2025-01-15T10:30:00Z",
  "data": {
    "call_id": "uuid",
    "caller_phone": "+61400000000",
    "caller_name": "John Smith",
    "summary": "Called to book a dental cleaning",
    "transcript": "...",
    "duration_seconds": 145,
    "assistant_name": "Dental Reception",
    "outcome": "completed",
    "recording_url": "https://...",
    "collected_data": { "service": "cleaning", "preferred_date": "next Monday" }
  }
}

Signature verification (Node.js):
const crypto = require('crypto');
const signature = req.headers['x-phondo-signature'];
const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(rawBody).digest('hex');
if (signature !== expected) throw new Error('Invalid signature');`,
  },
];

export const INDUSTRY_RECOMMENDATIONS: IndustryRecommendation[] = [
  {
    industry: "dental",
    label: "Dental Practice",
    tools: ["Cliniko", "Dentally", "Open Dental", "Google Sheets"],
    tip: "Most dental offices use Cliniko or Dentally for patient management. Connect via Zapier to automatically log new patient inquiries.",
  },
  {
    industry: "medical",
    label: "Medical Practice",
    tools: ["Cliniko", "Jane App", "Halaxy", "Practice Better"],
    tip: "Send call data to your practice management software to pre-fill patient intake forms.",
  },
  {
    industry: "legal",
    label: "Law Firm",
    tools: ["Clio", "LEAP", "Smokeball", "HubSpot"],
    tip: "Route new client inquiries to your case management system automatically. Use Zapier to create matters in Clio.",
  },
  {
    industry: "home_services",
    label: "Home Services",
    tools: ["ServiceM8", "Jobber", "Tradify", "Google Sheets"],
    tip: "ServiceM8 is the most popular choice for Aussie tradies. Connect via Zapier to turn calls into jobs.",
  },
  {
    industry: "real_estate",
    label: "Real Estate",
    tools: ["HubSpot", "Salesforce", "Rex", "Google Sheets"],
    tip: "Send caller details to your CRM so agents can follow up on property inquiries promptly.",
  },
  {
    industry: "salon",
    label: "Salon / Spa",
    tools: ["Fresha", "Timely", "Square Appointments", "Google Sheets"],
    tip: "Log booking requests from calls into your scheduling tool for easy follow-up.",
  },
  {
    industry: "automotive",
    label: "Automotive",
    tools: ["Workshop Software", "Tekmetric", "Google Sheets"],
    tip: "Send service inquiries to your workshop management software for quoting.",
  },
  {
    industry: "veterinary",
    label: "Veterinary Clinic",
    tools: ["ezyVet", "Provet Cloud", "Google Sheets"],
    tip: "Automatically log pet owner inquiries so your team can prepare for appointments.",
  },
  {
    industry: "restaurant",
    label: "Restaurant",
    tools: ["OpenTable", "Google Sheets", "Slack"],
    tip: "Send reservation requests to a Slack channel or Google Sheet for your host team.",
  },
  {
    industry: "other",
    label: "General Business",
    tools: ["HubSpot", "Google Sheets", "Slack", "Zapier"],
    tip: "Google Sheets is the easiest way to start — log every call automatically with no setup cost.",
  },
];

export const DISCOVERY_TIPS = [
  "Check your browser bookmarks and recently visited sites for business tools you already use.",
  "Look at your phone — what business apps do you have installed?",
  "Check your email for receipts or subscription confirmations from software providers.",
  "Ask your team: \"What tools do we use to manage customers or bookings?\"",
];

export function getRecommendedPlatforms(industry: string | null): IndustryRecommendation {
  const match = INDUSTRY_RECOMMENDATIONS.find((r) => r.industry === industry);
  return match || INDUSTRY_RECOMMENDATIONS[INDUSTRY_RECOMMENDATIONS.length - 1];
}
