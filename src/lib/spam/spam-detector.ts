/**
 * Spam Call Detection Service
 *
 * Analyzes incoming calls and call patterns to detect potential spam.
 * Uses multiple signals:
 * - Known spam phone number databases
 * - Call frequency patterns
 * - Call duration patterns (very short calls)
 * - Time of day patterns (unusual hours)
 * - Geographic patterns
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getCountryConfig } from "@/lib/country-config";

export interface SpamAnalysisResult {
  isSpam: boolean;
  spamScore: number; // 0-100, higher = more likely spam
  reasons: string[];
  confidence: "high" | "medium" | "low";
  recommendation: "block" | "flag" | "allow";
}

export interface CallMetadata {
  callerPhone: string;
  organizationId: string;
  countryCode?: string;
  timestamp: Date;
  duration?: number;
  transcript?: string;
}

// Known spam patterns and indicators
const SPAM_INDICATORS = {
  // Patterns in caller ID names that suggest spam
  suspiciousCallerIdPatterns: [
    /^V\d+$/i, // V followed by numbers (V1234567)
    /^TOLL\s*FREE/i,
    /^WIRELESS\s*CALLER/i,
    /^UNKNOWN/i,
    /^PRIVATE/i,
    /^POTENTIAL\s*SPAM/i,
    /^SCAM\s*LIKELY/i,
  ],

  // Short call durations (in seconds) that might indicate robocalls
  suspiciousCallDuration: 5, // Calls under 5 seconds

  // Keywords in transcript that suggest spam
  spamKeywords: [
    "warranty",
    "extended warranty",
    "car warranty",
    "auto warranty",
    "social security",
    "irs",
    "microsoft",
    "apple support",
    "tech support",
    "virus detected",
    "computer compromised",
    "amazon order",
    "debt collection",
    "free vacation",
    "timeshare",
    "lower interest rate",
    "student loan forgiveness",
    "medicare",
    "health insurance",
    "final notice",
    "legal action",
    "won a prize",
    "bitcoin",
    "cryptocurrency investment",
    "press 1",
    "press one",
    "act now",
    "limited time",
    "urgent",
  ],
};

/**
 * Analyze a phone number for spam indicators
 */
function analyzePhoneNumber(phone: string, countryCode: string = "US"): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  // Normalize phone number
  const normalized = phone.replace(/\D/g, "");

  // Country-aware validation
  const config = getCountryConfig(countryCode);

  if (!config.phone.validateNational(normalized)) {
    score += 5;
    reasons.push("Invalid phone number format");
  }

  // Extract area code using country config
  const areaCode = config.phone.extractAreaCode(normalized);

  // Check against suspicious area codes for this country
  const suspiciousAreaCodes = config.suspiciousAreaCodes;
  if (areaCode && suspiciousAreaCodes.includes(areaCode)) {
    score += 15;
    reasons.push(`Area code ${areaCode} associated with high spam volume`);
  }

  // Check for sequential or repetitive numbers (often spoofed)
  if (/^(.)\1{5,}/.test(normalized)) {
    score += 30;
    reasons.push("Repetitive number pattern");
  }

  // Check for sequential numbers (123456, 987654)
  if (/123456|234567|345678|456789|987654|876543|765432|654321/.test(normalized)) {
    score += 25;
    reasons.push("Sequential number pattern");
  }

  return { score, reasons };
}

/**
 * Analyze call frequency from a number
 */
async function analyzeCallFrequency(
  phone: string,
  organizationId: string,
  timeWindowHours: number = 24
): Promise<{ score: number; reasons: string[] }> {
  const supabase = createAdminClient();

  const windowStart = new Date();
  windowStart.setHours(windowStart.getHours() - timeWindowHours);

  // Count calls from this number in the time window
  const { count, error } = await (supabase as any)
    .from("calls")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("caller_phone", phone)
    .gte("created_at", windowStart.toISOString());

  if (error || count === null) {
    console.error("[SpamDetector] analyzeCallFrequency failed:", {
      phone,
      organizationId,
      error: error?.message || error?.code || "count was null",
    });
    return { score: 0, reasons: [] };
  }

  let score = 0;
  const reasons: string[] = [];

  // High call frequency is suspicious
  if (count > 10) {
    score += 20;
    reasons.push(`${count} calls in the last ${timeWindowHours} hours`);
  } else if (count > 5) {
    score += 10;
    reasons.push(`${count} calls in the last ${timeWindowHours} hours`);
  } else if (count > 3) {
    score += 5;
    reasons.push(`${count} calls in the last ${timeWindowHours} hours`);
  }

  return { score, reasons };
}

/**
 * Analyze transcript for spam keywords
 */
