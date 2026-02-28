/**
 * Input Validators
 *
 * Per-type completeness checks that run on the accumulated STT buffer
 * to decide: flush now, or keep waiting for more input?
 *
 * Also exports buffer timing configs per input type.
 */

/**
 * Buffer timing configs per input type.
 * - debounceMs: how long to wait after last STT final before flushing
 * - maxWaitMs: hard ceiling — force flush regardless of validation
 * - ignoreUtteranceEnd: if true, Deepgram UtteranceEnd won't trigger early flush
 */
const BUFFER_CONFIGS = {
  phone:     { debounceMs: 2000, maxWaitMs: 8000,  ignoreUtteranceEnd: true  },
  email:     { debounceMs: 2000, maxWaitMs: 6000,  ignoreUtteranceEnd: true  },
  name:      { debounceMs: 1200, maxWaitMs: 4000,  ignoreUtteranceEnd: false },
  address:   { debounceMs: 2500, maxWaitMs: 10000, ignoreUtteranceEnd: true  },
  date_time: { debounceMs: 1000, maxWaitMs: 4000,  ignoreUtteranceEnd: false },
  general:   { debounceMs: 400,  maxWaitMs: 2000,  ignoreUtteranceEnd: false },
};

// Spoken digit words mapped to digit strings
const SPOKEN_DIGITS = {
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
};

// "double five" → "55", "triple zero" → "000"
const MULTIPLIERS = { double: 2, triple: 3 };

/**
 * Extract digits from spoken text.
 * Handles: "0412 345 678", "oh four one two", "double five", etc.
 */
function extractSpokenDigits(text) {
  let digits = "";

  // First pass: expand "double/triple X" patterns
  let expanded = text.toLowerCase();
  for (const [mult, count] of Object.entries(MULTIPLIERS)) {
    const re = new RegExp(`${mult}\\s+(\\w+)`, "gi");
    expanded = expanded.replace(re, (_, word) => {
      const d = SPOKEN_DIGITS[word] || (word.match(/^\d$/) ? word : "");
      return d ? d.repeat(count) : word;
    });
  }

  // Second pass: extract all digit characters and spoken digit words
  const tokens = expanded.split(/[\s,.-]+/);
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      digits += token;
    } else if (SPOKEN_DIGITS[token] !== undefined) {
      digits += SPOKEN_DIGITS[token];
    }
  }

  return digits;
}

/**
 * Check if the user's speech is a question rather than structured data input.
 * When the AI expects a date/time but the user asks "When is the first
 * available appointment?", we should flush immediately instead of waiting
 * for a date/time value that will never come.
 */
const QUESTION_STARTERS = /^(when|what|where|which|who|how|is\s+there|are\s+there|do\s+you|does|can\s+you|could\s+you|will|would)\b/i;

function isUserQuestion(text) {
  return QUESTION_STARTERS.test(text.trim());
}

/**
 * Validate whether the accumulated buffer text is a complete input
 * for the given type.
 *
 * @param {string} type - Input type from detectExpectedInput()
 * @param {string} text - Combined buffer text
 * @returns {{ complete: boolean, reason?: string }}
 */
function validateInput(type, text) {
  // If the user is asking a question instead of providing data, flush
  // immediately. E.g., AI expects date_time but user says "When is the
  // first available appointment?"
  if (type !== "general" && isUserQuestion(text)) {
    return { complete: true, reason: "user question detected — not data input" };
  }

  switch (type) {
    case "phone": {
      const digits = extractSpokenDigits(text);
      if (digits.length >= 8) {
        return { complete: true, reason: `${digits.length} digits found` };
      }
      // If no digits at all, the user is speaking conversationally
      if (digits.length === 0) {
        return { complete: true, reason: "no digits — conversational response" };
      }
      return { complete: false, reason: `only ${digits.length} digits so far` };
    }

    case "email": {
      const lower = text.toLowerCase();
      // Look for TLD patterns: "dot com", ".com", "dot com dot au"
      const hasTld = /\.(com|net|org|edu|gov|io|au|uk|nz|co)(\.\w{2,3})?/i.test(lower)
        || /dot\s*(com|net|org|edu|gov|io|au|uk|nz|co)/i.test(lower);
      if (hasTld) {
        return { complete: true, reason: "TLD found" };
      }
      return { complete: false, reason: "no TLD yet" };
    }

    case "name": {
      const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
      if (words.length >= 2) {
        return { complete: true, reason: `${words.length} words (first+last)` };
      }
      return { complete: false, reason: `only ${words.length} word(s)` };
    }

    case "address": {
      const lower = text.toLowerCase();
      // Look for postcode/zip (4-5 digits) or street number + name
      const hasPostcode = /\b\d{4,5}\b/.test(lower);
      const hasStreetNumber = /\b\d+\s+\w+\s*(street|st|road|rd|avenue|ave|drive|dr|lane|ln|place|pl|court|ct|way|boulevard|blvd|crescent|cres|terrace|tce)/i.test(lower);
      if (hasPostcode || hasStreetNumber) {
        return { complete: true, reason: hasPostcode ? "postcode found" : "street address found" };
      }
      return { complete: false, reason: "no structural address elements yet" };
    }

    case "date_time": {
      const lower = text.toLowerCase();
      // Look for day/date references
      const hasDate = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next\s+\w+|this\s+\w+|\d{1,2}(st|nd|rd|th)?(\s+of)?(\s+\w+)?)\b/i.test(lower);
      const hasTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm|a\.m|p\.m)|morning|afternoon|evening)\b/i.test(lower);
      if (hasDate || hasTime) {
        return { complete: true, reason: hasDate ? "date reference found" : "time reference found" };
      }
      return { complete: false, reason: "no date/time reference yet" };
    }

    case "general":
    default:
      return { complete: true };
  }
}

/**
 * Get buffer config for a given input type.
 * @param {string} type
 * @returns {{ debounceMs: number, maxWaitMs: number, ignoreUtteranceEnd: boolean }}
 */
function getBufferConfig(type) {
  return BUFFER_CONFIGS[type] || BUFFER_CONFIGS.general;
}

module.exports = { validateInput, getBufferConfig, BUFFER_CONFIGS, extractSpokenDigits };
