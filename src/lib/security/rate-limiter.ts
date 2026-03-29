/**
 * Simple in-memory rate limiter
 * For production, consider using Redis-based rate limiting
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
}

// In-memory store (use Redis for distributed systems)
const store = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
const CLEANUP_INTERVAL = 60 * 1000; // 1 minute
let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanup() {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.resetTime < now) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);

  // Don't prevent process from exiting
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

// Start cleanup on module load
startCleanup();

/**
 * Default rate limit configurations
 */
export const rateLimitConfigs = {
  // Standard API calls - 100 per minute
  standard: {
    windowMs: 60 * 1000,
    maxRequests: 100,
  },
  // Authentication endpoints - 10 per minute
  auth: {
    windowMs: 60 * 1000,
    maxRequests: 10,
  },
  // Webhook endpoints - 1000 per minute (high volume)
  webhook: {
    windowMs: 60 * 1000,
    maxRequests: 1000,
  },
  // Expensive operations (scraping, AI) - 10 per minute
  expensive: {
    windowMs: 60 * 1000,
    maxRequests: 10,
  },
  // Test calls - 5 per minute
  testCall: {
    windowMs: 60 * 1000,
    maxRequests: 5,
  },
  // Admin expensive operations (Google Places API, bulk scraping) - 3 per minute
  adminExpensive: {
    windowMs: 60 * 1000,
    maxRequests: 3,
  },
} as const;

export type RateLimitType = keyof typeof rateLimitConfigs;

/**
 * Check if a request should be rate limited
 * Returns remaining requests if allowed, or -1 if rate limited
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = store.get(key);

  // No entry or expired - create new entry
  if (!entry || entry.resetTime < now) {
    const resetTime = now + config.windowMs;
    store.set(key, { count: 1, resetTime });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetTime,
    };
  }

  // Entry exists and not expired
  if (entry.count >= config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime,
    };
  }

  // Increment count
  entry.count++;
  store.set(key, entry);

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetTime: entry.resetTime,
  };
}

/**
 * Get rate limit key for a request
 * Uses IP + optional user ID for more granular limiting
 */
export function getRateLimitKey(
  identifier: string,
  endpoint: string
): string {
  return `${identifier}:${endpoint}`;
}

/**
 * Rate limiter helper that returns response headers
 */
export function rateLimit(
  identifier: string,
  endpoint: string,
  type: RateLimitType = "standard"
): {
  allowed: boolean;
  headers: Record<string, string>;
} {
  const config = rateLimitConfigs[type];
  const key = getRateLimitKey(identifier, endpoint);
  const result = checkRateLimit(key, config);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": config.maxRequests.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(result.resetTime / 1000).toString(),
  };

  if (!result.allowed) {
    headers["Retry-After"] = Math.ceil(
      (result.resetTime - Date.now()) / 1000
    ).toString();
  }

  return { allowed: result.allowed, headers };
}

/**
 * Get client IP from request headers
 * Handles common proxy headers
 */
export function getClientIp(headers: Headers): string {
  // Check common proxy headers
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    // Get the first IP in the chain (client IP)
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  // Vercel-specific header
  const vercelIp = headers.get("x-vercel-forwarded-for");
  if (vercelIp) {
    return vercelIp.split(",")[0].trim();
  }

  // Fallback
  return "unknown";
}

/**
 * Convenience function to apply rate limiting to Next.js API routes
 */
export function withRateLimit(
  request: Request,
  endpoint: string,
  type: RateLimitType = "standard"
) {
  const clientIp = getClientIp(new Headers(request.headers));
  return rateLimit(clientIp, endpoint, type);
}