function analyzeTranscript(transcript: string): {
  score: number;
  reasons: string[];
} {
  if (!transcript) {
    return { score: 0, reasons: [] };
  }

  const lowerTranscript = transcript.toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  const foundKeywords: string[] = [];

  for (const keyword of SPAM_INDICATORS.spamKeywords) {
    if (lowerTranscript.includes(keyword.toLowerCase())) {
      foundKeywords.push(keyword);
      score += 10;
    }
  }

  // Cap keyword-based score
  if (foundKeywords.length > 0) {
    score = Math.min(score, 50);
    reasons.push(`Spam keywords detected: ${foundKeywords.slice(0, 5).join(", ")}`);
  }

  // Check for "press 1" type robocall indicators
  if (lowerTranscript.match(/press\s*(1|one|2|two|\*|#)/i)) {
    score += 30;
    reasons.push("Interactive robocall pattern detected");
  }

  return { score, reasons };
}

/**
 * Analyze call timing for suspicious patterns
 */
function analyzeCallTiming(timestamp: Date): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  const hour = timestamp.getHours();
  const dayOfWeek = timestamp.getDay(); // 0 = Sunday

  // Very early or late calls are suspicious for businesses
  if (hour >= 0 && hour < 7) {
    score += 15;
    reasons.push("Call during unusual hours (late night/early morning)");
  } else if (hour >= 21) {
    score += 10;
    reasons.push("Call during late evening hours");
  }

  // Weekend calls — not penalized, many businesses operate on weekends
  // if (dayOfWeek === 0 || dayOfWeek === 6) {
  //   score += 0;
  // }

  return { score, reasons };
}

/**
 * Analyze call duration
 */
function analyzeCallDuration(durationSeconds: number | undefined): {
  score: number;
  reasons: string[];
} {
  if (durationSeconds === undefined) {
    return { score: 0, reasons: [] };
  }

  let score = 0;
  const reasons: string[] = [];

  // Very short calls might be robocalls checking if number is active
  if (durationSeconds < SPAM_INDICATORS.suspiciousCallDuration) {
    score += 20;
    reasons.push(`Very short call duration (${durationSeconds}s)`);
  }

  return { score, reasons };
}

/**
 * Check if phone number is in our internal blocklist
 */
async function checkBlocklist(
  phone: string,
  organizationId: string
): Promise<boolean> {
  const supabase = createAdminClient();

  // Check for previously marked spam calls from this number
  const { data, error } = await (supabase as any)
    .from("calls")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("caller_phone", phone)
    .eq("is_spam", true)
    .limit(1);

  if (error) {
    console.error("[SpamDetector] checkBlocklist query failed:", {
      phone,
      organizationId,
      error: error.message || error.code,
    });
  }

  return !error && data && data.length > 0;
}

/**
 * Main spam analysis function
 */
export async function analyzeCall(metadata: CallMetadata): Promise<SpamAnalysisResult> {
  const allReasons: string[] = [];
  let totalScore = 0;

  // Check blocklist first
  const isBlocked = await checkBlocklist(metadata.callerPhone, metadata.organizationId);
  if (isBlocked) {
    return {
      isSpam: true,
      spamScore: 100,
      reasons: ["Previously marked as spam"],
      confidence: "high",
      recommendation: "block",
    };
  }

  // Analyze phone number
  const phoneAnalysis = analyzePhoneNumber(metadata.callerPhone, metadata.countryCode);
  totalScore += phoneAnalysis.score;
  allReasons.push(...phoneAnalysis.reasons);

  // Analyze call frequency
  const frequencyAnalysis = await analyzeCallFrequency(
    metadata.callerPhone,
    metadata.organizationId
  );
  totalScore += frequencyAnalysis.score;
  allReasons.push(...frequencyAnalysis.reasons);

  // Analyze transcript if available
  if (metadata.transcript) {
    const transcriptAnalysis = analyzeTranscript(metadata.transcript);
    totalScore += transcriptAnalysis.score;
    allReasons.push(...transcriptAnalysis.reasons);
  }

  // Analyze call timing
  const timingAnalysis = analyzeCallTiming(metadata.timestamp);
  totalScore += timingAnalysis.score;
  allReasons.push(...timingAnalysis.reasons);

  // Analyze call duration
  if (metadata.duration !== undefined) {
    const durationAnalysis = analyzeCallDuration(metadata.duration);
    totalScore += durationAnalysis.score;
    allReasons.push(...durationAnalysis.reasons);
  }

  // Cap total score at 100
  const spamScore = Math.min(totalScore, 100);

  // Determine confidence level
  let confidence: SpamAnalysisResult["confidence"];
  if (allReasons.length >= 4 && spamScore >= 60) {
    confidence = "high";
  } else if (allReasons.length >= 2 && spamScore >= 40) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // Determine recommendation
  let recommendation: SpamAnalysisResult["recommendation"];
  if (spamScore >= 70) {
    recommendation = "block";
  } else if (spamScore >= 50) {
    recommendation = "flag";
  } else {
    recommendation = "allow";
  }

  return {
    isSpam: spamScore >= 70,
    spamScore,
    reasons: allReasons,
    confidence,
    recommendation,
  };
}

/**
 * Mark a call as spam (for user reporting)
 */
export async function markCallAsSpam(
  callId: string,
  organizationId: string
): Promise<boolean> {
  const supabase = createAdminClient();

  const { error } = await (supabase as any)
    .from("calls")
    .update({ is_spam: true })
    .eq("id", callId)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[SpamDetector] markCallAsSpam failed:", {
      callId,
      organizationId,
      error: error.message || error.code,
    });
  }

  return !error;
}

/**
 * Mark a call as not spam (for false positives)
 */
export async function markCallAsNotSpam(
  callId: string,
  organizationId: string
): Promise<boolean> {
  const supabase = createAdminClient();

  const { error } = await (supabase as any)
    .from("calls")
    .update({ is_spam: false })
    .eq("id", callId)
    .eq("organization_id", organizationId);

  if (error) {
    console.error("[SpamDetector] markCallAsNotSpam failed:", {
      callId,
      organizationId,
      error: error.message || error.code,
    });
  }

  return !error;
}
