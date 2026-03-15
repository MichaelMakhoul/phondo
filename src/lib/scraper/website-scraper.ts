/**
 * Website Scraper for Knowledge Base Generation
 *
 * Scrapes a business website to extract relevant information for training
 * the AI assistant with business-specific knowledge.
 */

import { isUrlAllowedAsync } from "@/lib/security/validation";

export interface ScrapedPage {
  url: string;
  title: string;
  content: string;
  metadata?: {
    description?: string;
    keywords?: string[];
  };
}

export interface ScrapedWebsite {
  baseUrl: string;
  pages: ScrapedPage[];
  businessInfo: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    hours?: string[];
    services?: string[];
    about?: string;
  };
  scrapedAt: Date;
  totalPages: number;
}

export interface ScrapeOptions {
  maxPages?: number;
  maxDepth?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  timeout?: number;
}

const DEFAULT_OPTIONS: ScrapeOptions = {
  maxPages: 20,
  maxDepth: 2,
  excludePatterns: [
    '/blog/',
    '/news/',
    '/press/',
    '/careers/',
    '/jobs/',
    '/privacy',
    '/terms',
    '/legal',
    '/cookie',
    '/sitemap',
    '/admin',
    '/wp-admin',
    '/login',
    '/cart',
    '/checkout',
  ],
  timeout: 30000,
};

/**
 * Decode common HTML entities and normalize whitespace.
 */
function decodeHtmlEntities(text: string): string {
  let result = text;
  result = result.replace(/&nbsp;/g, ' ');
  result = result.replace(/&amp;/g, '&');
  result = result.replace(/&lt;/g, '<');
  result = result.replace(/&gt;/g, '>');
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Strip script, style, and HTML comment elements from raw HTML.
 */
function stripNonContentElements(html: string): string {
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
  return cleaned;
}

/**
 * Extract clean text content from HTML.
 * NOTE: Strips <nav>, <header>, <footer> to reduce noise for KB content.
 * Phone/email may appear in those elements — extractBusinessInfo runs on
 * the full HTML separately to avoid missing them.
 */
function extractTextContent(html: string): string {
  let cleaned = stripNonContentElements(html);

  // Remove navigation, header, footer elements (common noise for KB content)
  cleaned = cleaned.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
  cleaned = cleaned.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '');
  cleaned = cleaned.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

  // Extract text from remaining HTML
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(cleaned);
}

/**
 * Extract ALL text from HTML (including header/footer) for phone/email extraction.
 * Less aggressive than extractTextContent — keeps header/footer where contact info lives.
 */
function extractFullText(html: string): string {
  const cleaned = stripNonContentElements(html).replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(cleaned);
}

/**
 * Extract title from HTML
 */
function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].replace(/<[^>]+>/g, '').trim();
  }

  // Try h1 as fallback
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match) {
    return h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  return '';
}

/**
 * Extract meta description
 */
function extractMetaDescription(html: string): string | undefined {
  const match = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);
  if (match) {
    return match[1].trim();
  }

  // Try og:description as fallback
  const ogMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) {
    return ogMatch[1].trim();
  }

  return undefined;
}

/**
 * Check if a phone number looks plausible (not a placeholder, test number,
 * or artifact). Does NOT validate that the number is actually dialable —
 * this is a scraping heuristic only.
 */
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (digits === '1234567890' || digits === '0987654321') return false;
  if (/^0{4,}/.test(digits)) return false;
  const digitCounts = new Map<string, number>();
  for (const digit of digits) {
    digitCounts.set(digit, (digitCounts.get(digit) || 0) + 1);
  }
  const maxFrequency = Math.max(...digitCounts.values());
  if (maxFrequency / digits.length > 0.7) return false;
  return true;
}

/**
 * Filter out non-business email addresses (noreply, image filenames, retina patterns)
 */
export function isBusinessEmail(email: string): boolean {
  if (email.includes('noreply') || email.includes('no-reply')) return false;
  if (email.includes('example.com')) return false;
  // Image filenames (e.g. logo@2x-001-250x98.png)
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|bmp|tiff)$/i.test(email)) return false;
  // Retina image suffixes at end of local part (e.g. image@2x — but NOT info@2xdesign.com)
  if (/@[0-9]+x$/i.test(email.split('.')[0])) return false;
  return true;
}

/**
 * Extract business information from full page text (including header/footer).
 */
