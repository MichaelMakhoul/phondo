/**
 * CRM / booking software detection via HTML pattern matching.
 * Zero AI cost — pure regex/string matching against known signatures.
 */

import { isUrlAllowedAsync } from "@/lib/security/validation";

// ── Signature database ───────────────────────────────────────────────

export interface CrmSignature {
  name: string;
  category: "healthcare" | "trades" | "legal" | "real_estate" | "generic";
  /** Patterns matched against the full HTML source */
  htmlPatterns: RegExp[];
  /** Domain substrings matched against src/href attribute values */
  domainPatterns: string[];
}

export const CRM_SIGNATURES: CrmSignature[] = [
  // ── Healthcare ──────────────────────────────────────────────────
  {
    name: "Cliniko",
    category: "healthcare",
    htmlPatterns: [/cliniko\.com/i, /cliniko-online-bookings/i],
    domainPatterns: ["cliniko.com"],
  },
  {
    name: "Nookal",
    category: "healthcare",
    htmlPatterns: [/nookal\.com/i],
    domainPatterns: ["nookal.com"],
  },
  {
    name: "Halaxy",
    category: "healthcare",
    htmlPatterns: [/halaxy\.com/i],
    domainPatterns: ["halaxy.com"],
  },
  {
    name: "Jane App",
    category: "healthcare",
    htmlPatterns: [/janeapp\.com/i, /jane\.app/i],
    domainPatterns: ["janeapp.com", "jane.app"],
  },
  {
    name: "Power Diary",
    category: "healthcare",
    htmlPatterns: [/powerdiary\.com/i, /zandahealth\.com/i],
    domainPatterns: ["powerdiary.com", "zandahealth.com"],
  },
  {
    name: "Timely",
    category: "healthcare",
    htmlPatterns: [/gettimely\.com/i],
    domainPatterns: ["gettimely.com"],
  },
  {
    name: "Fresha",
    category: "healthcare",
    htmlPatterns: [/fresha\.com/i],
    domainPatterns: ["fresha.com"],
  },
  {
    name: "Mindbody",
    category: "healthcare",
    htmlPatterns: [/mindbodyonline\.com/i, /mindbody\.io/i],
    domainPatterns: ["mindbodyonline.com", "mindbody.io"],
  },
  {
    name: "HotDoc",
    category: "healthcare",
    htmlPatterns: [/hotdoc\.com\.au/i],
    domainPatterns: ["hotdoc.com.au"],
  },
  {
    name: "HealthEngine",
    category: "healthcare",
    htmlPatterns: [/healthengine\.com\.au/i],
    domainPatterns: ["healthengine.com.au"],
  },
  {
    name: "ezyVet",
    category: "healthcare",
    htmlPatterns: [/ezyvet\.com/i],
    domainPatterns: ["ezyvet.com"],
  },
  {
    name: "Dental4Windows",
    category: "healthcare",
    htmlPatterns: [/dental4windows/i, /centaursoftware\.com\.au/i, /\bd4w\b/i],
    domainPatterns: ["centaursoftware.com.au"],
  },

  // ── Trades ──────────────────────────────────────────────────────
  {
    name: "ServiceM8",
    category: "trades",
    htmlPatterns: [/servicem8\.com/i],
    domainPatterns: ["servicem8.com"],
  },
  {
    name: "Tradify",
    category: "trades",
    htmlPatterns: [/tradifyhq\.com/i, /tradify\.com/i],
    domainPatterns: ["tradifyhq.com", "tradify.com"],
  },
  {
    name: "Jobber",
    category: "trades",
    htmlPatterns: [/getjobber\.com/i],
    domainPatterns: ["getjobber.com"],
  },
  {
    name: "Fergus",
    category: "trades",
    htmlPatterns: [/fergus\.com/i],
    domainPatterns: ["fergus.com"],
  },
  {
    name: "simPRO",
    category: "trades",
    htmlPatterns: [/simpro\.co/i, /simprogroup\.com/i],
    domainPatterns: ["simpro.co", "simprogroup.com"],
  },
  {
    name: "AroFlo",
    category: "trades",
    htmlPatterns: [/aroflo\.com/i],
    domainPatterns: ["aroflo.com"],
  },

  // ── Legal ───────────────────────────────────────────────────────
  {
    name: "Clio",
    category: "legal",
    htmlPatterns: [/clio\.com/i],
    domainPatterns: ["clio.com"],
  },
  {
    name: "Actionstep",
    category: "legal",
    htmlPatterns: [/actionstep\.com/i],
    domainPatterns: ["actionstep.com"],
  },
  {
    name: "LEAP",
    category: "legal",
    htmlPatterns: [/leap\.com\.au/i, /leaplegalsoftware/i],
    domainPatterns: ["leap.com.au"],
  },
  {
    name: "Smokeball",
    category: "legal",
    htmlPatterns: [/smokeball\.com/i],
    domainPatterns: ["smokeball.com"],
  },

  // ── Real Estate ─────────────────────────────────────────────────
  {
    name: "Rex",
    category: "real_estate",
    htmlPatterns: [/rexsoftware\.com/i, /rex\.au/i],
    domainPatterns: ["rexsoftware.com", "rex.au"],
  },
  {
    name: "Agentbox",
    category: "real_estate",
    htmlPatterns: [/agentbox\.com\.au/i],
    domainPatterns: ["agentbox.com.au"],
  },
  {
    name: "VaultRE",
    category: "real_estate",
    htmlPatterns: [/vaultre\.com\.au/i],
    domainPatterns: ["vaultre.com.au"],
  },
  {
    name: "PropertyMe",
    category: "real_estate",
    htmlPatterns: [/propertyme\.com\.au/i],
    domainPatterns: ["propertyme.com.au"],
  },

  // ── Generic booking / CRM ──────────────────────────────────────
  {
    name: "Calendly",
    category: "generic",
    htmlPatterns: [/calendly\.com/i],
    domainPatterns: ["calendly.com"],
  },
  {
    name: "Acuity Scheduling",
    category: "generic",
    htmlPatterns: [/acuityscheduling\.com/i],
    domainPatterns: ["acuityscheduling.com"],
  },
  {
    name: "Square Appointments",
    category: "generic",
    htmlPatterns: [/squareup\.com\/appointments/i, /square\.site/i],
    domainPatterns: ["squareup.com"],
  },
  {
    name: "HubSpot",
    category: "generic",
    htmlPatterns: [/hs-scripts\.com/i, /hubspot\.com/i, /hbspt\.forms/i],
    domainPatterns: ["hs-scripts.com", "hubspot.com"],
  },
  {
    name: "Salesforce",
    category: "generic",
    htmlPatterns: [/force\.com/i, /salesforce\.com/i],
    domainPatterns: ["force.com", "salesforce.com"],
  },
  {
    name: "Setmore",
    category: "generic",
    htmlPatterns: [/setmore\.com/i],
    domainPatterns: ["setmore.com"],
  },
];

