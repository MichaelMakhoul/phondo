/**
 * Shared types for the lead discovery feature.
 */

/** Structured CRM detection details stored in discovered_businesses.detected_crm_details */
export interface CrmDetails {
  software: string | null;
  confidence: "high" | "medium" | "low";
  signals: string[];
}

/** Possible values for discovered_businesses.detected_crm */
export const CRM_NOT_SCANNED = null;
export const CRM_NONE = "none" as const;
export const CRM_NO_WEBSITE = "no_website" as const;

export type CrmStatus = typeof CRM_NONE | typeof CRM_NO_WEBSITE | string;

/** Row shape from the discovered_businesses table */
export interface DiscoveredBusiness {
  id: string;
  google_place_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  google_types: string[] | null;
  profession: string | null;
  detected_crm: string | null;
  detected_crm_details: CrmDetails | null;
  website_scanned_at: string | null;
  website_scan_error: string | null;
  created_at: string;
  updated_at: string;
}