function extractBusinessInfo(text: string, existingInfo: ScrapedWebsite['businessInfo']): ScrapedWebsite['businessInfo'] {
  const info = { ...existingInfo };

  // Multiple patterns in priority order (AU landline, AU mobile, US)
  // AU patterns require country/area code prefixes; US patterns require
  // structural markers (parens, separators, or +1) to avoid bare digit matches
  const phonePatterns = [
    // AU landline with +61: +61 2 8123 0183
    /\+61[-.\s]?[2-478][-.\s]?[0-9]{4}[-.\s]?[0-9]{4}/g,
    // AU landline with area code: (02) 8123 0183, 02 8123 0183
    /\(?0[2-478]\)?[-.\s]?[0-9]{4}[-.\s]?[0-9]{4}/g,
    // AU mobile: 0400 123 456, +61 400 123 456
    /(?:\+61[-.\s]?)?04[0-9]{2}[-.\s]?[0-9]{3}[-.\s]?[0-9]{3}/g,
    // US with +1 prefix: +1 555-123-4567
    /\+1[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    // US with parens: (555) 123-4567
    /\([0-9]{3}\)[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
    // US with separators: 555-123-4567, 555.123.4567
    /[0-9]{3}[-.][0-9]{3}[-.][0-9]{4}/g,
  ];

  if (!info.phone) {
    for (const pattern of phonePatterns) {
      const phones = text.match(pattern);
      const validPhone = phones?.find(p => isValidPhone(p));
      if (validPhone) {
        info.phone = validPhone;
        break;
      }
    }
  }

  if (!info.email) {
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = text.match(emailPattern);
    const businessEmail = emails?.find(isBusinessEmail);
    if (businessEmail) {
      info.email = businessEmail;
    }
  }

  return info;
}

/**
 * Extract internal links from HTML
 */
function extractLinks(html: string, baseUrl: string): string[] {
  const linkPattern = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  const links: string[] = [];
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    let href = match[1];

    // Skip anchors, javascript, mailto, tel, and external links
    if (href.startsWith('#') ||
        href.startsWith('javascript:') ||
        href.startsWith('mailto:') ||
        href.startsWith('tel:')) {
      continue;
    }

    // Convert relative URLs to absolute
    try {
      const absoluteUrl = new URL(href, baseUrl).href;
      const baseHost = new URL(baseUrl).host;
      const linkHost = new URL(absoluteUrl).host;

      // Only include same-domain links
      if (linkHost === baseHost) {
        links.push(absoluteUrl);
      }
    } catch {
      // Malformed href, skip
    }
  }

  return [...new Set(links)]; // Remove duplicates
}

/**
 * Check if URL should be excluded based on patterns
 */
function shouldExclude(url: string, excludePatterns: string[]): boolean {
  const lowerUrl = url.toLowerCase();
  return excludePatterns.some(pattern => lowerUrl.includes(pattern.toLowerCase()));
}

/**
 * Fetch a single page with SSRF-safe redirect handling.
 * Redirects are followed manually so each target is validated against the
 * internal-network blocklist.
 */
async function fetchPage(url: string, timeout: number, maxRedirects = 5): Promise<string | null> {
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    try {
      // DNS-resolving SSRF check before every fetch
      if (!(await isUrlAllowedAsync(currentUrl))) {
        console.warn(`Blocked fetch to disallowed URL (DNS check): ${currentUrl}`);
        return null;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          'User-Agent': 'Phondo-KnowledgeBase-Bot/1.0 (AI Receptionist Setup)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      clearTimeout(timeoutId);

      // Handle redirects manually — validate each target
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;

        const redirectUrl = new URL(location, currentUrl).href;
        if (!(await isUrlAllowedAsync(redirectUrl))) {
          console.warn(`Blocked redirect to disallowed URL: ${redirectUrl}`);
          return null;
        }
        currentUrl = redirectUrl;
        continue;
      }

      if (!response.ok) {
        return null;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('text/html')) {
        return null;
      }

      return await response.text();
    } catch (error) {
      console.error(`Error fetching ${currentUrl}:`, error);
      return null;
    }
  }

  console.warn(`Too many redirects for ${url}`);
  return null;
}

// ── LLM extraction helpers (exported for testing) ───────────────────────

