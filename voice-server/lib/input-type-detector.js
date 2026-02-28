/**
 * Input Type Detector
 *
 * Analyzes the last assistant message to determine what type of input
 * the AI is expecting next. Used to adapt STT buffering — structured
 * inputs like phone numbers need longer buffers than general conversation.
 *
 * Pure regex, no LLM call.
 */

const INPUT_PATTERNS = {
  phone: [
    /phone\s*number/i,
    /contact\s*number/i,
    /mobile\s*(number|phone)?/i,
    /cell\s*(number|phone)?/i,
    /call\s*you\s*at/i,
    /reach\s*you\s*at/i,
    /best\s*number/i,
    /callback\s*number/i,
    /number\s*(to|I|we)\s*(can|could|should)/i,
    // Spanish
    /n[uú]mero\s*de\s*tel[eé]fono/i,
    /n[uú]mero\s*de\s*contacto/i,
    /n[uú]mero\s*de\s*celular/i,
    /su\s*n[uú]mero/i,
    /llamar(le|lo)?\s*al/i,
  ],
  email: [
    /e[\s-]?mail/i,
    /email\s*address/i,
    // Spanish
    /correo\s*electr[oó]nico/i,
    /direcci[oó]n\s*de\s*correo/i,
  ],
  name: [
    /your\s*(full\s*)?name/i,
    /first\s*name/i,
    /last\s*name/i,
    /who\s*am\s*I\s*speaking/i,
    /may\s*I\s*(have|get)\s*your\s*name/i,
    /name\s*(please|for)/i,
    /spell\s*your\s*name/i,
    // Spanish
    /su\s*nombre/i,
    /nombre\s*completo/i,
    /c[oó]mo\s*se\s*llama/i,
    /con\s*qui[eé]n\s*hablo/i,
    /apellido/i,
  ],
  address: [
    /address/i,
    /street\s*(name|number|address)?/i,
    /suburb/i,
    /postcode/i,
    /zip\s*code/i,
    /city\s*and\s*state/i,
    /mailing\s*address/i,
    /where\s*(are\s*you|do\s*you)\s*located/i,
    // Spanish
    /direcci[oó]n/i,
    /calle/i,
    /c[oó]digo\s*postal/i,
    /d[oó]nde\s*(se\s*encuentra|est[aá])/i,
  ],
  date_time: [
    /what\s*(date|time|day)/i,
    /when\s*would/i,
    /which\s*day/i,
    /preferred\s*(date|time|day)/i,
    /what\s*time\s*(works|suits|is)/i,
    /when\s*(are|is)\s*(you|the)/i,
    /schedule\s*(for|on)/i,
    // Spanish
    /qu[eé]\s*(fecha|hora|d[ií]a)/i,
    /cu[aá]ndo\s*(le|prefiere|podr[ií]a)/i,
    /qu[eé]\s*d[ií]a/i,
    /qu[eé]\s*hora\s*(le|prefiere)/i,
    /agendar\s*(para|el)/i,
    /programar\s*(para|una)/i,
  ],
};

/**
 * Patterns that indicate the AI is asking the user to CONFIRM data it already
 * has, not requesting NEW structured input. When the AI says "Is your phone
 * number 0414 123 456?", the user's "Yes" should flush immediately — not wait
 * 8 seconds for phone-number-length input.
 */
const CONFIRMATION_PATTERNS = [
  /is\s+(that|this|it)\s+(correct|right|the\s*right)/i,
  /can\s+you\s+confirm/i,
  /did\s+I\s+get\s+that\s+right/i,
  /does\s+that\s+sound\s+right/i,
  /let\s+me\s+(repeat|read\s+that|confirm|verify)/i,
  /just\s+to\s+(confirm|verify|make\s+sure|double[\s-]?check)/i,
  /so\s+(that('s|s)|it('s|s)|your\s+\w+\s+is)/i,
  /I('ve|'ll| have| will)\s+(got|read|note)/i,
];

/**
 * Detect what type of input the AI is expecting based on its last message.
 *
 * @param {string} lastAssistantMessage
 * @returns {"phone"|"email"|"name"|"address"|"date_time"|"general"}
 */
function detectExpectedInput(lastAssistantMessage) {
  if (!lastAssistantMessage) return "general";

  // If the AI is confirming data back to the user (e.g., "Is your phone
  // number 0414...?"), expect a simple yes/no — not structured input.
  const isConfirmation = CONFIRMATION_PATTERNS.some((p) => p.test(lastAssistantMessage));
  if (isConfirmation) return "general";

  for (const [type, patterns] of Object.entries(INPUT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(lastAssistantMessage)) {
        return type;
      }
    }
  }

  return "general";
}

module.exports = { detectExpectedInput };
