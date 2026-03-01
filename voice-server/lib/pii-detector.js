/**
 * PII Detection and Redaction Module
 *
 * Keyword-anchored patterns for Australian PII types.
 * Most patterns only match when preceded by anchor keywords within ~50 chars
 * to reduce false positives in natural conversation.
 *
 * No external dependencies — pure regex + Luhn validation.
 */

/**
 * Luhn algorithm validation for credit card numbers.
 * @param {string} num - digits-only string
 * @returns {boolean}
 */
function luhnCheck(num) {
  const digits = num.replace(/\D/g, "");
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Build a keyword-anchored regex.
 * Matches `pattern` only when preceded by one of `keywords` within ~50 chars.
 * @param {string[]} keywords
 * @param {string} patternStr - raw regex pattern for the PII value
 * @param {string} flags
 * @returns {RegExp}
 */
function keywordAnchored(keywords, patternStr, flags = "gi") {
  // keyword followed by up to 50 chars of anything, then the PII pattern
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const joined = escaped.join("|");
  return new RegExp(`(?:${joined})(?:.{0,50}?)(${patternStr})`, flags);
}

// --- Pattern definitions ---

const MEDICARE_KEYWORDS = ["medicare", "health insurance number"];
const MEDICARE_PATTERN = "\\d{4}[\\s-]?\\d{5}[\\s-]?\\d{1,2}";

const TFN_KEYWORDS = ["tax file number", "tfn"];
const TFN_PATTERN = "\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{3}";

const ABN_KEYWORDS = ["abn", "australian business number"];
const ABN_PATTERN = "\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{3}[\\s-]?\\d{3}";

const BSB_KEYWORDS = ["bsb", "bank", "account"];
const BSB_PATTERN = "\\d{3}[\\s-]\\d{3}";
const BANK_ACCOUNT_PATTERN = "\\d{6,9}";

const PHONE_KEYWORDS = [
  "my phone", "my mobile", "my number",
  "phone number is", "mobile number is",
  "reach me at", "call me at",
];
const PHONE_PATTERN = "(?:0[45]\\d{2}|\\+614\\d{2})[\\s-]?\\d{3}[\\s-]?\\d{3}";

const DOB_KEYWORDS = ["date of birth", "dob", "born on", "birthday"];
const DOB_PATTERN = "\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}";

const ADDRESS_KEYWORDS = ["my address", "i live at", "located at"];
const ADDRESS_PATTERN =
  "\\d{1,5}\\s+[A-Za-z][A-Za-z\\s]{2,30}(?:street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|crescent|cres|boulevard|blvd|lane|ln|way|terrace|tce|circuit|cct|parade|pde|highway|hwy|close|cl)";

// Standalone patterns (no keyword needed)
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const CREDIT_CARD_REGEX = /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g;

// Compiled keyword-anchored regexes
const MEDICARE_REGEX = keywordAnchored(MEDICARE_KEYWORDS, MEDICARE_PATTERN);
const TFN_REGEX = keywordAnchored(TFN_KEYWORDS, TFN_PATTERN);
const ABN_REGEX = keywordAnchored(ABN_KEYWORDS, ABN_PATTERN);
const BSB_REGEX = keywordAnchored(BSB_KEYWORDS, BSB_PATTERN);
const BANK_ACCOUNT_REGEX = keywordAnchored(BSB_KEYWORDS, BANK_ACCOUNT_PATTERN);
const PHONE_REGEX = keywordAnchored(PHONE_KEYWORDS, PHONE_PATTERN);
const DOB_REGEX = keywordAnchored(DOB_KEYWORDS, DOB_PATTERN);
const ADDRESS_REGEX = keywordAnchored(ADDRESS_KEYWORDS, ADDRESS_PATTERN);

/**
 * Detect and redact PII in a text string.
 *
 * @param {string} text
 * @returns {{ redacted: string, piiFound: boolean, types: string[] }}
 */
function detectAndRedact(text) {
  if (!text || typeof text !== "string") {
    return { redacted: text, piiFound: false, types: [] };
  }

  const typesFound = new Set();
  let result = text;

  // Credit card (standalone, Luhn validated)
  result = result.replace(CREDIT_CARD_REGEX, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length === 16 && luhnCheck(digits)) {
      typesFound.add("credit_card");
      return "[REDACTED-CREDIT-CARD]";
    }
    return match;
  });

  // Email (standalone)
  result = result.replace(EMAIL_REGEX, () => {
    typesFound.add("email");
    return "[REDACTED-EMAIL]";
  });

  // Keyword-anchored patterns — replace capture group (group 1) only
  const anchoredPatterns = [
    { regex: MEDICARE_REGEX, replacement: "[REDACTED-MEDICARE]", type: "medicare" },
    { regex: TFN_REGEX, replacement: "[REDACTED-TFN]", type: "tfn" },
    { regex: ABN_REGEX, replacement: "[REDACTED-ABN]", type: "abn" },
    { regex: ADDRESS_REGEX, replacement: "[REDACTED-ADDRESS]", type: "address" },
    { regex: DOB_REGEX, replacement: "[REDACTED-DOB]", type: "dob" },
    { regex: PHONE_REGEX, replacement: "[REDACTED-PHONE]", type: "phone" },
    { regex: BSB_REGEX, replacement: "[REDACTED-BSB]", type: "bsb" },
    { regex: BANK_ACCOUNT_REGEX, replacement: "[REDACTED-BANK-ACCOUNT]", type: "bank_account" },
  ];

  for (const { regex, replacement, type } of anchoredPatterns) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    result = result.replace(regex, (fullMatch, capturedGroup) => {
      typesFound.add(type);
      return fullMatch.replace(capturedGroup, replacement);
    });
  }

  const types = [...typesFound];
  return { redacted: result, piiFound: types.length > 0, types };
}

/**
 * Recursively redact all string values in an object.
 *
 * @param {*} obj
 * @returns {{ redacted: *, piiFound: boolean, types: string[] }}
 */
function redactObject(obj) {
  if (!obj || typeof obj !== "object") {
    if (typeof obj === "string") {
      return detectAndRedact(obj);
    }
    return { redacted: obj, piiFound: false, types: [] };
  }

  const allTypes = new Set();

  if (Array.isArray(obj)) {
    const redactedArr = obj.map((item) => {
      const r = redactObject(item);
      r.types.forEach((t) => allTypes.add(t));
      return r.redacted;
    });
    return { redacted: redactedArr, piiFound: allTypes.size > 0, types: [...allTypes] };
  }

  const redactedObj = {};
  for (const [key, value] of Object.entries(obj)) {
    const r = redactObject(value);
    r.types.forEach((t) => allTypes.add(t));
    redactedObj[key] = r.redacted;
  }
  return { redacted: redactedObj, piiFound: allTypes.size > 0, types: [...allTypes] };
}

module.exports = { detectAndRedact, redactObject, luhnCheck };