export function stringField(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

export function stringArrayField(val: unknown): string[] | undefined {
  return Array.isArray(val) ? val.filter((item: unknown) => typeof item === 'string') : undefined;
}

/**
 * Check if a value is a placeholder string the LLM returns instead of omitting
 */
export function isPlaceholder(value: unknown): boolean {
  return typeof value === 'string' &&
    /^(not provided|not available|n\/a|none|unknown|null)$/i.test(value.trim());
}

/**
 * Extract a meaningful string from an LLM field, returning undefined for
 * placeholders, empty strings, and non-strings.
 */
export function cleanLLMField(value: unknown): string | undefined {
  const s = stringField(value);
  return s && s.trim() !== '' && !isPlaceholder(s) ? s : undefined;
}

/**
 * Filter placeholder strings from an LLM array field, returning undefined
 * if the array is empty after filtering.
 */
export function cleanLLMArrayField(value: unknown): string[] | undefined {
  const arr = stringArrayField(value)?.filter(item => !isPlaceholder(item));
  return arr && arr.length > 0 ? arr : undefined;
}

/**
 * Strip markdown code fences (```json ... ```) that the LLM sometimes
 * adds despite being told not to.
 */
export function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```\w*\s*\n?/, '').replace(/\n?```\s*$/, '');
}

/**
 * Validate an LLM-extracted phone by checking its digits appear in the
 * source text. Returns the phone string if valid, undefined otherwise.
 */
function validateLLMPhone(phone: unknown, sourceText: string): string | undefined {
  const value = cleanLLMField(phone);
  if (!value) return undefined;

  const digits = value.replace(/\D/g, '');
  if (digits.length >= 8 && sourceText.includes(digits)) {
    return value;
  }

  console.warn('[LLM Extract] Phone not found in source text, discarding:', value);
  return undefined;
}

// Re-export for server-side consumers (API routes, etc.)
export { buildCustomInstructionsFromBusinessInfo } from "./build-custom-instructions";

/**
 * Extract rich business info from scraped pages using Claude Haiku.
 * Falls back to empty object on any failure — including malformed LLM JSON
 * responses — so it is always safe to merge with regex results.
 */
export async function extractBusinessInfoWithLLM(
  pages: ScrapedPage[]
): Promise<ScrapedWebsite['businessInfo']> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[LLM Extract] ANTHROPIC_API_KEY not set, skipping LLM extraction');
    return {};
  }

  if (pages.length === 0) return {};

  // Concatenate page text, capping total at 8K chars (may truncate mid-page)
  const MAX_CHARS = 8000;
  let text = '';
  for (const page of pages) {
    const pageText = `--- ${page.title || page.url} ---\n${page.content}\n\n`;
    if (text.length + pageText.length > MAX_CHARS) {
      text += pageText.substring(0, MAX_CHARS - text.length);
      break;
    }
    text += pageText;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: `You are a business information extractor. Given website text, extract structured business details. Return ONLY a JSON object with these fields (all optional, omit if not found):
- "name": string — the business name
- "address": string — full street address
- "phone": string — primary phone number (include country/area code if visible)
- "email": string — primary contact email address (NOT image filenames or technical strings)
- "hours": string[] — business hours, e.g. ["Monday: 9am-5pm", "Tuesday: 9am-5pm"]
- "services": string[] — list of services offered (keep each concise, max 8 words)
- "about": string — 1-2 sentence summary of what the business does

Only include fields you are confident about. Return {} if no useful info is found. Output raw JSON only, no markdown fences.`,
        messages: [
          {
            role: 'user',
            content: text,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<unreadable>');
      console.error(`[LLM Extract] Anthropic API returned ${response.status}:`, errorBody.substring(0, 500));
      return {};
    }

    // Read response as text first, then parse — avoids losing context if body is non-JSON
    const responseText = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error('[LLM Extract] Anthropic returned non-JSON response body:', {
        contentType: response.headers.get('content-type'),
        bodyPreview: responseText.substring(0, 200),
      });
      return {};
    }

    const content = (data.content as Array<{ text?: string }>)?.[0]?.text;
    if (!content) {
      console.warn('[LLM Extract] Anthropic returned empty content', {
        stopReason: data.stop_reason,
      });
      return {};
    }

    const jsonStr = stripMarkdownFences(content);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.warn('[LLM Extract] Failed to parse LLM JSON output:', {
        error: parseError instanceof Error ? parseError.message : parseError,
        contentPreview: content.substring(0, 200),
      });
      return {};
    }

    return {
      name: cleanLLMField(parsed.name),
      address: cleanLLMField(parsed.address),
      phone: validateLLMPhone(parsed.phone, text),
      email: cleanLLMField(parsed.email),
      hours: cleanLLMArrayField(parsed.hours),
      services: cleanLLMArrayField(parsed.services),
      about: cleanLLMField(parsed.about),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.warn('[LLM Extract] Anthropic request timed out (12s)');
    } else {
      console.error('[LLM Extract] Unexpected error during extraction:', error);
    }
    return {};
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Main scrape function
 */
