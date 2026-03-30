/**
 * Security validation utilities
 */
import crypto from "crypto";
import dns from "dns/promises";

// UUID validation regex
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID
 */
export function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * Validate multiple required UUIDs
 * Returns error message if invalid, null if all valid
 */
export function validateRequiredUUIDs(ids: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(ids)) {
    if (!value) {
      return `${name} is required`;
    }
    if (!isValidUUID(value)) {
      return `Invalid ${name} format`;
    }
  }
  return null;
}

/**
 * Check if a URL is allowed (not internal/private network)
 * Prevents SSRF attacks
 */
export function isUrlAllowed(urlString: string): boolean {
  try {
    const url = new URL(urlString);

    // Only allow HTTP(S)
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }

    const hostname = url.hostname.toLowerCase();

    // Block private IPs, localhost, and internal hostnames
    const blockedPatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^169\.254\./, // AWS metadata and link-local
      /^0\./, // 0.x.x.x
      /^::1$/, // IPv6 localhost
      /^fc00:/i, // IPv6 private
      /^fe80:/i, // IPv6 link-local
      /^fd[0-9a-f]{2}:/i, // IPv6 unique local
      /\.local$/i,
      /\.internal$/i,
      /\.localhost$/i,
      /\.localdomain$/i,
      /^metadata\.google\.internal$/i,
      /^instance-data$/i,
    ];

    if (blockedPatterns.some((p) => p.test(hostname))) {
      return false;
    }

    // Also block if hostname is an IP that resolves to private range
    // Check for IPv4 addresses
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b, c, d] = ipv4Match.map(Number);
      // 10.x.x.x
      if (a === 10) return false;
      // 172.16-31.x.x
      if (a === 172 && b >= 16 && b <= 31) return false;
      // 192.168.x.x
      if (a === 192 && b === 168) return false;
      // 127.x.x.x
      if (a === 127) return false;
      // 169.254.x.x
      if (a === 169 && b === 254) return false;
      // 0.x.x.x
      if (a === 0) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an IP address belongs to a private/reserved range.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4
  const v4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Match) {
    const [, a, b] = v4Match.map(Number);
    if (a === 10) return true;                              // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 127) return true;                              // 127.0.0.0/8
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16
    if (a === 0) return true;                                // 0.0.0.0/8
    return false;
  }

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc00:") || /^fd[0-9a-f]{2}:/.test(lower)) return true;
  if (lower.startsWith("fe80:")) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const mappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedMatch) return isPrivateIp(mappedMatch[1]);

  return false;
}

/**
 * Async SSRF-safe URL check: runs the synchronous hostname checks AND
 * resolves DNS to verify the IP is not in a private range.
 * Use this before making any outbound HTTP request with a user-supplied URL.
 */
export async function isUrlAllowedAsync(urlString: string): Promise<boolean> {
  // Fast synchronous check first (blocks obvious patterns)
  if (!isUrlAllowed(urlString)) return false;

  try {
    const { hostname } = new URL(urlString);

    // If hostname is already a literal IP, isUrlAllowed already checked it
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return true;

    // Resolve DNS and check all returned addresses
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const allAddresses = [...addresses, ...addresses6];

    if (allAddresses.length === 0) {
      // DNS resolution failed — block to be safe
      return false;
    }

    for (const ip of allAddresses) {
      if (isPrivateIp(ip)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
export function timingSafeCompare(a: string, b: string): boolean {
  try {
    const bufferA = Buffer.from(a, "utf8");
    const bufferB = Buffer.from(b, "utf8");

    // If lengths differ, still do the comparison to maintain constant time
    // but return false
    if (bufferA.length !== bufferB.length) {
      // Do a dummy comparison to maintain constant time
      crypto.timingSafeEqual(bufferA, bufferA);
      return false;
    }

    return crypto.timingSafeEqual(bufferA, bufferB);
  } catch {
    return false;
  }
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validate phone number format (basic validation)
 */
export function isValidPhoneNumber(phone: string): boolean {
  if (!phone) return false;
  // Remove all non-digits except leading +
  const cleaned = phone.replace(/[^\d+]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  // Valid phone numbers: 8-15 digits (E.164 standard max is 15)
  if (digits.length < 8 || digits.length > 15) return false;
  // Must not be all the same digit (e.g., 0000000000)
  if (/^(\d)\1+$/.test(digits)) return false;
  return true;
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  if (!email) return false;
  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sanitize string input (remove potentially dangerous characters)
 */
export function sanitizeString(str: string, maxLength: number = 1000): string {
  if (!str) return "";
  // Truncate to max length
  let sanitized = str.slice(0, maxLength);
  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, "");
  return sanitized;
}

/**
 * Validate ElevenLabs voice ID format
 * ElevenLabs voice IDs are alphanumeric strings (e.g., "EXAVITQu4vr4xnSDxMaL")
 * Also allows common voice name aliases (e.g., "rachel", "drew")
 */
export const VOICE_ID_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

export function isValidVoiceId(voiceId: string): boolean {
  if (!voiceId || typeof voiceId !== "string") return false;
  return VOICE_ID_REGEX.test(voiceId);
}

/**
 * Verify a webhook request with secret
 * Always requires the secret to be configured
 */
export function verifyWebhookSecret(
  requestSecret: string | null,
  expectedSecret: string | undefined,
  requireSecret: boolean = true
): { valid: boolean; error?: string } {
  if (!expectedSecret) {
    if (requireSecret) {
      return { valid: false, error: "Webhook secret not configured" };
    }
    // In development, allow without secret if explicitly disabled
    return { valid: true };
  }

  if (!requestSecret) {
    return { valid: false, error: "Missing secret header" };
  }

  if (!timingSafeCompare(requestSecret, expectedSecret)) {
    return { valid: false, error: "Invalid secret" };
  }

  return { valid: true };
}
