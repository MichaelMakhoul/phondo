/**
 * Knowledge-base aggregation — the single place KB entries become the
 * `<business_knowledge_base>` string a call's system prompt carries.
 *
 * SCRUM-531: owner-authored knowledge must never be evicted by scraped
 * website content. The aggregate is hard-capped at MAX_KB_CHARS before it
 * reaches the model (prompt-builder.js), and entries used to be joined in
 * created_at order. The website import is both created FIRST (onboarding)
 * and huge (raw page text, up to 50k chars), so every FAQ, document and
 * manual note the owner added later fell past the cap and silently never
 * reached the AI — while the Knowledge page kept showing it as saved.
 *
 * Ordering rule: everything the owner wrote outranks everything we
 * scraped. Within each group the incoming (created_at) order is kept, so
 * sibling entries never reorder relative to each other.
 *
 * Formerly duplicated inline in loadCallContext and loadTestCallContext
 * (lib/call-context.js); extracted so the ordering decision lives in a
 * pure module that tests can actually pin.
 */

/**
 * Cap on the aggregated KB, in characters (~3k tokens). Enforced by
 * buildSystemPrompt; used here to report which entries the cap will cut.
 */
const MAX_KB_CHARS = 12_000;

/**
 * source_type values that are scraped rather than owner-authored. An
 * unknown/missing source_type is treated as owner-authored: mis-ranking a
 * new authored type below a website dump would silently re-open this bug,
 * while the reverse merely costs a scrape some budget.
 */
const SCRAPED_SOURCE_TYPES = new Set(["website"]);

/**
 * Stable partition: owner-authored entries first, scraped entries last.
 * Does not mutate the input.
 *
 * @param {Array<{source_type?: string}>} entries
 * @returns {Array<object>}
 */
function prioritizeKnowledgeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const authored = entries.filter((e) => !SCRAPED_SOURCE_TYPES.has(e && e.source_type));
  const scraped = entries.filter((e) => SCRAPED_SOURCE_TYPES.has(e && e.source_type));
  return [...authored, ...scraped];
}

/**
 * Render one KB entry as a markdown section.
 * FAQ entries store a JSON array of {question, answer}; anything that
 * fails to parse AS that shape (bad JSON, non-array) falls back to the
 * raw content rather than dropping the entry.
 *
 * @param {{id?: string, title?: string, source_type?: string, content: string}} entry
 * @param {string} logTag
 * @returns {string}
 */
function renderEntrySection(entry, logTag) {
  const heading = entry.title || entry.source_type;
  if (entry.source_type === "faq") {
    try {
      const pairs = JSON.parse(entry.content);
      const qaParts = pairs
        .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
        .join("\n\n");
      return `## ${heading}\n${qaParts}`;
    } catch (parseErr) {
      console.warn(`${logTag} FAQ entry has malformed JSON — using raw content:`, {
        entryId: entry.id,
        error: parseErr.message,
      });
    }
  }
  return `## ${heading}\n${entry.content}`;
}

/**
 * Which entries will the cap cut, given the section strings that get
 * joined with "\n\n"? Pure; exported for boundary tests.
 *
 * @param {Array<{label: string, length: number}>} sectionSizes - in join order
 * @param {number} cap
 * @returns {Array<{label: string, cut: "partial" | "entire"}>}
 */
function findEntriesBeyondCap(sectionSizes, cap) {
  /** @type {Array<{label: string, cut: "partial" | "entire"}>} */
  const beyond = [];
  let offset = 0;
  for (let i = 0; i < sectionSizes.length; i++) {
    const start = offset + (i > 0 ? 2 : 0); // "\n\n" separator before every section but the first
    const end = start + sectionSizes[i].length;
    if (start >= cap) {
      beyond.push({ label: sectionSizes[i].label, cut: "entire" });
    } else if (end > cap) {
      beyond.push({ label: sectionSizes[i].label, cut: "partial" });
    }
    offset = end;
  }
  return beyond;
}

/**
 * Aggregate active KB entries into the single string the prompt carries.
 * Owner-authored entries are placed first (see module doc); if the result
 * exceeds MAX_KB_CHARS this logs exactly which entries the cap will cut,
 * so a too-big KB is a searchable log line instead of a silent absence.
 *
 * @param {Array<{id?: string, title?: string, source_type?: string, content: string}>|null|undefined} kbEntries
 * @param {string} [logTag] - log prefix identifying the caller (e.g. "[CallContext]")
 * @returns {string}
 */
function aggregateKnowledgeBase(kbEntries, logTag = "[KB]") {
  if (!kbEntries || kbEntries.length === 0) return "";

  const ordered = prioritizeKnowledgeEntries(kbEntries);
  const sections = ordered.map((entry) => renderEntrySection(entry, logTag));
  const knowledgeBase = sections.join("\n\n");

  if (knowledgeBase.length > MAX_KB_CHARS) {
    const sizes = ordered.map((entry, i) => ({
      label: `${entry.title || entry.source_type} (${entry.source_type})`,
      length: sections[i].length,
    }));
    console.warn(`${logTag} KB is ${knowledgeBase.length} chars but only ${MAX_KB_CHARS} reach the AI — cut entries:`, {
      cutEntries: findEntriesBeyondCap(sizes, MAX_KB_CHARS),
    });
  }

  return knowledgeBase;
}

module.exports = {
  MAX_KB_CHARS,
  aggregateKnowledgeBase,
  prioritizeKnowledgeEntries,
  findEntriesBeyondCap,
};