export async function scrapeWebsite(
  url: string,
  options: ScrapeOptions = {}
): Promise<ScrapedWebsite> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Normalize the base URL
  let baseUrl: string;
  try {
    const parsed = new URL(url);
    baseUrl = `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new Error('Invalid URL provided');
  }

  const visited = new Set<string>();
  const pages: ScrapedPage[] = [];
  const toVisit: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
  let businessInfo: ScrapedWebsite['businessInfo'] = {};

  while (toVisit.length > 0 && pages.length < (opts.maxPages || 20)) {
    const current = toVisit.shift();
    if (!current) break;

    const { url: currentUrl, depth } = current;

    // Skip if already visited or exceeds depth
    if (visited.has(currentUrl) || depth > (opts.maxDepth || 2)) {
      continue;
    }

    // Check exclusion patterns
    if (shouldExclude(currentUrl, opts.excludePatterns || [])) {
      continue;
    }

    visited.add(currentUrl);

    // SSRF protection: validate every URL before fetching (not just the initial one)
    // Uses async DNS-resolving check to prevent DNS rebinding attacks
    if (!(await isUrlAllowedAsync(currentUrl))) {
      continue;
    }

    // Fetch the page
    const html = await fetchPage(currentUrl, opts.timeout || 30000);
    if (!html) {
      continue;
    }

    // Extract content
    const title = extractTitle(html);
    const content = extractTextContent(html);
    const description = extractMetaDescription(html);

    // Skip very short pages (likely error pages or redirects)
    if (content.length < 100) {
      continue;
    }

    pages.push({
      url: currentUrl,
      title,
      content: content.substring(0, 10000), // Limit content length
      metadata: {
        description,
      },
    });

    // Extract phone/email from full text (including header/footer where
    // contact info typically lives) — not the stripped KB content
    const fullText = extractFullText(html);
    businessInfo = extractBusinessInfo(fullText, businessInfo);

    // Extract links for next level (if not at max depth)
    if (depth < (opts.maxDepth || 2)) {
      const links = extractLinks(html, baseUrl);
      for (const link of links) {
        if (!visited.has(link) && !toVisit.some(t => t.url === link)) {
          toVisit.push({ url: link, depth: depth + 1 });
        }
      }
    }

    // Small delay to be respectful to the server
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return {
    baseUrl,
    pages,
    businessInfo,
    scrapedAt: new Date(),
    totalPages: pages.length,
  };
}

/**
 * Generate knowledge base content from scraped website
 */
export function generateKnowledgeBase(scrapedData: ScrapedWebsite): string {
  const sections: string[] = [];

  // Business info section
  if (Object.keys(scrapedData.businessInfo).length > 0) {
    sections.push('## Business Information');
    const { name, phone, email, address, hours, services, about } = scrapedData.businessInfo;

    if (name) sections.push(`- Business Name: ${name}`);
    if (phone) sections.push(`- Phone: ${phone}`);
    if (email) sections.push(`- Email: ${email}`);
    if (address) sections.push(`- Address: ${address}`);
    if (hours && hours.length > 0) {
      sections.push(`- Business Hours:\n${hours.map(h => `  - ${h}`).join('\n')}`);
    }
    if (services && services.length > 0) {
      sections.push(`- Services:\n${services.map(s => `  - ${s}`).join('\n')}`);
    }
    if (about) sections.push(`\n### About\n${about}`);
    sections.push('');
  }

  // Page content sections
  sections.push('## Website Content');
  for (const page of scrapedData.pages) {
    sections.push(`\n### ${page.title || page.url}`);
    if (page.metadata?.description) {
      sections.push(`*${page.metadata.description}*`);
    }
    sections.push(page.content);
  }

  return sections.join('\n');
}
