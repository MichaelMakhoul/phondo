// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseAny = any;

interface KnowledgeBaseEntry {
  id: string;
  title: string | null;
  source_type: string;
  content: string;
  is_active: boolean;
}

/**
 * Fetches all active org-level KB entries and concatenates them into
 * a single string suitable for injection into a system prompt.
 */
export async function getAggregatedKnowledgeBase(
  supabase: SupabaseAny,
  organizationId: string
): Promise<string> {
  const { data: entries, error } = await (supabase as any)
    .from("knowledge_bases")
    .select("id, title, source_type, content, is_active")
    .eq("organization_id", organizationId)
    .is("assistant_id", null)
    .eq("is_active", true)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to fetch knowledge base entries:", error);
    throw new Error(`Failed to aggregate knowledge base: ${error.message}`);
  }

  if (!entries || entries.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const entry of entries as KnowledgeBaseEntry[]) {
    const heading = entry.title || entry.source_type;

    if (entry.source_type === "faq") {
      // Parse FAQ JSON content into Q&A pairs
      try {
        const pairs = JSON.parse(entry.content) as {
          question: string;
          answer: string;
        }[];
        const qaParts = pairs
          .map((p) => `Q: ${p.question}\nA: ${p.answer}`)
          .join("\n\n");
        sections.push(`## ${heading}\n${qaParts}`);
      } catch {
        // If JSON parse fails, use raw content
        sections.push(`## ${heading}\n${entry.content}`);
      }
    } else {
      // website, document, manual — plain text
      sections.push(`## ${heading}\n${entry.content}`);
    }
  }

  return sections.join("\n\n");
}