// ── Detection ────────────────────────────────────────────────────────

export interface CrmDetectionResult {
  software: string | null;
  confidence: "high" | "medium" | "low";
  signals: string[];
}

/**
 * Detect CRM / booking software from raw HTML.
 * Returns the first match with the most signals (highest confidence).
 */
export function detectCRM(html: string): CrmDetectionResult {
  const matches: { name: string; signals: string[] }[] = [];

  for (const sig of CRM_SIGNATURES) {
    const signals: string[] = [];

    for (const pattern of sig.htmlPatterns) {
      if (pattern.test(html)) {
        signals.push(`html:${pattern.source}`);
      }
    }

    for (const domain of sig.domainPatterns) {
      // Check script src, iframe src, link href, a href attributes
      const attrPattern = new RegExp(
        `(?:src|href)=["'][^"']*${escapeRegex(domain)}[^"']*["']`,
        "i"
      );
      if (attrPattern.test(html)) {
        signals.push(`attr:${domain}`);
      }
    }

    if (signals.length > 0) {
      matches.push({ name: sig.name, signals });
    }
  }

  if (matches.length === 0) {
    return { software: null, confidence: "low", signals: [] };
  }

  // Pick the match with the most signals
  matches.sort((a, b) => b.signals.length - a.signals.length);
  const best = matches[0];

  const confidence: CrmDetectionResult["confidence"] =
    best.signals.length >= 3 ? "high" : best.signals.length >= 2 ? "medium" : "low";

  return {
    software: best.name,
    confidence,
    signals: best.signals,
  };
}

/**
 * Fetch a website's homepage and detect CRM software.
 * Returns detection result or error info.
 */
export async function scanWebsiteForCRM(
  url: string,
  timeoutMs = 8000
): Promise<CrmDetectionResult & { error?: string }> {
  try {
    // SSRF protection
    if (!(await isUrlAllowedAsync(url))) {
      return { software: null, confidence: "low", signals: [], error: "URL blocked by SSRF policy" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Phondo-LeadDiscovery-Bot/1.0 (AI Receptionist Platform)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        software: null,
        confidence: "low",
        signals: [],
        error: `HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    return detectCRM(html);
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Timeout"
          : err.message
        : "Unknown error";
    return { software: null, confidence: "low", signals: [], error: message };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All unique CRM names in the signature database */
export function getAllCrmNames(): string[] {
  return CRM_SIGNATURES.map((s) => s.name);
}
