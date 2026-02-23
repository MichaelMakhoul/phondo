export { cn } from "./cn";

import { formatPhoneForCountry } from "@/lib/country-config";

export function formatPhoneNumber(phone: string, countryCode: string = "US"): string {
  return formatPhoneForCountry(phone, countryCode);
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  }).format(cents / 100);
}

/**
 * Generate a cryptographically secure API key
 * Uses crypto.randomBytes() instead of Math.random() for security
 */
export function generateApiKey(): string {
  // Use dynamic import to avoid issues in browser environments
  const crypto = require("crypto");
  const prefix = "hr_";
  // Generate 24 random bytes = 32 base64url characters
  const randomBytes = crypto.randomBytes(24);
  return prefix + randomBytes.toString("base64url");
}
